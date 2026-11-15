#!/usr/bin/env python3
"""通过 GitHub REST API 推送文件（当 git 传输端点不可用时的备用通道）。

用法：
  python3 scripts/push_via_api.py main
  python3 scripts/push_via_api.py gh-pages

main      —— 推送相对上次已同步版本发生变化的文件
gh-pages  —— 推送 public/ 目录下的全部文件（Pages 部署产物）
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

OWNER = "yroist0520-ui"
REPO = "copy-archive"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = os.environ.get("GH_TOKEN", "").strip()


def request(method, url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "copy-archive-deploy")
    if data:
        req.add_header("Content-Type", "application/json")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                return resp.status, json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode()
            if exc.code in (409, 502, 503) and attempt < 3:
                time.sleep(2 + attempt * 2)
                continue
            return exc.code, {"message": body}
        except Exception:
            if attempt < 3:
                time.sleep(2 + attempt * 2)
                continue
            raise
    return 0, {}


def sha_of(branch, path):
    status, data = request("GET", f"{API}/contents/{path}?ref={branch}")
    return data.get("sha") if status == 200 else None


def put_file(branch, path, local_path, message):
    with open(local_path, "rb") as fh:
        content = base64.b64encode(fh.read()).decode()
    payload = {
        "message": message,
        "content": content,
        "branch": branch,
    }
    existing = sha_of(branch, path)
    if existing:
        payload["sha"] = existing
    status, data = request("PUT", f"{API}/contents/{path}", payload)
    return status, data


def git_changed_files():
    """相对远端 main 有变更的文件列表。"""
    out = subprocess.run(
        ["git", "-C", ROOT, "diff", "--name-status", "origin/main", "HEAD"],
        capture_output=True, text=True,
    ).stdout.strip()
    files = []
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        code = parts[0]
        for path in parts[1:]:
            if code.startswith("D"):
                continue
            files.append(path)
    return files


def main():
    branch = sys.argv[1] if len(sys.argv) > 1 else "main"
    explicit = sys.argv[2] if len(sys.argv) > 2 else ""
    if not TOKEN:
        print("需要环境变量 GH_TOKEN")
        return 1

    if branch == "gh-pages" and not explicit:
        targets = []
        public = os.path.join(ROOT, "public")
        for base, _, names in os.walk(public):
            for name in names:
                if name == ".DS_Store":
                    continue
                full = os.path.join(base, name)
                rel = os.path.relpath(full, public)
                targets.append(rel)
    elif explicit:
        # 显式指定文件，逗号分隔（走 API 推送后本地 origin/main 引用不会同步）
        targets = [p.strip() for p in explicit.split(",") if p.strip()]
    else:
        targets = git_changed_files()

    if not targets:
        print(f"{branch}: 没有需要推送的文件")
        return 0

    print(f"{branch}: 待推送 {len(targets)} 个文件")
    failed = []
    for rel in targets:
        if branch == "gh-pages":
            local = os.path.join(ROOT, "public", rel)
            remote = rel
        else:
            local = os.path.join(ROOT, rel)
            remote = rel
        if not os.path.isfile(local):
            continue
        status, data = put_file(branch, remote, local, f"Update {remote}")
        if status in (200, 201):
            print(f"  OK   {remote}")
        else:
            print(f"  FAIL {remote} → {status} {str(data.get('message'))[:120]}")
            failed.append(rel)

    if failed:
        print(f"失败 {len(failed)} 个文件")
        return 1
    print("全部推送成功")
    return 0


if __name__ == "__main__":
    sys.exit(main())
