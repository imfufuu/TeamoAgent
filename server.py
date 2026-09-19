#!/usr/bin/env python3
"""TeamoAgent 本地服务器：静态文件 + TeamoRouter API 流式代理（CORS 兜底通道）。

用法:  python3 server.py [port] [--port N] [--host ADDR]
       默认端口 8787，默认仅绑定 127.0.0.1（本机可用）。
       代理通道没有鉴权与限流，如需局域网访问请显式 --host 0.0.0.0，
       否则等于在共享网络里开一个免费中继。
代理:  ANY /api/proxy?path=/v1/chat/completions  →  https://api.teamorouter.com/v1/chat/completions
"""
import http.client
import http.server
import json
import os
import socketserver
import ssl
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
UPSTREAM_HOST = "api.teamorouter.com"
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


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # 精简日志
        sys.stderr.write("· %s\n" % (fmt % args))

    def _is_proxy(self):
        return self.path.split("?")[0] == "/api/proxy"

    def do_GET(self):
        if self._is_proxy():
            return self._proxy("GET")
        return super().do_GET()

    def do_POST(self):
        if self._is_proxy():
            return self._proxy("POST")
        self.send_error(405)

    def _proxy(self, method):
        qs = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(qs)
        path = (params.get("path") or ["/v1/models"])[0]
        if not path.startswith("/") or ".." in path:
            return self._json(400, {"error": "invalid path"})

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        headers = {k.lower(): v for k, v in self.headers.items() if k.lower() in ALLOW_HEADERS}
        headers["host"] = UPSTREAM_HOST

        ctx = ssl.create_default_context()
        try:
            conn = http.client.HTTPSConnection(UPSTREAM_HOST, timeout=TIMEOUT, context=ctx)
            conn.request(method, path, body=body, headers=headers)
            res = conn.getresponse()
        except Exception as exc:  # 上游不可达
            return self._json(502, {"error": f"upstream unreachable: {exc}"})

        self.send_response(res.status)
        ctype = res.getheader("Content-Type", "application/json")
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
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
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="监听地址（默认 127.0.0.1 仅本机；代理无鉴权，暴露到局域网请显式 --host 0.0.0.0）",
    )
    args = parser.parse_args()
    port = args.port or args.pos_port or 8787
    with Server((args.host, port), Handler) as httpd:
        print(f"◐ TeamoAgent serving on http://{args.host}:{port}  (proxy → https://{UPSTREAM_HOST})")
        httpd.serve_forever()
