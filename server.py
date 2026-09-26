#!/usr/bin/env python3
"""TeamoAgent 本地服务器：静态文件 + TeamoRouter API 流式代理 + 网络工具中继。

用法:  python3 server.py [port] [--port N] [--host ADDR] [--workspace DIR] [--allow-git|--no-git]
       默认端口 8787，默认仅绑定 127.0.0.1（本机可用）。
       代理通道没有鉴权与限流，如需局域网访问请显式 --host 0.0.0.0，
       否则等于在共享网络里开一个免费中继；非本机监听时 git 执行默认关闭。

端点:
  ANY  /api/proxy?path=/v1/chat/completions  →  https://api.teamorouter.com/v1/... （流式透传）
                                            第一个上游连不上时自动换 api.teamorouter.cn 重试
  GET  /api/health      →  能力探测（前端据此决定工具走中继还是降级）
  GET  /api/fetch?url=  →  抓取网页并抽取正文（mode=text|raw，禁止指向内网地址）
                        联网搜索不在这里：按用户要求，搜索只用模型 API 自带的请求格式
                       （js/websearch.js），本中继不接任何第三方搜索服务
  POST /api/git         →  在 ./workspace/ 里执行 git 子命令（白名单、不经 shell、禁交互凭据提示）
"""
import html as htmlmod
import http.client
import shutil
import ipaddress
import re
import shlex
import socket
import subprocess
import http.server
import json
import os
import socketserver
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
# 上游候选：第一个是文档默认域名，第二个（.cn）在中国大陆网络通常更稳。
# 逐个尝试，任一可用即透传；也可用环境变量 TEAMO_UPSTREAM 固定。
UPSTREAM_CANDIDATES = [h for h in [os.environ.get("TEAMO_UPSTREAM"), "api.teamorouter.com", "api.teamorouter.cn"] if h]
UPSTREAM_HOST = UPSTREAM_CANDIDATES[0]
WORKSPACE = os.environ.get("TEAMO_WORKSPACE") or os.path.join(ROOT, "workspace")
UA = "Mozilla/5.0 (X11; Linux x86_64) TeamoAgent-LocalRelay/1.0"
# git 执行开关：__main__ 里按 --allow-git/--no-git 与监听地址决定
GIT_ENABLED = True
FETCH_TIMEOUT = 25
MAX_FETCH_BYTES = 4_000_000

# git 子命令白名单：只放行「读 + 常规写」，凭据/服务端能力类一律拒绝
GIT_ALLOWED = {
    "init", "clone", "status", "log", "diff", "show", "ls-files", "ls-tree", "rev-parse",
    "branch", "switch", "checkout", "fetch", "pull", "add", "rm", "mv", "commit", "push",
    "tag", "remote", "stash", "merge", "rebase", "cherry-pick", "reset", "restore", "blame",
    "shortlog", "describe", "config",
}
# 这些参数能把 git 指到别处的仓库/模板/对象库，或改执行环境 —— 一律拒绝，
# 保证所有写操作都只发生在 workspace/ 目录里
GIT_DENIED_ARGS = {
    "-c", "-C", "--exec-path", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
    "--shallow-file", "--separate-git-dir", "--template", "--reference", "--reference-if-able",
    "--alternates", "--config", "-c ", "--output", "--upload-pack", "--repo", "--exec",
}
GIT_DENIED_SUBSTR = ("ext::", "filter-branch", "credential", "daemon", "serve", "fsck --")
ALLOW_HEADERS = {"authorization", "x-api-key", "anthropic-version", "content-type"}
TIMEOUT = 620  # TeamoRouter 官方最长支持 600s

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".md": "text/markdown; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
}


# ── 抓取/搜索/git 的支撑函数（模块级，便于单测与复用）───────────────────
def origin_allowed(origin, host):
    """浏览器跨站请求会带 Origin。只放行与 Host 一致的来源，挡住对本地中继的 CSRF。
    没有 Origin（curl / 单测）放行。"""
    origin = (origin or "").strip()
    host = (host or "").strip()
    if not origin:
        return True
    try:
        o = urllib.parse.urlparse(origin)
    except Exception:
        return False
    if o.scheme not in ("http", "https") or not o.netloc:
        return False
    return o.netloc.lower() == host.lower()


