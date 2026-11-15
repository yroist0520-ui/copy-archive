#!/usr/bin/env python3
"""模拟 GitHub Pages 的纯静态托管，用于验证无后端时的本地模式与子路径部署。

行为与 Pages 一致：
  · 只提供 public/ 目录下的静态文件
  · 未知路径返回 404.html（深链兜底）
  · /api/* 一律 404（因此前端会切换到本地模式）

子路径模拟：设置环境变量 CA_BASE_PATH=/copy-archive 后，站点挂载在该子路径下，
与 GitHub Pages 的 <user>.github.io/<repo>/ 部署形态一致。

用法：
  python3 scripts/serve_static.py 8080
  CA_BASE_PATH=/copy-archive python3 scripts/serve_static.py 8081
"""
import os
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "public"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
BASE_PATH = os.environ.get("CA_BASE_PATH", "").rstrip("/")


class PagesLikeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path):
        # 剥离子路径前缀，映射回 public/ 内的真实文件
        if BASE_PATH:
            if path == BASE_PATH:
                path = "/"
            elif path.startswith(BASE_PATH + "/"):
                path = path[len(BASE_PATH):]
        return super().translate_path(path)

    def _serve_not_found(self):
        page = ROOT / "404.html"
        if not page.is_file():
            self.send_error(404, "Not Found")
            return
        body = page.read_bytes()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            self.send_error(404, "Not Found")
            return
        stripped = path
        if BASE_PATH:
            if path == BASE_PATH:
                stripped = "/"
            elif path.startswith(BASE_PATH + "/"):
                stripped = path[len(BASE_PATH):]
            else:
                self._serve_not_found()
                return
        if stripped != "/" and not (ROOT / stripped.lstrip("/")).is_file():
            # 深链回退：返回 404.html，由其脚本恢复路由
            self._serve_not_found()
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        if "-v" in sys.argv:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    mount = BASE_PATH or "/"
    print(f"静态托管模拟已启动： http://127.0.0.1:{PORT}{mount}  (根目录 {ROOT})")
    with ThreadingHTTPServer(("", PORT), PagesLikeHandler) as httpd:
        httpd.serve_forever()
