#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
COPY ARCHIVE — 本地全栈服务
Python 标准库 HTTP Server + SQLite 真实数据库。
所有用户数据访问都带身份约束；公开档案由服务端按隐私模式过滤。
"""

import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "copyarchive.db"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 天
PBKDF2_ROUNDS = 120_000

DATA_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_CATEGORIES = [
    ("风格类", ["INS", "韩系", "暗黑", "怪诞", "古风", "少女", "可爱", "萌物", "复古", "清冷", "高级感", "治愈", "赛博朋克", "哥特"]),
    ("用途类", ["短句", "水印", "亮晶晶", "实拍", "朋友圈", "个性签名", "社交媒体", "图片配文", "海报文案", "英文排版"]),
    ("其他类", ["情绪表达", "节日", "爱情", "友情", "日常", "文字素材"]),
]

GROUP_COLORS = {"风格类": "#262521", "用途类": "#5a5750", "其他类": "#8c877d", "自定义": "#1a1917"}


# ---------------------------------------------------------------------------
# 数据库
# ---------------------------------------------------------------------------

def db_connect():
    conn = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def now_iso(days=0):
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat(timespec="seconds")


def init_db():
    conn = db_connect()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS profiles (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            display_name TEXT NOT NULL,
            bio TEXT NOT NULL DEFAULT '',
            avatar_url TEXT NOT NULL DEFAULT '',
            cover_url TEXT NOT NULL DEFAULT '',
            theme TEXT NOT NULL DEFAULT 'paper',
            privacy TEXT NOT NULL DEFAULT 'public',
            public_category_ids TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            group_name TEXT NOT NULL DEFAULT '自定义',
            color TEXT NOT NULL DEFAULT '#1a1917',
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            UNIQUE(user_id, name)
        );

        CREATE TABLE IF NOT EXISTS copies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            copy_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS copy_categories (
            copy_id INTEGER NOT NULL REFERENCES copies(id) ON DELETE CASCADE,
            category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
            PRIMARY KEY (copy_id, category_id)
        );

        CREATE TABLE IF NOT EXISTS favorites (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            copy_id INTEGER NOT NULL REFERENCES copies(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (user_id, copy_id)
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_copies_user_created ON copies(user_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_copies_user_updated ON copies(user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_copies_user_count ON copies(user_id, copy_count DESC);
        CREATE INDEX IF NOT EXISTS idx_copies_owner ON copies(user_id);
        CREATE INDEX IF NOT EXISTS idx_cat_user_order ON categories(user_id, sort_order, id);
        CREATE INDEX IF NOT EXISTS idx_cc_category ON copy_categories(category_id, copy_id);
        CREATE INDEX IF NOT EXISTS idx_cc_copy ON copy_categories(copy_id, category_id);
        CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_fav_copy ON favorites(copy_id);
    """)
    conn.close()


def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ROUNDS)
    return "pbkdf2_sha256${}${}".format(salt, digest.hex())


def verify_password(password, stored):
    try:
        scheme, salt, digest = stored.split("$", 2)
        if scheme != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ROUNDS)
        return hmac.compare_digest(candidate.hex(), digest)
    except Exception:
        return False


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def seed_defaults(conn, user_id):
    order = 0
    for group, names in DEFAULT_CATEGORIES:
        for name in names:
            order += 1
            conn.execute(
                "INSERT OR IGNORE INTO categories (user_id, name, group_name, color, sort_order, is_default, created_at) "
                "VALUES (?, ?, ?, ?, ?, 1, ?)",
                (user_id, name, group, GROUP_COLORS[group], order, now_iso()),
            )


def json_loads(value, fallback):
    try:
        data = json.loads(value)
        return data if isinstance(data, list) else fallback
    except Exception:
        return fallback


# ---------------------------------------------------------------------------
# 数据查询辅助
# ---------------------------------------------------------------------------

def get_profile(conn, user_id):
    row = conn.execute("SELECT * FROM profiles WHERE user_id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def get_user_by_username(conn, username):
    return conn.execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)).fetchone()


def categories_for_copies(conn, copy_ids):
    if not copy_ids:
        return {}
    marks = ",".join("?" for _ in copy_ids)
    rows = conn.execute(
        f"SELECT cc.copy_id, c.id, c.name, c.color, c.group_name FROM copy_categories cc "
        f"JOIN categories c ON c.id = cc.category_id WHERE cc.copy_id IN ({marks}) ORDER BY c.sort_order, c.id",
        copy_ids,
    ).fetchall()
    result = {cid: [] for cid in copy_ids}
    for r in rows:
        result[r["copy_id"]].append({"id": r["id"], "name": r["name"], "color": r["color"], "group": r["group_name"]})
    return result


