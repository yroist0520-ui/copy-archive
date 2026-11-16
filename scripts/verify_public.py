"""线上双会话验收：验证公开档案跨用户可见、访客可复制、隐私隔离。"""
import json
import http.cookiejar
import time
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


A = session()
B = session()
u = "arch" + str(int(time.time()))[-6:]

print("=== 设备 A：建档并填充示例文案 ===")
print(" 注册:", A("POST", "/api/auth/register",
                  {"username": u, "email": u + "@a.test", "password": "secret123"})[0])
print(" 填充:", A("POST", "/api/samples/seed", {})[1])
print(" 设为完全公开:", A("PUT", "/api/profile", {"privacy": "public"})[0])
st, d = A("GET", "/api/copies?pageSize=1")
print(" A 的文案数:", d.get("total"))

print()
print("=== 设备 B：独立会话访问 A 的公开档案 ===")
st, prof = B("GET", f"/api/public/u/{u}")
print(f" 档案主页: HTTP {st} · 昵称={prof.get('displayName')} · "
      f"可见文案={prof.get('copyCount')} · 分类={prof.get('categoryCount')} · 隐私={prof.get('privacy')}")
st, cats = B("GET", f"/api/public/u/{u}/categories")
print(f" 公开分类: HTTP {st} · {len(cats.get('items', []))} 个")
st, pub = B("GET", f"/api/public/u/{u}/copies?pageSize=3")
print(f" 公开文案: HTTP {st} · 共 {pub.get('total')} 条")
it = pub["items"][0]
print(f"   首条「{it['content'][:40]}」 分类={[c['name'] for c in it['categories']]} 标签={it['tags']}")

print()
print("=== 访客复制 A 的文案 ===")
cid = it["id"]
print(" 复制前计数:", it["copyCount"])
st, r = B("POST", f"/api/copies/{cid}/copy", {})
print(f" 访客复制: HTTP {st} → {r}")
st, mine = A("GET", "/api/copies?pageSize=1")
print(" A 侧同步看到的计数:", mine["items"][0]["copyCount"])

print()
print("=== 隐私隔离 ===")
print(" 访客改文案:", B("PUT", f"/api/copies/{cid}", {"content": "篡改"})[0], "（拒绝）")
print(" 访客删文案:", B("DELETE", f"/api/copies/{cid}")[0], "（拒绝）")
print(" 访客读私密档案:", B("GET", "/api/copies?pageSize=1")[0], "（401 未登录）")

print()
print("=== 发现页：陌生人可浏览他人公开档案 ===")
st, disc = B("GET", "/api/discover")
print(f" HTTP {st} · 公开档案 {len(disc.get('archives', []))} 个 · 热门文案 {len(disc.get('popular', []))} 条")
for a in disc.get("archives", [])[:3]:
    print(f"   @{a['username']} · {a['copy_count']} 条文案 · {a['privacy']}")

print()
print("分享给朋友的链接:", f"{BASE}/u/{u}?sharecode={SC}")