def validate_proxy_path(path):
    """代理只许打到网关 /v1/…，禁止任意路径或穿越。"""
    path = str(path or "")
    if ".." in path or "\\" in path or "\x00" in path:
        return False
    return bool(re.fullmatch(r"/v1/[A-Za-z0-9._~/-]*", path))


def guard_public_http_url(raw):
    """只允许公网 http(s)，挡掉 loopback/私网/链路本地（避免中继变成 SSR 跳板）。"""
    url = (raw or "").strip()
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError("只允许 http(s) 绝对地址")
    if len(url) > 2000:
        raise ValueError("URL 过长")
    try:
        infos = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise ValueError(f"域名解析失败：{exc}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
            or ip.is_multicast or ip.is_unspecified
        ):
            raise ValueError("目标解析到内网/保留地址，已拒绝（本中继只做公网抓取）")
    return url


class GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """每一跳重定向都重新过 SSRF 护栏。urllib 默认会跟着 302 走，
    只校验起始 URL 的话 `http://evil.example` → `http://169.254.169.254/` 就能打到元数据。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        guard_public_http_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def http_get_text(url, limit=MAX_FETCH_BYTES, timeout=FETCH_TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"})
    opener = urllib.request.build_opener(GuardedRedirectHandler)
    with opener.open(req, timeout=timeout) as res:  # noqa: S310 - 目标与每一跳重定向都经过 guard_public_http_url
        ctype = res.headers.get("Content-Type", "")
        data = res.read(limit + 1)
        return res.status, ctype, data[:limit].decode("utf-8", "replace")


_STRIP_RE = re.compile(r"<(script|style|noscript|svg|iframe)[^>]*>.*?</\1>", re.S | re.I)
_TAG_RE = re.compile(r"<[^>]+>")
_BLOCK_RE = re.compile(r"</?(p|div|li|h[1-6]|tr|blockquote|pre|br)\s*/?>", re.I)
_NUM = {"nbsp": "\u00a0", "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "mdash": "—", "ndash": "–", "hellip": "…", "middot": "·", "copy": "©", "reg": "®", "trade": "™", "laquo": "«", "raquo": "»", "times": "×"}


def _entity(m):
    name = m.group(1)
    if name in _NUM:
        return _NUM[name]
    if name.startswith("#"):
        try:
            return chr(int(name[1:], 16) if name[1:2] in "xX" else int(name[1:], 10))
        except ValueError:
            return m.group(0)
    return m.group(0)


def html_to_text(doc):
    """HTML → 纯文本：与前端 js/net.js 的 htmlToText 同思路（先剥样式脚本，再按块补换行）。"""
    s = _STRIP_RE.sub(" ", doc or "")
    s = re.sub(r"<!--[\s\S]*?-->", " ", s)
    s = _BLOCK_RE.sub("\n", s)
    s = _TAG_RE.sub(" ", s)
    s = htmlmod.unescape(s)
    s = re.sub(r"&(#x?[0-9a-fA-F]+|[a-zA-Z]+);", _entity, s)
    lines = [re.sub(r"[ \t\u00a0]+", " ", ln).strip() for ln in s.split("\n")]
    out, blank = [], False
    for ln in lines:
        if not ln:
            if not blank and out:
                blank = True
            continue
        if blank:
            out.append("")
            blank = False
        out.append(ln)
    return "\n".join(out).strip()


def html_title(doc):
    m = re.search(r"<title[^>]*>([\s\S]*?)</title>", doc or "", re.I)
    return html_to_text(m.group(1))[:160] if m else ""


GIT_CONFIG_KEYS = {"user.name", "user.email", "init.defaultbranch", "pull.rebase",
                   "commit.gpgsign", "advice.detachedhead", "advice.pushupdaterejected"}
GIT_CONFIG_FLAGS = {"--local", "--unset", "--unset-all", "--add", "--replace-all", "--bool"}


def validate_git_config_args(rest):
    """校验 `git config` 的参数；返回错误信息或 None。"""
    if not rest:
        return "config 需要参数（读：git config -l / --get <key>；写：git config user.email <值>）"
    if rest[0] in ("-l", "--list", "--get", "--get-all", "--get-regexp", "--get-urlmatch"):
        return None
    flags = [a for a in rest if a.startswith("-")]
    pos = [a for a in rest if not a.startswith("-")]
    bad = [f for f in flags if f not in GIT_CONFIG_FLAGS]
    if bad:
        return f"config 不允许参数 {bad[0]}（只能写本仓库配置，禁止 --global/--file/--edit 等）"
    if not pos:
        return "config 缺少配置项名"
    if pos[0].lower() not in GIT_CONFIG_KEYS:
        return f"config 项「{pos[0]}」不在允许列表内（可写：{', '.join(sorted(GIT_CONFIG_KEYS))}）"
    return None


def validate_git_remote_url(raw):
    """git clone/fetch/pull/push 的远程地址：只放行公网 http(s)，拒绝 ssh/file/内网。"""
    url = str(raw or "").strip()
    if url.startswith("http://") or url.startswith("https://"):
        try:
            guard_public_http_url(url)
        except ValueError as exc:
            return f"远程地址被拒绝：{exc}"
        return None
    if "://" in url or url.startswith("git@"):
        return f"只允许 http(s) 远程地址，已拒绝「{url[:80]}」"
    return None


def validate_git_argv(argv):
    if not argv or argv[0] != "git":
        return "只允许以 git 开头的命令"
    sub = argv[1] if len(argv) > 1 else ""
    if sub not in GIT_ALLOWED:
        return f"git 子命令「{sub or '(空)'}」不在白名单内（可用：{', '.join(sorted(GIT_ALLOWED))}）"
    if sub == "config":
        err = validate_git_config_args(argv[2:])
        if err:
            return err
    for a in argv[2:]:
        if a.split("=")[0] in GIT_DENIED_ARGS:
            return f"参数 {a} 被拒绝（不允许改动 git 目录/执行环境）"
        for bad in GIT_DENIED_SUBSTR:
            if bad in a:
                return f"参数里含有被禁止的片段「{bad}」"
        # clone/fetch/pull/push/remote 会带 URL：必须过 SSRF 护栏（README 写了，实现原先漏了）
        if sub in {"clone", "fetch", "pull", "push", "ls-remote", "remote"}:
            err = validate_git_remote_url(a)
            if err:
                return err
    return None


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        super().end_headers()

    def _assert_origin(self):
        if origin_allowed(self.headers.get("Origin") or "", self.headers.get("Host") or ""):
            return True
        self._json(403, {"error": "origin mismatch"})
        return False

    def log_message(self, fmt, *args):  # 精简日志
        sys.stderr.write("· %s\n" % (fmt % args))

    def _route(self):
        return self.path.split("?")[0]

    def _is_proxy(self):
        return self._route() == "/api/proxy"

    def do_GET(self):
        if self._is_proxy():
            return self._proxy("GET")
        if self._route().startswith("/api/"):
            return self._handle_api("GET")
        return super().do_GET()

    def do_POST(self):
        if self._is_proxy():
            return self._proxy("POST")
        if self._route().startswith("/api/"):
            return self._handle_api("POST")
        self.send_error(405)


    # ── 新增能力端点 ────────────────────────────────────────────────────
    def do_OPTIONS(self):  # 同源应用不需要预检；显式拒绝比让 SimpleHTTPRequestHandler 回 501 清楚
        self.send_error(405)

    def _handle_api(self, method):
        if not self._assert_origin():
            return
        route = self._route()
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if route == "/api/health":
            return self._json(200, {
                "ok": True, "service": "teamo-agent-local-relay",
                "fetch": True,
                "git": bool(GIT_ENABLED) and shutil.which("git") is not None,
                "workspace": WORKSPACE,
                "time": int(time.time()),
            })
        if route == "/api/fetch":
            return self._fetch(qs)
        if route == "/api/git":
            return self._git(method, qs)
        return self._json(404, {"error": f"unknown api route {route}"})

    def _fetch(self, qs):
        """抓一个公网 URL → 纯文本（或原始体）。

        只有 text / raw 两种模式：原先的 markdown 模式借用 r.jina.ai，那是第三方服务，
        按「联网只用模型 API 自带格式」的要求移除；正文抽取由前端/这里的 html_to_text 完成。
        （顺带：原来的 _search 端点也删了 —— 见 js/websearch.js 的说明。）
        """
        raw = (qs.get("url") or [""])[0]
        mode = (qs.get("mode") or ["text"])[0]
        if mode not in ("text", "raw"):
            mode = "text"
        try:
            limit = min(int((qs.get("max") or [str(MAX_FETCH_BYTES)])[0]), MAX_FETCH_BYTES)
        except ValueError:
            limit = MAX_FETCH_BYTES
        limit = max(2048, limit)
        try:
            url = guard_public_http_url(raw)
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        try:
            status, ctype, body = http_get_text(url, limit)
        except urllib.error.HTTPError as exc:
            return self._json(502, {"error": f"上游返回 HTTP {exc.code}", "url": url})
        except Exception as exc:  # DNS / 超时 / TLS
            return self._json(502, {"error": f"抓取失败：{type(exc).__name__}: {exc}", "url": url})
        truncated = len(body) >= limit
        text = body if mode == "raw" else html_to_text(body)
        return self._json(200, {
            "url": url, "status": status, "content_type": ctype,
            "title": html_title(body) if "html" in ctype.lower() else "",
            "text": text, "truncated": truncated, "limit": limit,
            "chars": len(text),
        })

    def _git(self, method, qs):
        if not GIT_ENABLED:
            return self._json(403, {"error": "git 执行已关闭（非本机监听需显式 --allow-git）"})
        if method != "POST":
            return self._json(405, {"error": "git 端点只接受 POST"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"error": "Content-Length 非法"})
        if n > 1_000_000:
            return self._json(413, {"error": "请求体过大"})
        try:
            payload = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
        except Exception as exc:
            return self._json(400, {"error": f"请求体不是合法 JSON：{exc}"})
        command = str(payload.get("command") or "").strip()
        if not command:
            return self._json(400, {"error": "缺少 command"})
        if re.search(r"[;&|`$<>\n\r]", command):
            return self._json(400, {"error": "命令里不允许 shell 元字符（; | & $ ` < > 换行）——本端点只执行单条 git 命令"})
        try:
            argv = shlex.split(command)
        except ValueError as exc:
            return self._json(400, {"error": f"参数解析失败：{exc}"})
        err = validate_git_argv(argv)
        if err:
            return self._json(400, {"error": err})
        # 工作区隔离：所有路径都在 WORKSPACE 下，repo 只允许一层安全名字
        cwd = WORKSPACE
        repo = str(payload.get("repo") or "").strip().strip("/")
        if repo:
            if not re.fullmatch(r"[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*", repo) or ".." in repo.split("/"):
                return self._json(400, {"error": "repo 只能是 workspace 下的相对目录名"})
            cwd = os.path.join(WORKSPACE, *repo.split("/"))
            if not os.path.isdir(cwd):
                return self._json(400, {"error": f"目录不存在：workspace/{repo}（先用 git clone 创建）"})
        try:
            timeout = min(max(int(payload.get("timeout") or 25), 1), 120)
        except ValueError:
            timeout = 25
        try:
            os.makedirs(WORKSPACE, exist_ok=True)
            # GIT_TERMINAL_PROMPT=0：绝不弹用户名/密码，否则子进程会挂住整个中继
            env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", str(ROOT)),
                   "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "echo", "LANG": "C.UTF-8",
                   "GIT_PAGER": "cat", "TERM": "dumb",
                   # 关键：禁止 git 往上找父目录里的 .git。没有这行，workspace 恰好放在某个
                   # 真实仓库里时，Agent 的 git status/add/commit 会直接命中那个仓库
                   #（实测会看到并改动宿主项目的 index 与 config —— 必须挡住）。
                   # 两层都列进去：git 只把 ceiling 用在「当前目录的祖先」上，
                   # 只写 WORKSPACE 时从 workspace 根执行 status 仍会往上命中宿主仓库
                   "GIT_CEILING_DIRECTORIES": os.pathsep.join(
                       [os.path.realpath(WORKSPACE), os.path.dirname(os.path.realpath(WORKSPACE))])}
            # 我们自己塞两个 git 参数（都在校验之后，用户无法借此夹带）：
            #   --no-pager 不挂在分页器上；-c init.defaultBranch=main 去掉 git init 的
            #   「Using 'master'…」长篇提示（否则每次 init 都白吃 ~400 字符上下文）
            proc = subprocess.run(["git", "--no-pager", "-c", "init.defaultBranch=main", *argv[1:]],
                                  cwd=cwd, env=env, timeout=timeout,
                                  capture_output=True, text=True, stdin=subprocess.DEVNULL)
        except FileNotFoundError:
            return self._json(500, {"error": "本机没有 git 可执行文件（PATH 里找不到 git）"})
        except subprocess.TimeoutExpired:
            return self._json(504, {"error": f"git 执行超过 {timeout}s，已终止"})
        except Exception as exc:
            return self._json(500, {"error": f"git 执行失败：{type(exc).__name__}: {exc}"})
        cap = 200_000
        out = (proc.stdout or "")[:cap]
        return self._json(200, {
            "code": proc.returncode, "cwd": cwd,
            "stdout": out, "stderr": (proc.stderr or "")[:cap // 2],
            "truncated": len(proc.stdout or "") >= cap,
            "note": "输出已截断" if len(proc.stdout or "") >= cap else "",
        })

    def _proxy(self, method):
        if not self._assert_origin():
            return
        qs = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(qs)
        path = (params.get("path") or ["/v1/models"])[0]
        if not validate_proxy_path(path):
            return self._json(400, {"error": "invalid path"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"error": "Content-Length 非法"})
        if length > 20_000_000:
            return self._json(413, {"error": "请求体过大"})
        body = self.rfile.read(length) if length else None

        headers = {k.lower(): v for k, v in self.headers.items() if k.lower() in ALLOW_HEADERS}
        headers["host"] = UPSTREAM_HOST

        ctx = ssl.create_default_context()
        res = None
        last_exc = None
        for cand in UPSTREAM_CANDIDATES:      # 双域名轮询：哪个通就用哪个
            headers["host"] = cand
            try:
                conn = http.client.HTTPSConnection(cand, timeout=TIMEOUT, context=ctx)
                conn.request(method, path, body=body, headers=headers)
                res = conn.getresponse()
                break
            except Exception as exc:  # 该域名不可达，试下一个
                last_exc = exc
                continue
        if res is None:
            return self._json(502, {"error": f"upstream unreachable: {last_exc}"})

        self.send_response(res.status)
        ctype = res.getheader("Content-Type", "application/json")
        self.send_header("Content-Type", ctype)
        self.end_headers()

        try:
            while True:
                chunk = res.read1(65536) if hasattr(res, "read1") else res.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()  # SSE 逐块透传
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            conn.close()

    def _json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="TeamoAgent 本地服务器（静态文件 + TeamoRouter API 流式代理）")
    parser.add_argument("pos_port", nargs="?", type=int, default=None, help="端口（默认 8787）")
    parser.add_argument("--port", type=int, default=None, help="端口（优先于位置参数）")
    parser.add_argument("--workspace", default=None, help="网络工具与 git 的工作目录（默认 <服务器所在目录>/workspace）")
    parser.add_argument("--allow-git", action="store_true", help="即使监听非本机地址也允许 /api/git 执行 git 命令")
    parser.add_argument("--no-git", action="store_true", help="彻底关闭 /api/git（只留静态与代理）")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="监听地址（默认 127.0.0.1 仅本机；代理无鉴权，暴露到局域网请显式 --host 0.0.0.0）",
    )
    args = parser.parse_args()
    port = args.port or args.pos_port or 8787
    if args.workspace:
        WORKSPACE = os.path.abspath(args.workspace)
    loopback = args.host in ("127.0.0.1", "localhost", "::1")
    GIT_ENABLED = not args.no_git and (loopback or args.allow_git)
    os.makedirs(WORKSPACE, exist_ok=True)
    print(
        f"◐ TeamoAgent serving on http://{args.host}:{port}  (proxy → https://{UPSTREAM_HOST})\n"
        f"  工作区 {WORKSPACE} · /api/fetch on · /api/git {'on' if GIT_ENABLED else 'off'}\n"
        "  联网搜索走模型 API 自带格式（本中继不提供 /api/search）"
    )
    if not loopback and not args.allow_git and not args.no_git:
        print("  ⚠ 非本机监听：/api/git 已自动关闭（要开请加 --allow-git）")
    with Server((args.host, port), Handler) as httpd:
        httpd.serve_forever()