def serialize_copy(conn, row, viewer_id, include_categories=True):
    item = {
        "id": row["id"],
        "ownerId": row["user_id"],
        "title": row["title"],
        "content": row["content"],
        "note": row["note"],
        "tags": json_loads(row["tags"], []),
        "copyCount": row["copy_count"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "isFavorite": False,
        "categories": [],
    }
    if viewer_id:
        fav = conn.execute("SELECT 1 FROM favorites WHERE user_id = ? AND copy_id = ?", (viewer_id, row["id"])).fetchone()
        item["isFavorite"] = bool(fav)
    if include_categories:
        item["categories"] = categories_for_copies(conn, [row["id"]]).get(row["id"], [])
    return item


def public_category_ids(profile):
    if profile["privacy"] == "public":
        return None  # None = 不限制
    if profile["privacy"] == "private":
        return []  # 全部隐藏
    return json_loads(profile["public_category_ids"], [])


def visible_copy(conn, copy_id, viewer_id):
    """别人可见性校验：仅公开档案 / 部分公开中选中的分类。"""
    row = conn.execute("SELECT * FROM copies WHERE id = ?", (copy_id,)).fetchone()
    if not row:
        return None
    if viewer_id and row["user_id"] == viewer_id:
        return row
    profile = get_profile(conn, row["user_id"])
    if not profile or profile["privacy"] == "private":
        return None
    if profile["privacy"] == "public":
        return row
    allowed = json_loads(profile["public_category_ids"], [])
    if not allowed:
        return None
    marks = ",".join("?" for _ in allowed)
    hit = conn.execute(
        f"SELECT 1 FROM copy_categories WHERE copy_id = ? AND category_id IN ({marks}) LIMIT 1",
        [copy_id] + allowed,
    ).fetchone()
    return row if hit else None


def list_copies(conn, viewer_id, target_user_id, params):
    q = (params.get("q") or "").strip()
    category_ids = [int(x) for x in re.findall(r"\d+", params.get("category", "")) if int(x) > 0]
    favorite_only = params.get("favorite") == "1"
    sort = params.get("sort") or "newest"
    page = max(1, int(params.get("page") or 1))
    page_size = min(100, max(1, int(params.get("pageSize") or 24)))

    where = ["c.user_id = ?"]
    args = [target_user_id]

    if q:
        keywords = [k for k in re.split(r"\s+", q) if k][:8]
        field_sql = "(c.content LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR c.note LIKE ? ESCAPE '\\' OR c.tags LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM copy_categories cc2 JOIN categories cat2 ON cat2.id = cc2.category_id WHERE cc2.copy_id = c.id AND cat2.name LIKE ? ESCAPE '\\'))"
        for kw in keywords:
            like = "%" + kw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            where.append(field_sql)
            args.extend([like] * 5)

    if category_ids:
        marks = ",".join("?" for _ in category_ids)
        where.append(f"EXISTS (SELECT 1 FROM copy_categories cc WHERE cc.copy_id = c.id AND cc.category_id IN ({marks}))")
        args.extend(category_ids)

    if favorite_only and viewer_id:
        where.append("EXISTS (SELECT 1 FROM favorites f WHERE f.copy_id = c.id AND f.user_id = ?)")
        args.append(viewer_id)

    if viewer_id != target_user_id:
        profile = get_profile(conn, target_user_id)
        allowed = public_category_ids(profile) if profile else []
        if allowed is None:
            pass
        elif not allowed:
            return {"items": [], "total": 0, "page": page, "pageSize": page_size, "hasMore": False}
        else:
            marks = ",".join("?" for _ in allowed)
            where.append(f"EXISTS (SELECT 1 FROM copy_categories cc3 WHERE cc3.copy_id = c.id AND cc3.category_id IN ({marks}))")
            args.extend(allowed)

    where_sql = " AND ".join(where)
    order = {
        "newest": "c.created_at DESC, c.id DESC",
        "oldest": "c.created_at ASC, c.id ASC",
        "favorite": "(SELECT COUNT(*) FROM favorites f2 WHERE f2.copy_id = c.id) DESC, c.created_at DESC",
        "copies": "c.copy_count DESC, c.created_at DESC",
        "random": "RANDOM()",
    }.get(sort, "c.created_at DESC, c.id DESC")

    total = conn.execute(f"SELECT COUNT(*) AS n FROM copies c WHERE {where_sql}", args).fetchone()["n"]
    rows = conn.execute(
        f"SELECT c.* FROM copies c WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?",
        args + [page_size, (page - 1) * page_size],
    ).fetchall()
    cat_map = categories_for_copies(conn, [r["id"] for r in rows])
    items = []
    for r in rows:
        item = serialize_copy(conn, r, viewer_id, include_categories=False)
        item["categories"] = cat_map.get(r["id"], [])
        items.append(item)
    return {"items": items, "total": total, "page": page, "pageSize": page_size, "hasMore": page * page_size < total}


# ---------------------------------------------------------------------------
# HTTP 工具
# ---------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def read_body(handler, max_bytes=4 * 1024 * 1024):
    length = int(handler.headers.get("Content-Length") or 0)
    if length > max_bytes:
        raise ApiError(413, "内容过大")
    raw = handler.rfile.read(length) if length else b""
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        raise ApiError(400, "请求格式不正确")


def parse_cookies(handler):
    result = {}
    raw = handler.headers.get("Cookie") or ""
    cookie = SimpleCookie()
    try:
        cookie.load(raw)
        for key, morsel in cookie.items():
            result[key] = morsel.value
    except Exception:
        pass
    return result


def require_auth(handler, conn):
    token = parse_cookies(handler).get("ca_session")
    if not token:
        raise ApiError(401, "请先登录")
    row = conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token_hash = ? AND s.expires_at > ?",
        (token_hash(token), now_iso()),
    ).fetchone()
    if not row:
        raise ApiError(401, "登录已过期，请重新登录")
    return row


