#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""COPY ARCHIVE 后端集成测试：覆盖账号隔离、多分类、批量导入、搜索、复制、收藏、分享权限。"""

import http.cookiejar
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8765"
results = []


def make_client():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(client, method, path, data=None, expect=None):
    url = BASE + path
    body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("X-Requested-With", "XMLHttpRequest")
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with client.open(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            status = resp.status
    except urllib.error.HTTPError as exc:
        payload = json.loads(exc.read().decode("utf-8"))
        status = exc.code
    if expect is not None and status != expect:
        raise AssertionError(f"{method} {path} expected {expect}, got {status}: {payload}")
    return status, payload


def check(name, condition, detail=""):
    results.append((name, bool(condition), detail))
    print(("  PASS  " if condition else "  FAIL  ") + name + ((" — " + detail) if detail and not condition else ""))


def main():
    a = make_client()
    b = make_client()
    suffix = str(int(__import__("time").time()))[-6:]
    ua, ub = "testa" + suffix, "testb" + suffix

    # 1. 账号系统
    _, ra = call(a, "POST", "/api/auth/register", {"username": ua, "email": ua + "@test.dev", "password": "secret123", "displayName": "档案甲"}, 200)
    _, rb = call(b, "POST", "/api/auth/register", {"username": ub, "email": ub + "@test.dev", "password": "secret123", "displayName": "档案乙"}, 200)
    check("两个账号注册成功", ra["user"]["id"] != rb["user"]["id"])
    _, me = call(a, "GET", "/api/auth/me", expect=200)
    check("会话保持", me["user"]["username"] == ua)

    # 2. 默认分类与自定义分类
    _, cats = call(a, "GET", "/api/categories", expect=200)
    check("首次注册自动生成 30 个默认分类", len(cats["items"]) == 30, str(len(cats["items"])))
    _, newcat = call(a, "POST", "/api/categories", {"name": "我的私藏", "color": "#a33a2b"}, 201)
    _, cats2 = call(a, "GET", "/api/categories", expect=200)
    check("新建自定义分类成功", len(cats2["items"]) == 31)
    ins = next(c for c in cats2["items"] if c["name"] == "INS")
    korean = next(c for c in cats2["items"] if c["name"] == "韩系")
    short = next(c for c in cats2["items"] if c["name"] == "短句")
    english = next(c for c in cats2["items"] if c["name"] == "英文排版")

    # 3. 多分类关联（不产生重复数据）
    text = "Somewhere between dreams and reality."
    _, copy = call(a, "POST", "/api/copies", {
        "title": "Dreams", "content": text, "note": "测试备注", "tags": ["dream", "梦境"],
        "categoryIds": [ins["id"], korean["id"], short["id"], english["id"], ins["id"]],
    }, 201)
    cid = copy["id"]
    check("一条文案可关联多个分类且自动去重", len(copy["categories"]) == 4, str([c["name"] for c in copy["categories"]]))
    call(a, "PATCH", f"/api/categories/{korean['id']}", {"name": "韩系改"}, 200)
    _, copy_after = call(a, "GET", f"/api/copies/{cid}", expect=200)
    check("修改分类名称后关联同步", any(c["name"] == "韩系改" for c in copy_after["categories"]))
    call(a, "PATCH", f"/api/categories/{korean['id']}", {"name": "韩系"}, 200)

    # 4. 批量导入完整保留原文
    lines = ["Dream without limits.", "Stay  strange.  ", "Lost in another world.", "你好，世界！「特殊」✦ 🎐", "a\nb"]
    _, dup = call(a, "POST", "/api/copies/check-duplicates", {"contents": lines + [text]}, 200)
    check("完全重复检测", text in dup["existing"])
    _, batch = call(a, "POST", "/api/copies/batch", {
        "items": [{"content": x} for x in lines], "categoryIds": [short["id"]],
    }, 201)
    check("批量导入 5 条", batch["count"] == 5)
    contents = [x["content"] for x in batch["items"]]
    check("原文空格/标点/Unicode/换行无损", contents == lines, repr(contents))

    # 5. 搜索：正文、标题、分类、标签、多关键词
    _, s1 = call(a, "GET", "/api/copies?q=Dreams", expect=200)
    check("按标题搜索", s1["total"] >= 1)
    _, s2 = call(a, "GET", "/api/copies?q=" + urllib.parse.quote("韩系"), expect=200)
    check("按分类名搜索（跨多分类）", any(x["id"] == cid for x in s2["items"]), str(s2["total"]))
    _, s3 = call(a, "GET", "/api/copies?q=dream", expect=200)
    check("按正文模糊搜索", s3["total"] >= 1)
    _, s4 = call(a, "GET", "/api/copies?q=%E6%A2%A6%E5%A2%83", expect=200)
    check("按标签搜索（中文）", any(x["id"] == cid for x in s4["items"]))
    _, s5 = call(a, "GET", "/api/copies?q=Dreams%20reality", expect=200)
    check("多关键词组合搜索", s5["total"] >= 1)
    _, s6 = call(a, "GET", f"/api/copies?category={ins['id']},{short['id']}", expect=200)
    check("多分类筛选", any(x["id"] == cid for x in s6["items"]))

    # 6. 复制计数与收藏
    before = copy["copyCount"]
    _, cp = call(a, "POST", f"/api/copies/{cid}/copy", {}, 200)
    check("复制只增加计数", cp["copyCount"] == before + 1)
    call(a, "POST", f"/api/copies/{cid}/favorite", {"value": True}, 200)
    _, favs = call(a, "GET", "/api/copies?favorite=1", expect=200)
    check("收藏筛选", any(x["id"] == cid for x in favs["items"]))
    call(a, "POST", f"/api/copies/{cid}/favorite", {"value": False}, 200)
    _, favs2 = call(a, "GET", "/api/copies?favorite=1", expect=200)
    check("取消收藏不影响原文案", not any(x["id"] == cid for x in favs2["items"]))
    _, still = call(a, "GET", f"/api/copies/{cid}", expect=200)
    check("取消收藏后文案仍在", still["content"] == text)

    # 7. 公开档案与隐私
    _, pub = call(a, "GET", f"/api/public/u/{ua}", expect=200)
    check("公开档案可匿名访问", pub["username"] == ua)
    _, anon_copies = call(b, "GET", f"/api/copies?owner={ua}", expect=200)
    check("他人可浏览公开文案", any(x["id"] == cid for x in anon_copies["items"]))

    _, pd = call(b, "GET", f"/api/public/copies/{cid}", expect=200)
    check("公开文案详情访客可读", pd["content"] == text)

    call(a, "PUT", "/api/profile", {"privacy": "private"}, 200)
    call(a, "GET", f"/api/public/u/{ua}", expect=404)
    call(b, "GET", f"/api/public/copies/{cid}", expect=404)
    check("完全私密档案及文案拒绝访问", True)

    call(a, "PUT", "/api/profile", {"privacy": "partial", "publicCategoryIds": [ins["id"]]}, 200)
    _, partial = call(b, "GET", f"/api/copies?owner={ua}", expect=200)
    check("部分公开只返回选中分类文案", any(x["id"] == cid for x in partial["items"]))
    check("部分公开隐藏未选分类文案", not any(x["content"] == "Dream without limits." for x in partial["items"]))
    _, hidden = call(b, "POST", f"/api/copies/{cid}/copy", {}, 200)
    check("部分公开文案可被访客复制", hidden["ok"])
    other_id = batch["items"][0]["id"]
    status, _ = call(b, "POST", f"/api/copies/{other_id}/copy", {}, expect=404)
    check("未公开文案拒绝访客访问", status == 404)

    # 8. 越权防护
    call(a, "PUT", "/api/profile", {"privacy": "public"}, 200)
    status, _ = call(b, "GET", f"/api/copies/{cid}", expect=404)
    check("跨账号读取文案被拒绝", status == 404)
    status, _ = call(b, "PATCH", f"/api/copies/{cid}", {"content": "hacked"}, expect=404)
    check("跨账号修改文案被拒绝", status == 404)
    status, _ = call(b, "DELETE", f"/api/copies/{cid}", expect=404)
    check("跨账号删除文案被拒绝", status == 404)
    call(b, "POST", "/api/copies", {"content": "B 的文案", "categoryIds": []}, 201)
    _, b_items = call(b, "GET", "/api/copies", expect=200)
    check("账号数据隔离", all(x["content"] != text for x in b_items["items"]))

    # 9. 批量管理与分类删除
    call(a, "POST", "/api/copies/bulk", {"ids": [cid], "action": "add_category", "categoryIds": [newcat["id"]]}, 200)
    _, updated = call(a, "GET", f"/api/copies/{cid}", expect=200)
    check("批量添加分类", any(c["id"] == newcat["id"] for c in updated["categories"]))
    call(a, "POST", "/api/copies/bulk", {"ids": [cid], "action": "remove_category", "categoryIds": [newcat["id"]]}, 200)
    _, updated2 = call(a, "GET", f"/api/copies/{cid}", expect=200)
    check("批量移除分类只解除关联", not any(c["id"] == newcat["id"] for c in updated2["categories"]) and updated2["content"] == text)
    call(a, "DELETE", f"/api/categories/{ins['id']}", 200)
    _, after_del = call(a, "GET", f"/api/copies/{cid}", expect=200)
    check("删除分类不删除文案", after_del["content"] == text and not any(c["id"] == ins["id"] for c in after_del["categories"]))

    # 10. 持久化：重新登录
    c = make_client()
    call(c, "POST", "/api/auth/login", {"account": ua, "password": "secret123"}, 200)
    _, again = call(c, "GET", f"/api/copies/{cid}", expect=200)
    check("退出重登后数据仍存在", again["content"] == text)
    _, all_items = call(c, "GET", "/api/copies?pageSize=100", expect=200)
    check("分页加载", all_items["total"] >= 6 and len(all_items["items"]) <= 100)

    # 11. 排序
    for sort in ["newest", "oldest", "favorite", "copies", "random"]:
        _, r = call(c, "GET", f"/api/copies?sort={sort}", expect=200)
        check("排序模式 " + sort, isinstance(r["items"], list))

    # 12. 官方精选档案：免登录访客可浏览与复制
    guest = make_client()
    _, disc = call(guest, "GET", "/api/discover", expect=200)
    official = [a for a in disc["archives"] if a["username"] == "official"]
    check("发现页内置官方精选档案", bool(official) and official[0]["privacy"] == "public", str(official))
    check("官方档案文案量充足", official and official[0]["copy_count"] >= 100, str(official and official[0]["copy_count"]))
    _, pub = call(guest, "GET", "/api/public/u/official", expect=200)
    check("免登录读官方档案详情", pub["copyCount"] >= 100 and pub["categoryCount"] >= 20)
    _, pubcats = call(guest, "GET", "/api/public/u/official/categories", expect=200)
    check("免登录读官方分类", len(pubcats["items"]) >= 20)
    _, pubcopies = call(guest, "GET", "/api/public/u/official/copies?pageSize=5", expect=200)
    check("免登录读官方文案", pubcopies["total"] >= 100 and len(pubcopies["items"]) == 5)
    first = pubcopies["items"][0]
    _, pubone = call(guest, "GET", f"/api/public/copies/{first['id']}", expect=200)
    check("免登录读官方文案详情", pubone["content"] == first["content"])
    call(guest, "POST", f"/api/copies/{first['id']}/copy", {}, 200)
    _, recounted = call(guest, "GET", f"/api/public/copies/{first['id']}", expect=200)
    check("访客复制官方文案并同步计数", recounted["copyCount"] == first["copyCount"] + 1)
    # 官方档案不可被他人修改
    call(guest, "PUT", "/api/profile", {"bio": "hack"}, 401)
    call(guest, "DELETE", f"/api/copies/{first['id']}", 401)

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} 项通过")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
