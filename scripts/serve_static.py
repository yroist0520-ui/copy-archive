#!/usr/bin/env python3
"""模拟 GitHub Pages 的纯静态托管，用于验证无后端时的本地模式。

行为与 Pages 一致：
  · 只提供 public/ 目录下的静态文件
  · 未知路径返回 404.html（深链兜底）
  · /api/* 一律 404（因此前端会切换到本地模式）

用法：python3 scripts/serve_static.py [端口]
"""
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "public"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class PagesLikeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            self.send_error(404, "Not Found")
            return
        target = (ROOT / path.lstrip("/")).resolve()
        if path != "/" and (not target.is_file() or ROOT not in target.parents):
            # 深链回退：返回 404.html，由其脚本恢复路由
            page = ROOT / "404.html"
            if page.is_file():
                body = page.read_bytes()
                self.send_response(404)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        super().do_GET()

    def log_message(self, fmt, *args):
        if __debug__ and "-v" in sys.argv:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    print(f"静态托管模拟已启动： http://127.0.0.1:{PORT}  (根目录 {ROOT})")
    with ThreadingHTTPServer(("", PORT), PagesLikeHandler) as httpd:
        httpd.serve_forever()