def optional_auth(handler, conn):
    token = parse_cookies(handler).get("ca_session")
    if not token:
        return None
    return conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token_hash = ? AND s.expires_at > ?",
        (token_hash(token), now_iso()),
    ).fetchone()


def validate_username(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_]{3,20}", value):
        raise ApiError(400, "用户名需为 3–20 位字母、数字或下划线")
    return value


def validate_email(value):
    if not isinstance(value, str) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
        raise ApiError(400, "请输入有效的邮箱地址")
    return value.strip().lower()


def parse_tags(value):
    if isinstance(value, list):
        return [str(x)[:40] for x in value if str(x).strip()][:20]
    if isinstance(value, str):
        return [t.strip()[:40] for t in re.split(r"[,，\n]", value) if t.strip()][:20]
    return []


def clean_text(value, field, required=False, max_len=10000):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(400, f"{field}格式不正确")
    if required and value.strip() == "":
        raise ApiError(400, f"{field}不能为空")
    if len(value) > max_len:
        raise ApiError(400, f"{field}不能超过 {max_len} 字符")
    return value  # 原文不做 trim，不修改标点、空格和换行


def resolve_category_ids(conn, user_id, raw):
    ids = []
    for x in (raw or []):
        try:
            cid = int(x)
        except (TypeError, ValueError):
            continue
        if cid > 0 and cid not in ids:
            ids.append(cid)
    if ids:
        marks = ",".join("?" for _ in ids)
        found = {r["id"] for r in conn.execute(f"SELECT id FROM categories WHERE user_id = ? AND id IN ({marks})", [user_id] + ids)}
        ids = [i for i in ids if i in found]
    return ids


# ---------------------------------------------------------------------------
# 路由处理
# ---------------------------------------------------------------------------

