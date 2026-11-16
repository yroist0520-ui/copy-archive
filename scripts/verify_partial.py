#!/usr/bin/env python3
"""线上验证三档隐私语义：partial 只公开勾选分类的文案。"""
import json
import http.cookiejar
import secrets
import string
import urllib.error
import urllib.request

BASE = "https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host"
SC = "HC3YZORW3G"


def session():
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def call(method, path, body=None):
        url = BASE + path + (f"&sharecode={SC}" if "?" in path else f"?sharecode={SC}")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("X-Requested-With", "XMLHttpRequest")
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with op.open(req, timeout=30) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode())
            except Exception:
                return e.code, {}

    return call


def check(name, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + name + (f" — {detail}" if not ok and detail else ""))
    return ok


SUFFIX = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(6))
user = "par" + SUFFIX
A = session()      # 档案主
G = session()      # 访客
results = True

# 1. 注册 + 2 条文案（各属一个分类）
st, r = A("POST", "/api/auth/register", {"username": user, "email": user + "@t.dev", "password": "secret123", "displayName": "部分公开测试"})
results &= check("注册", st == 200, str(st))
st, cats = A("GET", "/api/categories")
results &= check("默认分类就绪", st == 200 and len(cats["items"]) >= 20, str(len(cats["items"])))
c1, c2 = cats["items"][0]["id"], cats["items"][1]["id"]
st, e1 = A("POST", "/api/copies", {"content": "PARTIAL-TEST 公开这条 " + SUFFIX, "categoryIds": [c1]})
st2, e2 = A("POST", "/api/copies", {"content": "PARTIAL-TEST 私密这条 " + SUFFIX, "categoryIds": [c2]})
results &= check("上传 2 条", st == 201 and st2 == 201 and e1["id"] != e2["id"], f"{st}/{st2}")

# 2. 完全公开基线
A("PUT", "/api/profile", {"privacy": "public"})
st, pub = G("GET", "/api/public/u/" + user)
results &= check("完全公开：访客可见 2 条", st == 200 and pub["copyCount"] == 2, str(pub))

# 3. 部分公开：只公开分类 1
st, _ = A("PUT", "/api/profile", {"privacy": "partial", "publicCategoryIds": [c1]})
results &= check("设置部分公开", st == 200, str(st))
st, pub = G("GET", "/api/public/u/" + user)
results &= check("部分公开：访客只可见 1 条", st == 200 and pub["copyCount"] == 1 and pub["privacy"] == "partial", str(pub))
st, pc = G("GET", "/api/public/u/" + user + "/categories")
results &= check("部分公开：只暴露 1 个分类", len(pc["items"]) == 1 and pc["items"][0]["id"] == c1, str(pc))
st, pl = G("GET", "/api/public/u/" + user + "/copies")
ids = [i["id"] for i in pl["items"]]
results &= check("部分公开：列表只含公开文案", ids == [e1["id"]], str(ids))
st, _ = G("GET", "/api/public/copies/" + str(e2["id"]))
results &= check("部分公开：私密文案详情不可读", st == 404, str(st))
st, _ = G("GET", "/api/public/copies/" + str(e1["id"]))
results &= check("部分公开：公开文案详情可读", st == 200, str(st))

# 4. 仅自己可见
A("PUT", "/api/profile", {"privacy": "private"})
st, _ = G("GET", "/api/public/u/" + user)
results &= check("仅自己可见：档案 404", st == 404, str(st))

print("\n" + ("全部通过" if results else "存在失败") + f" — 测试用户 @{user}")
raise SystemExit(0 if results else 1)
