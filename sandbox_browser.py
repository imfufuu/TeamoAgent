"""Local sandbox HTML/CSS/JS service + persistent Chromium controller.
No public URL input, shell command, host filesystem import, or cloud screenshot API.
"""
import base64
import binascii
import json
import mimetypes
import os
import pathlib
import queue
import re
import secrets
import shutil
import subprocess
import threading
import time
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent
MAX_PROJECT_BYTES = 8 * 1024 * 1024
MAX_PROJECT_FILES = 512
MAX_SESSIONS = 3
SESSION_IDLE_SECONDS = 30 * 60
ID_RE = re.compile(r"^[a-f0-9]{32}$")


def safe_project_path(value):
    s = str(value or "")
    if not s or len(s) > 512 or s.startswith("/") or "\\" in s or re.search(r"[\x00-\x1f\x7f]", s):
        raise ValueError("项目路径必须是合法的沙箱相对路径")
    parts = s.split("/")
    if any(x in ("", ".", "..", "__proto__", "constructor", "prototype") or x.startswith(".") for x in parts):
        raise ValueError("拒绝路径穿越、隐藏文件和受保护路径")
    if parts[0] in ("internal", "node_modules"):
        raise ValueError("不能导入内部目录")
    return s


def project_files(files, entry):
    if not isinstance(files, dict) or not files or len(files) > MAX_PROJECT_FILES:
        raise ValueError("项目需要 1–512 个文件")
    entry = safe_project_path(entry)
    if not entry.lower().endswith((".html", ".htm")):
        raise ValueError("入口必须是沙箱 HTML 文件；此服务运行静态/已构建网页，不执行 npm 或后端命令")
    out, total = {}, 0
    for path, content in files.items():
        path = safe_project_path(path)
        if not isinstance(content, str):
            raise ValueError("文件内容必须是文本或 base64 data URL")
        if content.startswith("data:"):
            header, sep, payload = content.partition(",")
            if not sep or ";base64" not in header:
                raise ValueError("二进制资源必须使用 base64 data URL")
            try:
                data = base64.b64decode(payload, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError("无效的资源 base64") from exc
        else:
            data = content.encode("utf-8")
        total += len(data)
        if total > MAX_PROJECT_BYTES:
            raise ValueError("项目超过 8MB 上限")
        out[path] = data
    if entry not in out:
        raise ValueError("入口文件不存在")
    return out, entry


class SandboxBrowser:
    def __init__(self):
        self.sessions = {}
        self.files_lock = threading.RLock()
        self.rpc_lock = threading.Lock()
        self.process = None
        self.events = queue.Queue()
        self.probe_lock = threading.Lock()
        self.probe_at = 0
        self.probe_result = None

    def health(self, enabled=True):
        with self.probe_lock:
            info = self._health(enabled)
        return {**info, "active_sessions": len(self.sessions)}

    def _health(self, enabled=True):
        if not enabled:
            return {"ok": False, "local": True, "error": "非本机监听默认关闭浏览器能力；可信环境可显式 --allow-browser"}
        if self.probe_result is not None and time.monotonic() - self.probe_at < 30:
            return self.probe_result
        try:
            proc = subprocess.run([shutil.which("node") or "node", str(ROOT / "tools/sandbox-browser.mjs"), "--probe"],
                                  capture_output=True, text=True, timeout=10, cwd=ROOT)
            info = json.loads(proc.stdout.strip().splitlines()[-1])
            info.update({"local": True, "kind": "sandbox-project-browser", "actions": ["start", "inspect", "screenshot", "click", "fill", "evaluate", "reload", "stop"]})
        except (OSError, ValueError, subprocess.TimeoutExpired, IndexError) as exc:
            info = {"ok": False, "local": True, "error": "本地 Chromium 运行环境不可用：" + str(exc)[:300]}
        self.probe_at, self.probe_result = time.monotonic(), info
        return info

    def _engine(self):
        if self.process is not None and self.process.poll() is None:
            return
        self.events = queue.Queue()
        self.process = subprocess.Popen([shutil.which("node") or "node", str(ROOT / "tools/sandbox-browser.mjs")],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, bufsize=1, cwd=ROOT)
        proc, events = self.process, self.events
        def read():
            for line in proc.stdout:
                try:
                    events.put(json.loads(line))
                except ValueError:
                    continue
            events.put({"engine_exit": True})
        threading.Thread(target=read, daemon=True).start()

    def _rpc(self, job, on_event=None):
        with self.rpc_lock:
            self._engine()
            request = secrets.token_hex(8)
            self.process.stdin.write(json.dumps({**job, "requestId": request}, ensure_ascii=False) + "\n")
            self.process.stdin.flush()
            disconnected = False
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                try:
                    value = self.events.get(timeout=max(0.1, deadline - time.monotonic()))
                except queue.Empty:
                    break
                if value.get("engine_exit"):
                    raise RuntimeError("Chromium 控制器已退出；请重新启动沙箱页面")
                if value.get("requestId") != request:
                    continue
                if value.get("type") == "event":
                    if on_event:
                        try:
                            on_event(value.get("payload") or {})
                        except (BrokenPipeError, ConnectionResetError):
                            on_event = None
                            disconnected = True
                elif value.get("type") == "result":
                    result = value.get("result") or {"ok": False, "error": "浏览器没有返回结果"}
                    if disconnected:
                        result["_client_disconnected"] = True
                    return result
            self.close()
            raise RuntimeError("本地浏览器操作超过 60 秒，控制器已终止")

    def _expire(self):
        now = time.monotonic()
        with self.files_lock:
            stale = [k for k, v in self.sessions.items() if now - v.get("touched", v["created"]) > SESSION_IDLE_SECONDS]
        for preview_id in stale:
            try:
                self._rpc({"action": "stop", "preview_id": preview_id})
            finally:
                with self.files_lock:
                    self.sessions.pop(preview_id, None)

    def start(self, payload, port, on_event=None):
        if any(k in payload for k in ("url", "base", "command", "host", "port")):
            raise ValueError("只接受沙箱文件与入口，不接受 URL、主机、端口或 shell 命令")
        files, entry = project_files(payload.get("files"), payload.get("entry"))
        self._expire()
        with self.files_lock:
            if len(self.sessions) >= MAX_SESSIONS:
                raise ValueError("最多同时运行 3 个沙箱页面；请先 stop 一个")
            preview_id = secrets.token_hex(16)
            self.sessions[preview_id] = {"files": files, "entry": entry, "created": time.monotonic()}
        base = f"http://127.0.0.1:{int(port)}/sandbox-web/{preview_id}/"
        try:
            result = self._rpc({"action": "start", "preview_id": preview_id, "base": base, "entry": entry,
                                "width": payload.get("width", 1280), "height": payload.get("height", 800)}, on_event)
            if result.pop("_client_disconnected", False):
                self._rpc({"action": "stop", "preview_id": preview_id})
                with self.files_lock:
                    self.sessions.pop(preview_id, None)
                raise BrokenPipeError("启动请求已取消；Chromium 会话已释放")
            if not result.get("ok"):
                with self.files_lock:
                    self.sessions.pop(preview_id, None)
            result["preview_path"] = f"/sandbox-web/{preview_id}/{urllib.parse.quote(entry, safe='/')}"
            return result
        except Exception:
            with self.files_lock:
                self.sessions.pop(preview_id, None)
            raise

    def command(self, payload, on_event=None):
        action, preview_id = payload.get("action"), str(payload.get("preview_id") or "")
        if any(k in payload for k in ("url", "base", "command", "host", "port")):
            raise ValueError("浏览器仅可调试已启动的沙箱项目，不接受 URL 或 shell 命令")
        if action not in ("inspect", "screenshot", "click", "fill", "evaluate", "reload", "stop") or not ID_RE.fullmatch(preview_id):
            raise ValueError("无效的浏览器操作或预览 ID")
        self._expire()
        with self.files_lock:
            if preview_id not in self.sessions:
                raise ValueError("沙箱服务不存在或已停止")
            self.sessions[preview_id]["touched"] = time.monotonic()
        if action == "reload" and "files" in payload:
            files, entry = project_files(payload.get("files"), payload.get("entry"))
            with self.files_lock:
                if entry != self.sessions[preview_id]["entry"]:
                    raise ValueError("reload 必须保持相同入口；新入口请重新 start")
                self.sessions[preview_id]["files"] = files
        if action in ("click", "fill") and not str(payload.get("selector") or ""):
            raise ValueError("此操作需要 selector")
        if action == "evaluate" and not str(payload.get("expression") or ""):
            raise ValueError("evaluate 需要浏览器内的 expression")
        for key, limit in (("selector", 2000), ("expression", 8000), ("text", 20000)):
            if key in payload and (not isinstance(payload[key], str) or len(payload[key]) > limit):
                raise ValueError(f"{key} 必须是文本且长度不超过 {limit}")
        job = {k: payload[k] for k in ("action", "preview_id", "selector", "text", "expression", "wait_ms", "width", "height", "full_page") if k in payload}
        result = self._rpc(job, on_event)
        result.pop("_client_disconnected", None)
        if action == "stop":
            with self.files_lock:
                self.sessions.pop(preview_id, None)
        return result

    def asset(self, route):
        match = re.fullmatch(r"/sandbox-web/([a-f0-9]{32})/(.*)", route)
        if not match:
            raise ValueError("无效的沙箱资源路径")
        preview_id, raw = match.groups()
        path = safe_project_path(urllib.parse.unquote(raw) or "index.html")
        with self.files_lock:
            session = self.sessions.get(preview_id)
            if not session or path not in session["files"]:
                return None
            data = session["files"][path]
        content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if path.lower().endswith((".js", ".mjs")):
            content_type = "text/javascript"
        return data, content_type, preview_id

    def close(self):
        proc, self.process = self.process, None
        if proc and proc.poll() is None:
            try:
                proc.stdin.close()  # controller gracefully closes Chromium on EOF
                proc.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
        with self.files_lock:
            self.sessions.clear()