def handle_api(handler, method, path, query, conn):
    user = optional_auth(handler, conn)
    viewer_id = user["id"] if user else None

    # ---- 健康检查 ----
    if method == "GET" and path == "/api/health":
        return 200, {"ok": True, "time": now_iso()}

    # ---- 注册 ----
    if method == "POST" and path == "/api/auth/register":
        body = read_body(handler)
        username = validate_username(body.get("username"))
        email = validate_email(body.get("email"))
        password = body.get("password")
        if not isinstance(password, str) or len(password) < 6:
            raise ApiError(400, "密码至少需要 6 位")
        display_name = clean_text(body.get("displayName") or username, "昵称", max_len=40) or username
        if conn.execute("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE", (username, email)).fetchone():
            raise ApiError(409, "用户名或邮箱已被注册")
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute(
            "INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
            (username, email, hash_password(password), now_iso()),
        )
        uid = cur.lastrowid
        conn.execute(
            "INSERT INTO profiles (user_id, display_name, bio, avatar_url, cover_url, theme, privacy, public_category_ids, created_at) "
            "VALUES (?, ?, '', '', '', 'paper', 'public', '[]', ?)",
            (uid, display_name, now_iso()),
        )
        seed_defaults(conn, uid)
        conn.execute("COMMIT")
        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token_hash(token), uid, now_iso(), now_iso(30)),
        )
        return 200, {"user": {"id": uid, "username": username, "email": email, "displayName": display_name}, "token": token}

    # ---- 登录 ----
    if method == "POST" and path == "/api/auth/login":
        body = read_body(handler)
        account = str(body.get("account") or "").strip()
        password = body.get("password") or ""
        row = conn.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE",
            (account, account.lower()),
        ).fetchone()
        if not row or not verify_password(str(password), row["password_hash"]):
            raise ApiError(401, "账号或密码不正确")
        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token_hash(token), row["id"], now_iso(), now_iso(30)),
        )
        profile = get_profile(conn, row["id"])
        return 200, {
            "user": {"id": row["id"], "username": row["username"], "email": row["email"], "displayName": profile["display_name"]},
            "token": token,
        }

    # ---- 退出 ----
    if method == "POST" and path == "/api/auth/logout":
        token = parse_cookies(handler).get("ca_session")
        if token:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
        return 200, {"ok": True}

    # ---- 当前用户 ----
    if method == "GET" and path == "/api/auth/me":
        if not user:
            return 200, {"user": None}
        profile = get_profile(conn, user["id"])
        return 200, {
            "user": {
                "id": user["id"], "username": user["username"], "email": user["email"],
                "displayName": profile["display_name"], "bio": profile["bio"],
                "avatarUrl": profile["avatar_url"], "coverUrl": profile["cover_url"],
                "theme": profile["theme"], "privacy": profile["privacy"],
                "publicCategoryIds": json_loads(profile["public_category_ids"], []),
                "createdAt": profile["created_at"],
            }
        }

    # ---- 分类 ----
    if path == "/api/categories" and method == "GET":
        me = require_auth(handler, conn)
        rows = conn.execute("SELECT * FROM categories WHERE user_id = ? ORDER BY sort_order, id", (me["id"],)).fetchall()
        counts = {r["category_id"]: r["n"] for r in conn.execute(
            "SELECT category_id, COUNT(*) AS n FROM copy_categories cc JOIN copies c ON c.id = cc.copy_id "
            "WHERE c.user_id = ? GROUP BY category_id", (me["id"],)
        )}
        return 200, {"items": [
            {"id": r["id"], "name": r["name"], "group": r["group_name"], "color": r["color"],
             "sortOrder": r["sort_order"], "isDefault": bool(r["is_default"]), "count": counts.get(r["id"], 0)}
            for r in rows
        ]}

    if path == "/api/categories" and method == "POST":
        me = require_auth(handler, conn)
        body = read_body(handler)
        name = clean_text(body.get("name"), "分类名称", required=True, max_len=30).strip()
        color = clean_text(body.get("color") or "#1a1917", "颜色", max_len=20)
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise ApiError(400, "颜色需为 #RRGGBB 格式")
        if conn.execute("SELECT 1 FROM categories WHERE user_id = ? AND name = ?", (me["id"], name)).fetchone():
            raise ApiError(409, "分类名称已存在")
        order = conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM categories WHERE user_id = ?", (me["id"],)).fetchone()["n"]
        cur = conn.execute(
            "INSERT INTO categories (user_id, name, group_name, color, sort_order, is_default, created_at) VALUES (?, ?, '自定义', ?, ?, 0, ?)",
            (me["id"], name, color, order, now_iso()),
        )
        return 201, {"id": cur.lastrowid, "name": name, "color": color, "group": "自定义", "count": 0}

    m = re.fullmatch(r"/api/categories/(\d+)", path)
    if m and method in ("PATCH", "DELETE"):
        me = require_auth(handler, conn)
        cid = int(m.group(1))
        row = conn.execute("SELECT * FROM categories WHERE id = ? AND user_id = ?", (cid, me["id"])).fetchone()
        if not row:
            raise ApiError(404, "分类不存在")
        if method == "DELETE":
            # 只解除关联，不删除任何文案
            conn.execute("DELETE FROM copy_categories WHERE category_id = ?", (cid,))
            conn.execute("DELETE FROM categories WHERE id = ?", (cid,))
            return 200, {"ok": True, "message": "分类已删除，文案已保留"}
        body = read_body(handler)
        name = row["name"]
        color = row["color"]
        sort_order = row["sort_order"]
        if "name" in body:
            name = clean_text(body["name"], "分类名称", required=True, max_len=30).strip()
            dup = conn.execute("SELECT 1 FROM categories WHERE user_id = ? AND name = ? AND id != ?", (me["id"], name, cid)).fetchone()
            if dup:
                raise ApiError(409, "分类名称已存在")
        if "color" in body:
            color = clean_text(body["color"], "颜色", max_len=20)
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
                raise ApiError(400, "颜色需为 #RRGGBB 格式")
        if "sortOrder" in body:
            try:
                sort_order = int(body["sortOrder"])
            except (TypeError, ValueError):
                raise ApiError(400, "排序值不正确")
        conn.execute("UPDATE categories SET name = ?, color = ?, sort_order = ? WHERE id = ?", (name, color, sort_order, cid))
        return 200, {"id": cid, "name": name, "color": color, "sortOrder": sort_order}

    if path == "/api/categories/reorder" and method == "POST":
        me = require_auth(handler, conn)
        body = read_body(handler)
        ids = [int(x) for x in (body.get("ids") or []) if str(x).isdigit()]
        for idx, cid in enumerate(ids):
            conn.execute("UPDATE categories SET sort_order = ? WHERE id = ? AND user_id = ?", (idx + 1, cid, me["id"]))
        return 200, {"ok": True}

    # ---- 文案查重 ----
    if path == "/api/copies/check-duplicates" and method == "POST":
        me = require_auth(handler, conn)
        body = read_body(handler)
        contents = body.get("contents") or []
        if not isinstance(contents, list):
            raise ApiError(400, "内容格式不正确")
        existing = {}
        for text in contents[:200]:
            if not isinstance(text, str) or not text:
                continue
            row = conn.execute("SELECT id FROM copies WHERE user_id = ? AND content = ? LIMIT 1", (me["id"], text)).fetchone()
            if row:
                existing[text] = row["id"]
        return 200, {"existing": existing}

    # ---- 文案列表 ----
    if path == "/api/copies" and method == "GET":
        if not user:
            raise ApiError(401, "请先登录")
        target = user["id"]
        if query.get("owner"):
            owner = get_user_by_username(conn, str(query["owner"][0]))
            if not owner:
                raise ApiError(404, "用户不存在")
            target = owner["id"]
        return 200, list_copies(conn, viewer_id, target, {k: v[0] for k, v in query.items()})

    # ---- 单条上传 ----
    if path == "/api/copies" and method == "POST":
        me = require_auth(handler, conn)
        body = read_body(handler)
        content = clean_text(body.get("content"), "文案正文", required=True)
        title = clean_text(body.get("title"), "标题", max_len=120)
        note = clean_text(body.get("note"), "备注", max_len=2000)
        tags = parse_tags(body.get("tags"))
        cids = resolve_category_ids(conn, me["id"], body.get("categoryIds"))
        ts = now_iso()
        cur = conn.execute(
            "INSERT INTO copies (user_id, title, content, note, tags, copy_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
            (me["id"], title, content, note, json.dumps(tags, ensure_ascii=False), ts, ts),
        )
        cid = cur.lastrowid
        conn.executemany("INSERT INTO copy_categories (copy_id, category_id) VALUES (?, ?)", [(cid, x) for x in cids])
        return 201, serialize_copy(conn, conn.execute("SELECT * FROM copies WHERE id = ?", (cid,)).fetchone(), me["id"])

    # ---- 批量上传 ----
    if path == "/api/copies/batch" and method == "POST":
        me = require_auth(handler, conn)
        body = read_body(handler)
        raw_items = body.get("items") or []
        if not isinstance(raw_items, list) or not raw_items:
            raise ApiError(400, "没有可导入的文案")
        if len(raw_items) > 200:
            raise ApiError(400, "单次最多导入 200 条")
        global_cids = resolve_category_ids(conn, me["id"], body.get("categoryIds"))
        ts = now_iso()
        created = []
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            content = clean_text(item.get("content"), "文案正文", required=True)
            title = clean_text(item.get("title"), "标题", max_len=120)
            note = clean_text(item.get("note"), "备注", max_len=2000)
            tags = parse_tags(item.get("tags"))
            cids = global_cids
            if "categoryIds" in item:
                cids = resolve_category_ids(conn, me["id"], item.get("categoryIds"))
            cur = conn.execute(
                "INSERT INTO copies (user_id, title, content, note, tags, copy_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
                (me["id"], title, content, note, json.dumps(tags, ensure_ascii=False), ts, ts),
            )
            cid = cur.lastrowid
            conn.executemany("INSERT INTO copy_categories (copy_id, category_id) VALUES (?, ?)", [(cid, x) for x in cids])
            created.append(cid)
        rows = [conn.execute("SELECT * FROM copies WHERE id = ?", (cid,)).fetchone() for cid in created]
        cat_map = categories_for_copies(conn, created)
        items = []
        for r in rows:
            item = serialize_copy(conn, r, me["id"], include_categories=False)
            item["categories"] = cat_map.get(r["id"], [])
            items.append(item)
        return 201, {"items": items, "count": len(items)}

    m = re.fullmatch(r"/api/copies/(\d+)", path)
    if m:
        me = require_auth(handler, conn)
        cid = int(m.group(1))
        row = conn.execute("SELECT * FROM copies WHERE id = ? AND user_id = ?", (cid, me["id"])).fetchone()
        if not row:
            raise ApiError(404, "文案不存在或无权访问")
        if method == "GET":
            return 200, serialize_copy(conn, row, me["id"])
        if method == "PATCH":
            body = read_body(handler)
            content = clean_text(body["content"], "文案正文", required=True) if "content" in body else row["content"]
            title = clean_text(body.get("title", row["title"]), "标题", max_len=120)
            note = clean_text(body.get("note", row["note"]), "备注", max_len=2000)
            tags = parse_tags(body["tags"]) if "tags" in body else json_loads(row["tags"], [])
            conn.execute(
                "UPDATE copies SET title = ?, content = ?, note = ?, tags = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                (title, content, note, json.dumps(tags, ensure_ascii=False), now_iso(), cid, me["id"]),
            )
            if "categoryIds" in body:
                cids = resolve_category_ids(conn, me["id"], body.get("categoryIds"))
                conn.execute("DELETE FROM copy_categories WHERE copy_id = ?", (cid,))
                conn.executemany("INSERT INTO copy_categories (copy_id, category_id) VALUES (?, ?)", [(cid, x) for x in cids])
            return 200, serialize_copy(conn, conn.execute("SELECT * FROM copies WHERE id = ?", (cid,)).fetchone(), me["id"])
        if method == "DELETE":
            conn.execute("DELETE FROM copies WHERE id = ? AND user_id = ?", (cid, me["id"]))
            return 200, {"ok": True}

    # ---- 复制计数（公开访客也可） ----
    m = re.fullmatch(r"/api/copies/(\d+)/copy", path)
    if m and method == "POST":
        cid = int(m.group(1))
        row = visible_copy(conn, cid, viewer_id)
        if not row:
            raise ApiError(404, "文案不存在或无权访问")
        conn.execute("UPDATE copies SET copy_count = copy_count + 1 WHERE id = ?", (cid,))
        return 200, {"ok": True, "copyCount": row["copy_count"] + 1}

    # ---- 收藏 ----
    m = re.fullmatch(r"/api/copies/(\d+)/favorite", path)
    if m and method == "POST":
        me = require_auth(handler, conn)
        cid = int(m.group(1))
        if not visible_copy(conn, cid, me["id"]):
            raise ApiError(404, "文案不存在或无权访问")
        body = read_body(handler)
        wanted = bool(body.get("value"))
        if wanted:
            conn.execute("INSERT OR IGNORE INTO favorites (user_id, copy_id, created_at) VALUES (?, ?, ?)", (me["id"], cid, now_iso()))
        else:
            conn.execute("DELETE FROM favorites WHERE user_id = ? AND copy_id = ?", (me["id"], cid))
        return 200, {"ok": True, "isFavorite": wanted}

    # ---- 批量管理 ----
    if path == "/api/copies/bulk" and method == "POST":
        me = require_auth(handler, conn)
        body = read_body(handler)
        ids = [int(x) for x in (body.get("ids") or []) if str(x).isdigit()]
        action = body.get("action")
        if not ids:
            raise ApiError(400, "请先选择文案")
        if len(ids) > 200:
            raise ApiError(400, "单次最多处理 200 条")
        marks = ",".join("?" for _ in ids)
        owned = [r["id"] for r in conn.execute(f"SELECT id FROM copies WHERE user_id = ? AND id IN ({marks})", [me["id"]] + ids)]
        if action == "delete":
            conn.executemany("DELETE FROM copies WHERE id = ? AND user_id = ?", [(i, me["id"]) for i in owned])
            return 200, {"ok": True, "count": len(owned)}
        if action == "favorite":
            conn.executemany("INSERT OR IGNORE INTO favorites (user_id, copy_id, created_at) VALUES (?, ?, ?)", [(me["id"], i, now_iso()) for i in ids])
            return 200, {"ok": True, "count": len(ids)}
        if action == "unfavorite":
            conn.executemany("DELETE FROM favorites WHERE user_id = ? AND copy_id = ?", [(me["id"], i) for i in ids])
            return 200, {"ok": True, "count": len(ids)}
        if action in ("add_category", "remove_category"):
            cids = resolve_category_ids(conn, me["id"], body.get("categoryIds"))
            if not cids:
                raise ApiError(400, "请选择分类")
            if action == "add_category":
                conn.executemany("INSERT OR IGNORE INTO copy_categories (copy_id, category_id) VALUES (?, ?)", [(i, c) for i in owned for c in cids])
            else:
                for i in owned:
                    for c in cids:
                        conn.execute("DELETE FROM copy_categories WHERE copy_id = ? AND category_id = ?", (i, c))
            return 200, {"ok": True, "count": len(owned)}
        raise ApiError(400, "未知操作")

    # ---- 个人档案更新 ----
    if path == "/api/profile" and method == "PUT":
        me = require_auth(handler, conn)
        body = read_body(handler)
        profile = get_profile(conn, me["id"])
        display_name = clean_text(body.get("displayName", profile["display_name"]), "昵称", required=True, max_len=40)
        bio = clean_text(body.get("bio", profile["bio"]), "简介", max_len=500)
        # 头像与封面为浏览器端压缩后的 data URL，容量远大于普通链接
        avatar_url = clean_text(body.get("avatarUrl", profile["avatar_url"]), "头像", max_len=400000)
        cover_url = clean_text(body.get("coverUrl", profile["cover_url"]), "封面", max_len=600000)
        theme = body.get("theme", profile["theme"])
        if theme not in ("paper", "ink", "newsprint"):
            raise ApiError(400, "主题不正确")
        privacy = body.get("privacy", profile["privacy"])
        if privacy not in ("public", "partial", "private"):
            raise ApiError(400, "隐私模式不正确")
        public_ids = resolve_category_ids(conn, me["id"], body.get("publicCategoryIds")) if "publicCategoryIds" in body else json_loads(profile["public_category_ids"], [])
        conn.execute(
            "UPDATE profiles SET display_name = ?, bio = ?, avatar_url = ?, cover_url = ?, theme = ?, privacy = ?, public_category_ids = ? WHERE user_id = ?",
            (display_name, bio, avatar_url, cover_url, theme, privacy, json.dumps(public_ids), me["id"]),
        )
        return 200, {"ok": True}

    # ---- 发现页 ----
    if path == "/api/discover" and method == "GET":
        rows = conn.execute("""
            SELECT u.id, u.username, p.display_name, p.bio, p.avatar_url, p.privacy, p.created_at,
                   (SELECT COUNT(*) FROM copies c WHERE c.user_id = u.id) AS copy_count,
                   (SELECT COUNT(*) FROM categories ca WHERE ca.user_id = u.id) AS category_count
            FROM users u JOIN profiles p ON p.user_id = u.id
            WHERE p.privacy != 'private'
            ORDER BY copy_count DESC, u.id ASC LIMIT 12
        """).fetchall()
        q = (query.get("q") or [""])[0].strip()
        kw = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        popular = conn.execute("""
            SELECT c.* FROM copies c JOIN profiles p ON p.user_id = c.user_id
            WHERE (p.privacy = 'public' OR (p.privacy = 'partial' AND EXISTS (
                SELECT 1 FROM copy_categories cc WHERE cc.copy_id = c.id
                AND cc.category_id IN (SELECT value FROM json_each(p.public_category_ids))
            )))
            AND (? = '' OR c.content LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR c.tags LIKE ? ESCAPE '\\')
            ORDER BY c.copy_count DESC, c.id DESC LIMIT 24
        """, (q, kw, kw, kw)).fetchall()
        return 200, {
            "archives": [dict(r) for r in rows],
            "popular": [serialize_copy(conn, r, viewer_id) for r in popular],
        }

    # ---- 公开文案详情（访客可读，服务端按隐私过滤） ----
    m = re.fullmatch(r"/api/public/copies/(\d+)", path)
    if m and method == "GET":
        row = visible_copy(conn, int(m.group(1)), viewer_id)
        if not row:
            raise ApiError(404, "文案不存在或未公开")
        return 200, serialize_copy(conn, row, viewer_id)

    # ---- 公开档案 ----
    m = re.fullmatch(r"/api/public/u/([^/]+)", path)
    if m and method == "GET":
        username = urllib.parse.unquote(m.group(1))
        owner = get_user_by_username(conn, username)
        if not owner:
            raise ApiError(404, "档案不存在")
        profile = get_profile(conn, owner["id"])
        if not profile or profile["privacy"] == "private":
            raise ApiError(404, "该档案未公开")
        allowed = public_category_ids(profile)
        if allowed is None:
            total = conn.execute("SELECT COUNT(*) AS n FROM copies WHERE user_id = ?", (owner["id"],)).fetchone()["n"]
            cat_total = conn.execute("SELECT COUNT(*) AS n FROM categories WHERE user_id = ?", (owner["id"],)).fetchone()["n"]
        elif not allowed:
            total, cat_total = 0, 0
        else:
            marks = ",".join("?" for _ in allowed)
            total = conn.execute(
                f"SELECT COUNT(DISTINCT c.id) AS n FROM copies c JOIN copy_categories cc ON cc.copy_id = c.id "
                f"WHERE c.user_id = ? AND cc.category_id IN ({marks})",
                [owner["id"]] + allowed,
            ).fetchone()["n"]
            cat_total = conn.execute(
                f"SELECT COUNT(*) AS n FROM categories WHERE user_id = ? AND id IN ({marks})",
                [owner["id"]] + allowed,
            ).fetchone()["n"]
        return 200, {
            "username": owner["username"],
            "displayName": profile["display_name"],
            "bio": profile["bio"],
            "avatarUrl": profile["avatar_url"],
            "coverUrl": profile["cover_url"],
            "theme": profile["theme"],
            "privacy": profile["privacy"],
            "createdAt": profile["created_at"],
            "copyCount": total,
            "categoryCount": cat_total,
        }

    m = re.fullmatch(r"/api/public/u/([^/]+)/categories", path)
    if m and method == "GET":
        owner = get_user_by_username(conn, urllib.parse.unquote(m.group(1)))
        if not owner:
            raise ApiError(404, "档案不存在")
        profile = get_profile(conn, owner["id"])
        allowed = public_category_ids(profile) if profile else []
        if not allowed and allowed is not None:
            return 200, {"items": []}
        rows = conn.execute("SELECT * FROM categories WHERE user_id = ? ORDER BY sort_order, id", (owner["id"],)).fetchall()
        if allowed is not None:
            rows = [r for r in rows if r["id"] in allowed]
        counts = {r["category_id"]: r["n"] for r in conn.execute(
            "SELECT category_id, COUNT(DISTINCT cc.copy_id) AS n FROM copy_categories cc JOIN copies c ON c.id = cc.copy_id "
            "WHERE c.user_id = ? GROUP BY category_id", (owner["id"],)
        )}
        return 200, {"items": [{"id": r["id"], "name": r["name"], "color": r["color"], "group": r["group_name"], "count": counts.get(r["id"], 0)} for r in rows]}

    m = re.fullmatch(r"/api/public/u/([^/]+)/copies", path)
    if m and method == "GET":
        owner = get_user_by_username(conn, urllib.parse.unquote(m.group(1)))
        if not owner:
            raise ApiError(404, "档案不存在")
        profile = get_profile(conn, owner["id"])
        if not profile or profile["privacy"] == "private":
            raise ApiError(404, "该档案未公开")
        return 200, list_copies(conn, viewer_id, owner["id"], {k: v[0] for k, v in query.items()})

    raise ApiError(404, "接口不存在")


# ---------------------------------------------------------------------------
# 请求处理
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "CopyArchive/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("COPY_ARCHIVE_VERBOSE"):
            super().log_message(fmt, *args)

    def send_json(self, status, payload, extra_headers=None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def session_cookie(self, token):
        return "ca_session={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}".format(token, SESSION_MAX_AGE)

    def cleared_cookie(self):
        return "ca_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

    def dispatch(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)

        if path.startswith("/api/"):
            conn = db_connect()
            extra_headers = {}
            try:
                if method in ("POST", "PUT", "PATCH", "DELETE"):
                    if self.headers.get("X-Requested-With") != "XMLHttpRequest":
                        raise ApiError(403, "请求来源校验失败")
                status, payload = handle_api(self, method, path, query, conn)
                if isinstance(payload, dict) and "token" in payload:
                    extra_headers["Set-Cookie"] = self.session_cookie(payload.pop("token"))
                if path == "/api/auth/logout" and status == 200:
                    extra_headers["Set-Cookie"] = self.cleared_cookie()
                self.send_json(status, payload, extra_headers)
            except ApiError as exc:
                self.send_json(exc.status, {"error": exc.message})
            except sqlite3.IntegrityError as exc:
                self.send_json(409, {"error": "数据冲突：" + str(exc)})
            except Exception as exc:
                self.send_json(500, {"error": "服务暂时不可用，请稍后重试"})
                if os.environ.get("COPY_ARCHIVE_VERBOSE"):
                    import traceback
                    traceback.print_exc()
            finally:
                conn.close()
            return

        self.serve_static(path, method)

    def serve_static(self, path, method):
        if method not in ("GET", "HEAD"):
            self.send_error(405)
            return
        if path == "/":
            path = "/index.html"
        candidate = (PUBLIC_DIR / path.lstrip("/")).resolve()
        try:
            candidate.relative_to(PUBLIC_DIR.resolve())
        except ValueError:
            self.send_error(403)
            return
        if not candidate.is_file() or not candidate.suffix:
            # SPA 深链：统一交给 404.html 回退，与 GitHub Pages 行为一致。
            # 这样应用入口永远位于根路径，页面内相对资源路径不会错位。
            fallback = PUBLIC_DIR / "404.html"
            if not fallback.is_file():
                self.send_error(404)
                return
            content = fallback.read_bytes()
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if method == "GET":
                self.wfile.write(content)
            return
        content = candidate.read_bytes()
        ctype = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache" if candidate.name == "index.html" else "public, max-age=3600")
        self.end_headers()
        if method == "GET":
            self.wfile.write(content)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")


def main():
    init_db()
    port = int(os.environ.get("PORT") or 8765)
    host = os.environ.get("HOST") or "127.0.0.1"
    server = ThreadingHTTPServer((host, port), Handler)
    print("COPY ARCHIVE running at http://{}:{}".format(host, port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
