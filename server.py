#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
COPY ARCHIVE — 本地全栈服务
Python 标准库 HTTP Server + SQLite 真实数据库。
所有用户数据访问都带身份约束；公开档案由服务端按隐私模式过滤。
"""

import hashlib
import hmac
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import socket
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = Path(os.environ.get("COPY_ARCHIVE_DATA_DIR") or (ROOT / "data"))
DB_PATH = Path(os.environ.get("COPY_ARCHIVE_DB") or (DATA_DIR / "copyarchive.db"))
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 天
PBKDF2_ROUNDS = 120_000

# 跨站调用（GitHub Pages 静态版 → 完整版云端 API）。
# 使用 Bearer Token 而非 Cookie，因此不需要 Access-Control-Allow-Credentials。
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, Authorization, X-CA-Token",
    "Access-Control-Max-Age": "86400",
}

DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

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


def load_samples():
    """读取示例文案库（public/samples.json）。"""
    path = PUBLIC_DIR / "samples.json"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {"groups": []}


def guess_tags(text):
    """按文案语种自动打标签，让标签筛选也有内容可用。"""
    tags = []
    if re.search(r"[가-힣]", text):
        tags.append("韩文")
    if re.search(r"[一-鿿]", text):
        tags.append("中文")
    if re.search(r"[A-Za-z]", text):
        tags.append("英文")
    return tags


def seed_sample_copies(conn, user_id):
    """按 public/samples.json 为指定用户填充示例文案（按分类名匹配，幂等）。"""
    library = load_samples()
    owned = {
        r["name"]: r["id"]
        for r in conn.execute("SELECT id, name FROM categories WHERE user_id = ?", (user_id,))
    }
    existing = {
        r["content"]
        for r in conn.execute("SELECT content FROM copies WHERE user_id = ?", (user_id,))
    }
    created = 0
    skipped = 0
    base_ts = datetime.now(timezone.utc)
    step = 0
    for grp in library.get("groups", []):
        for item in grp.get("items", []):
            cid = owned.get(item.get("name"))
            if cid is None:
                continue
            for text in item.get("texts", []):
                if not text or text in existing:
                    skipped += 1
                    continue
                step += 1
                ts = (base_ts - timedelta(seconds=step)).isoformat(timespec="seconds")
                cur = conn.execute(
                    "INSERT INTO copies (user_id, title, content, note, tags, copy_count, created_at, updated_at) "
                    "VALUES (?, '', ?, '', ?, 0, ?, ?)",
                    (user_id, text, json.dumps(guess_tags(text), ensure_ascii=False), ts, ts),
                )
                conn.execute(
                    "INSERT OR IGNORE INTO copy_categories (copy_id, category_id) VALUES (?, ?)",
                    (cur.lastrowid, cid),
                )
                existing.add(text)
                created += 1
    return created, skipped


OFFICIAL_USERNAME = "official"
OFFICIAL_EMAIL = "official@copyarchive.local"


def ensure_sample_categories(conn, user_id):
    """按 samples.json 的分组为用户补建缺失的分类（幂等），返回新建数量。

    用于官方公开档案：示例库扩充后（如新增「蕾丝」分类），已存在的官方账号
    也能在下次启动时自动补齐新分类，不触碰任何个人用户的分类。"""
    library = load_samples()
    owned = {
        r["name"]
        for r in conn.execute("SELECT name FROM categories WHERE user_id = ?", (user_id,))
    }
    row = conn.execute(
        "SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories WHERE user_id = ?", (user_id,)
    ).fetchone()
    order = row["m"]
    created = 0
    for grp in library.get("groups", []):
        gname = grp.get("group") or "其他类"
        for item in grp.get("items", []):
            name = item.get("name")
            if not name or name in owned:
                continue
            order += 1
            conn.execute(
                "INSERT OR IGNORE INTO categories (user_id, name, group_name, color, sort_order, is_default, created_at) "
                "VALUES (?, ?, ?, ?, ?, 0, ?)",
                (user_id, name, gname, GROUP_COLORS.get(gname, GROUP_COLORS["自定义"]), order, now_iso()),
            )
            owned.add(name)
            created += 1
    return created


def seed_official_archive(conn):
    """内置「官方精选」公开档案。

    公开档案不需要登录注册——任何访客在发现页/直接链接都能浏览、搜索、复制
    这里的示例文案。账号密码随机生成且从不颁发会话，等于无人可登录，
    只作为公开内容的载体存在；用户名提前占位，防止被抢注。
    official 已存在时做增量补录：补建示例库新增分类、填充新增文案（均幂等），
    只写 official 账号，不碰任何个人用户的档案。
    """
    existing = get_user_by_username(conn, OFFICIAL_USERNAME)
    if existing:
        uid = existing["id"]
        conn.execute("BEGIN IMMEDIATE")
        try:
            added_cats = ensure_sample_categories(conn, uid)
            created, _ = seed_sample_copies(conn, uid)
            conn.execute("COMMIT")
            if created or added_cats:
                print(
                    "topped up official archive: {} categories, {} entries".format(added_cats, created),
                    flush=True,
                )
        except Exception:
            conn.execute("ROLLBACK")
            raise
        return False
    conn.execute("BEGIN IMMEDIATE")
    cur = conn.execute(
        "INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
        (OFFICIAL_USERNAME, OFFICIAL_EMAIL, hash_password(secrets.token_hex(24)), now_iso()),
    )
    uid = cur.lastrowid
    conn.execute(
        "INSERT INTO profiles (user_id, display_name, bio, avatar_url, cover_url, theme, privacy, public_category_ids, created_at) "
        "VALUES (?, ?, ?, '', '', 'paper', 'public', '[]', ?)",
        (
            uid,
            "官方精选 Official",
            "内置示例文案库：中英韩多语种金句，覆盖 31 个分类。无需登录注册，浏览、搜索、复制随意取用——喜欢就收藏进你自己的档案。",
            now_iso(),
        ),
    )
    seed_defaults(conn, uid)
    ensure_sample_categories(conn, uid)
    created, _ = seed_sample_copies(conn, uid)
    conn.execute("COMMIT")
    print("seeded official archive: {} entries".format(created), flush=True)
    return True


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
    def __init__(self, status, message, extra=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


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


def request_token(handler):
    """登录后凭证：优先 Authorization: Bearer，其次 Cookie。

    Bearer 让静态版本（不同域名）也能使用同一套云端账号；Cookie 保持
    完整版现有行为不变，两者对应同一张 sessions 表。
    """
    # 部分部署网关会过滤 Authorization / Cookie，但会透传自定义头
    custom = (handler.headers.get("X-CA-Token") or "").strip()
    if custom:
        return custom
    auth = handler.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return parse_cookies(handler).get("ca_session")


def require_auth(handler, conn):
    token = request_token(handler)
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
    token = request_token(handler)
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
# 链接导入：网页抓取与正文提取（链接导入功能）
# ---------------------------------------------------------------------------

FETCH_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
FETCH_MAX_BYTES = 3 * 1024 * 1024
PROXY_IMAGE_MAX_BYTES = 8 * 1024 * 1024


def validate_fetch_url(raw):
    """校验待抓取链接：仅 http(s)，且域名不得解析到内网/回环地址（SSRF 防护）。"""
    if not isinstance(raw, str) or not raw.strip():
        raise ApiError(400, "请提供链接")
    raw = raw.strip()
    if not raw.lower().startswith(("http://", "https://")):
        raw = "https://" + raw
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ApiError(400, "请提供有效的 http(s) 链接")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except Exception:
        raise ApiError(400, "无法解析该域名，请检查链接")
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_unspecified or ip.is_multicast:
            raise ApiError(400, "该链接指向内网地址，出于安全考虑不予抓取")
    return urllib.parse.urlunparse(parsed)


def append_share_for_self(handler, url):
    """目标与当前站点同域时透传 sharecode。

    部署平台的网关要求所有请求带 sharecode；用户抓取/代理自己站内页面时，
    服务端二次请求不带 sharecode 会被拦，这里自动补上当前请求的 sharecode。
    """
    try:
        parsed = urllib.parse.urlparse(url)
        host = (handler.headers.get("Host") or "").split(":")[0]
        if parsed.hostname and host and parsed.hostname.lower() == host.lower():
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
            sc = (qs.get("sharecode") or [""])[0]
            if sc and "sharecode" not in (parsed.query or ""):
                url = url + ("&" if parsed.query else "?") + "sharecode=" + sc
    except Exception:
        pass
    return url


def fetch_html(url):
    """抓取网页 HTML（模拟移动浏览器 UA；公众号文章对桌面 UA 会返回验证页）。"""
    req = urllib.request.Request(url, headers={
        "User-Agent": FETCH_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            ctype = (resp.headers.get("Content-Type") or "").lower()
            raw = resp.read(FETCH_MAX_BYTES + 1)
    except ApiError:
        raise
    except Exception:
        raise ApiError(502, "抓取失败：链接无法访问或超时")
    if len(raw) > FETCH_MAX_BYTES:
        raise ApiError(413, "页面过大，无法抓取")
    if "html" not in ctype and "xml" not in ctype and "text" not in ctype and b"<html" not in raw[:2000].lower():
        raise ApiError(400, "该链接不是网页，仅支持网页内容抓取")
    charset = "utf-8"
    m = re.search(r"charset=([\w-]+)", ctype)
    if not m:
        m = re.search(rb'charset=["\']?([\w-]+)', raw[:2048], re.I)
        if m:
            charset = m.group(1).decode("ascii", "ignore")
    try:
        return raw.decode(charset, "replace")
    except LookupError:
        return raw.decode("utf-8", "replace")


class PageExtractor(HTMLParser):
    """提取网页正文文本行与图片地址。

    正文定位：优先取微信 #js_content、article、id/class 含 article/content/main
    等特征的容器；取不到足够内容时退回全文。文本按块级元素切行，保留原文标点。
    """

    SKIP_TAGS = {"script", "style", "noscript", "svg", "iframe", "canvas", "template", "select", "button", "textarea", "form"}
    BLOCK_TAGS = {"p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr",
                  "section", "article", "blockquote", "figcaption", "pre", "header",
                  "footer", "ul", "ol", "table", "dl", "dt", "dd", "aside", "nav", "hr", "figure", "address"}
    MAIN_HINT = re.compile(r"js_content|rich_media_content|post[-_]?(body|content)|entry[-_]content|article[-_]?(body|content)|(^|[^\w])(main|content|article)([^\w]|$)", re.I)
    DECOR_SRC = re.compile(r"(sprite|icon|logo|avatar|blank|spacer|loading|\.svg($|\?)|\.ico($|\?))", re.I)

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.all_lines = []
        self.main_lines = []
        self.images = []
        self.title = ""
        self._skip = 0
        self._buf = []
        self._main_buf = []
        self._main_stack = []  # 开启了 main 区域的 tag 栈

    # -- 行缓冲 --
    def _flush(self):
        text = "".join(self._buf).strip()
        self._buf = []
        if text:
            self.all_lines.append(text)
        if self._main_stack:
            text_main = "".join(self._main_buf).strip()
            self._main_buf = []
            if text_main:
                self.main_lines.append(text_main)
        else:
            self._main_buf = []

    def _maybe_enter_main(self, tag, attrs):
        a = dict(attrs)
        ident = " ".join(filter(None, [a.get("id"), a.get("class")]))
        if tag == "article" or self.MAIN_HINT.search(ident):
            self._main_stack.append(tag)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta" and (a.get("property") or "") == "og:title" and (a.get("content") or "").strip():
            self.title = self.title or a["content"].strip()
            return
        if tag in self.SKIP_TAGS:
            self._skip += 1
            return
        if self._skip:
            return
        if tag == "img":
            src = a.get("src") or a.get("data-src") or a.get("data-lazy-src") or a.get("data-original") or ""
            if src and not src.startswith("data:"):
                self.images.append(src)
            return
        self._maybe_enter_main(tag, attrs)
        if tag in self.BLOCK_TAGS:
            self._flush()

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS:
            if self._skip:
                self._skip -= 1
            return
        if self._main_stack and self._main_stack[-1] == tag:
            self._main_stack.pop()
            self._flush()
        elif tag in self.BLOCK_TAGS:
            self._flush()

    def handle_data(self, data):
        if self._skip:
            return
        text = data.strip()
        if not text:
            return
        self._buf.append(text)
        if self._main_stack:
            self._main_buf.append(text)

    def handle_startendtag(self, tag, attrs):
        if tag == "img" and not self._skip:
            a = dict(attrs)
            src = a.get("src") or a.get("data-src") or a.get("data-lazy-src") or a.get("data-original") or ""
            if src and not src.startswith("data:"):
                self.images.append(src)
        elif tag in self.BLOCK_TAGS and not self._skip:
            self._flush()


def _clean_lines(raw_lines, limit=400):
    """按行清洗：去首尾空白、丢过短行、保序去重。不做改写，尊重原文标点。"""
    out, seen = [], set()
    for line in raw_lines:
        line = line.strip()
        if len(line) < 2:
            continue
        if line in seen:
            continue
        seen.add(line)
        out.append(line[:600])
        if len(out) >= limit:
            break
    return out


def _normalize_images(raw_srcs, base_url, limit=24):
    """图片地址绝对化 + 去重 + 过滤装饰图。"""
    out, seen = [], set()
    for src in raw_srcs:
        src = src.strip()
        if src.startswith("//"):
            src = "https:" + src
        elif src and not src.lower().startswith(("http://", "https://")):
            try:
                src = urllib.parse.urljoin(base_url, src)
            except Exception:
                continue
        if not src.lower().startswith(("http://", "https://")):
            continue
        if PageExtractor.DECOR_SRC.search(src):
            continue
        if src in seen:
            continue
        seen.add(src)
        out.append(src)
        if len(out) >= limit:
            break
    return out


def extract_page(html_text, base_url):
    parser = PageExtractor()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:
        pass
    lines = _clean_lines(parser.main_lines if len(parser.main_lines) >= 3 else parser.all_lines)
    images = _normalize_images(parser.images, base_url)
    if not parser.title:
        m = re.search(r"<h1[^>]*>(.*?)</h1>", html_text, re.S | re.I)
        if m:
            parser.title = re.sub(r"<[^>]+>", "", m.group(1)).strip()
    return parser.title[:150], lines, images


# ---------------------------------------------------------------------------
# 社交平台分享链接：小红书 / 抖音 / 快手
# 这些站点正文由 JS 渲染且有登录/签名校验，常规 HTML 抓取拿不到正文。
# 策略：识别平台 → 尝试从内嵌 JSON / meta 里挖出文案 → 挖不到则返回带平台专属
# 操作指引的结构化错误，引导用户用「复制分享文本」或「图片 OCR」导入。
# ---------------------------------------------------------------------------

SOCIAL_PLATFORMS = (
    ("xiaohongshu", ("xiaohongshu.com", "xhslink.com"), "小红书"),
    ("douyin", ("douyin.com", "iesdouyin.com", "snssdk.com"), "抖音"),
    ("kuaishou", ("kuaishou.com", "gifshow.com", "v.kuaishou.com"), "快手"),
)

# 各平台「复制链接后如何拿到文字」的专属指引
SOCIAL_HINTS = {
    "xiaohongshu": (
        "小红书正文受登录保护，直接抓链接拿不到文字。请在小红书 App 打开笔记 → 点分享 →「复制链接」，"
        "然后把复制到的整段文字（含标题和正文，不只是网址）粘贴到下方输入框，我会自动拆成文案；"
        "或把笔记图片存到相册，用「批量上传 → 图片识别」提取文字。"
    ),
    "douyin": (
        "抖音文案需要登录且正文由脚本渲染，直接抓链接拿不到文字。请在抖音 App 打开视频/图文 → 分享 →「复制链接」，"
        "把复制到的整段文字粘贴到下方输入框自动提取；或直接把视频封面/图文存成图片，"
        "用「批量上传 → 图片识别」提取文字。"
    ),
    "kuaishou": (
        "快手文案需要登录，直接抓链接拿不到文字。请在快手 App 打开作品 → 分享 →「复制链接」，"
        "把复制到的整段文字粘贴到下方输入框自动提取；或把作品图片存到相册，"
        "用「批量上传 → 图片识别」提取文字。"
    ),
}


def detect_social_platform(url):
    """返回 (平台key, 平台中文名)；不是三大平台则返回 (None, None)。"""
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except Exception:
        return None, None
    for key, domains, label in SOCIAL_PLATFORMS:
        for d in domains:
            if host == d or host.endswith("." + d):
                return key, label
    return None, None


def _decode_embedded_json(fragment):
    """页面内嵌 JSON 常见两种形态：明文、URL 编码。尽力还原成文本。"""
    out = fragment
    try:
        # 抖音 RENDER_DATA 常是 encodeURIComponent 后的 JSON
        if "%7B" in fragment or "%22" in fragment:
            out = urllib.parse.unquote(fragment)
    except Exception:
        out = fragment
    return out


def extract_social_lines(html_text):
    """从社交平台页面的 meta 标签与内嵌 JSON 中尽力挖出文案行。

    返回按出现顺序去重的字符串列表；拿不到则返回空列表。
    仅做保守提取，不改写原文。
    """
    found = []

    def add(text):
        if not isinstance(text, str):
            return
        text = re.sub(r"\s+", " ", text).strip().strip('"\'')
        # 去掉明显的 JSON 噪声与标签
        text = re.sub(r"<[^>]+>", "", text).strip()
        if len(text) >= 2 and len(text) <= 600 and text not in found:
            found.append(text)

    decoded = _decode_embedded_json(html_text)

    # 1) meta 描述 / 标题（og:title, og:description, twitter:description, description）
    meta_pat = re.compile(
        r'<meta[^>]+?(?:property|name)\s*=\s*["\'](og:title|og:description|twitter:description|description|title)["\'][^>]*?content\s*=\s*["\']([^"\']+)["\']',
        re.I,
    )
    for _key, val in meta_pat.findall(html_text):
        add(val)

    # 2) 内嵌 JSON 常见文案字段：desc / description / title / content / text
    for key in ("desc", "description", "content", "title", "text", "caption"):
        for m in re.finditer(r'["\']' + key + r'["\']\s*:\s*["\']((?:[^"\'\\]|\\.){2,600})["\']', decoded):
            val = m.group(1)
            try:
                val = json.loads('"' + val.replace('"', '\\"') + '"')
            except Exception:
                pass
            add(val)
        if len(found) >= 40:
            break

    # platform 页面常见噪声：纯数字/符号、UI 词、以及「仅支持在 App 内查看」这类壳页提示
    noise = re.compile(
        r"^(下载|打开App|APP内打开|App内打开|复制链接|分享|关注|点赞|评论|收藏|更多|登录|注册|首页|发现|我的|小红书|抖音|快手|[\d\W]+)$"
        r"|仅支持在.{0,10}(APP|App|app).{0,6}查看|在.{0,8}(APP|App|app)内打开"
    )
    return [line for line in found if not noise.search(line)][:60]


def is_social_shell_line(line):
    """判断是否为社交平台壳页的无意义提示文案（非正文）。"""
    s = line.strip()
    if len(s) < 2:
        return True
    shell_patterns = (
        r"^(小红书|抖音|快手)$",
        r"(APP|App|app)内打开",
        r"仅支持在.{0,12}查看",
        r"^(打开|下载).{0,6}(APP|App|app)$",
        r"复制链接|长按识别|扫码",
        r"^[\d\W]+$",
    )
    return any(re.search(p, s) for p in shell_patterns)


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
        # 邮箱改为可选：未提供时用用户名派生唯一占位邮箱，满足 email 列的 NOT NULL UNIQUE 约束。
        # 用户名本身已强制唯一（3–20 位字母数字下划线），派生出的占位邮箱天然不会撞车。
        raw_email = body.get("email")
        email_provided = isinstance(raw_email, str) and bool(raw_email.strip())
        email = validate_email(raw_email) if email_provided else f"{username.lower()}@noemail.local"
        password = body.get("password")
        if not isinstance(password, str) or len(password) < 6:
            raise ApiError(400, "密码至少需要 6 位")
        display_name = clean_text(body.get("displayName") or username, "昵称", max_len=40) or username
        if conn.execute("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE", (username, email)).fetchone():
            raise ApiError(409, "用户名或邮箱已被注册" if email_provided else "用户名已被注册")
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
        token = request_token(handler)
        if token:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
        return 200, {"ok": True}

    # ---- 修改密码 ----
    if method == "POST" and path == "/api/auth/change-password":
        me = require_auth(handler, conn)
        body = read_body(handler)
        old_password = str(body.get("oldPassword") or "")
        new_password = body.get("newPassword")
        row = conn.execute("SELECT * FROM users WHERE id = ?", (me["id"],)).fetchone()
        if not row or not verify_password(old_password, row["password_hash"]):
            raise ApiError(400, "当前密码不正确")
        if not isinstance(new_password, str) or len(new_password) < 6:
            raise ApiError(400, "新密码至少需要 6 位")
        if new_password == old_password:
            raise ApiError(400, "新密码不能与当前密码相同")
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(new_password), me["id"]))
        # 改密后其他设备的会话全部失效；当前设备换发新令牌，避免自己被踢下线。
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (me["id"],))
        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token_hash(token), me["id"], now_iso(), now_iso(30)),
        )
        return 200, {"ok": True, "token": token}

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
        group = clean_text(body.get("group") or "自定义", "分组", max_len=30).strip() or "自定义"
        if conn.execute("SELECT 1 FROM categories WHERE user_id = ? AND name = ?", (me["id"], name)).fetchone():
            raise ApiError(409, "分类名称已存在")
        if "sortOrder" in body:
            try:
                order = int(body["sortOrder"])
            except (TypeError, ValueError):
                order = conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM categories WHERE user_id = ?", (me["id"],)).fetchone()["n"]
        else:
            order = conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM categories WHERE user_id = ?", (me["id"],)).fetchone()["n"]
        cur = conn.execute(
            "INSERT INTO categories (user_id, name, group_name, color, sort_order, is_default, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
            (me["id"], name, group, color, order, now_iso()),
        )
        return 201, {"id": cur.lastrowid, "name": name, "color": color, "group": group, "count": 0}

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
        group = row["group_name"]
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
        if "group" in body:
            group = clean_text(body["group"], "分组", max_len=30).strip() or "自定义"
        if "sortOrder" in body:
            try:
                sort_order = int(body["sortOrder"])
            except (TypeError, ValueError):
                raise ApiError(400, "排序值不正确")
        conn.execute("UPDATE categories SET name = ?, color = ?, group_name = ?, sort_order = ? WHERE id = ?", (name, color, group, sort_order, cid))
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

    # ---- 批量上传（跳过重复，只导入剩余文案） ----
    if path == "/api/copies/batch" and method == "POST":
        me = require_auth(handler, conn)
        body = read_body(handler)
        raw_items = body.get("items") or []
        if not isinstance(raw_items, list) or not raw_items:
            raise ApiError(400, "没有可导入的文案")
        if len(raw_items) > 200:
            raise ApiError(400, "单次最多导入 200 条")
        global_cids = resolve_category_ids(conn, me["id"], body.get("categoryIds"))
        # 与 check-duplicates 保持一致：按原文精确比对，不做 trim / 改写
        known = {r["content"] for r in conn.execute(
            "SELECT content FROM copies WHERE user_id = ?", (me["id"],)
        )}
        ts = now_iso()
        created = []
        skipped = 0
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            content = clean_text(item.get("content"), "文案正文", required=True)
            if content in known:
                skipped += 1
                continue
            known.add(content)  # 本次批次内部的重复同样跳过
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
        return 201, {"items": items, "count": len(items), "skipped": skipped}

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

    # ---- 示例文案库 ----
    if path == "/api/samples" and method == "GET":
        return 200, load_samples()

    if path == "/api/samples/seed" and method == "POST":
        me = require_auth(handler, conn)
        created, skipped = seed_sample_copies(conn, me["id"])
        return 200, {"ok": True, "created": created, "skipped": skipped}

    # ---- 链接导入：抓取网页文案与图片（登录用户） ----
    if path == "/api/fetch-url" and method == "POST":
        require_auth(handler, conn)
        body = read_body(handler)
        url = append_share_for_self(handler, validate_fetch_url(body.get("url")))
        # 站内页面直接读本地文件（服务端出站抓自身域名会被部署网关拦截）
        html_text = ""
        try:
            parsed = urllib.parse.urlparse(url)
            candidate = (PUBLIC_DIR / parsed.path.lstrip("/")).resolve()
            candidate.relative_to(PUBLIC_DIR.resolve())
            if candidate.is_file() and candidate.suffix.lower() in (".html", ".htm"):
                html_text = candidate.read_text(encoding="utf-8", errors="replace")
        except Exception:
            html_text = ""
        if not html_text:
            html_text = fetch_html(url)
        title, lines, images = extract_page(html_text, url)

        # 小红书 / 抖音 / 快手：正文由 JS 渲染且有登录校验，常规提取常为空。
        # 先从 meta 与内嵌 JSON 里尽力挖文案；仍拿不到则返回平台专属操作指引。
        platform, platform_label = detect_social_platform(url)
        if platform:
            # 滤掉「App内打开 / 仅支持在App内查看」等壳页提示，避免误导入垃圾文案
            lines = [ln for ln in lines if not is_social_shell_line(ln)]
            if not lines:
                for s in extract_social_lines(html_text):
                    if s not in lines:
                        lines.append(s)
            if not lines and not images:
                raise ApiError(
                    422,
                    f"{platform_label}链接暂时取不到文字，请换用下面的方式导入",
                    {"socialPlatform": platform, "hint": SOCIAL_HINTS[platform]},
                )

        if not lines and not images:
            raise ApiError(422, "没有从该页面提取到内容，可能是纯图片页或需要登录的页面")
        return 200, {
            "url": url,
            "title": title,
            "lines": lines,
            "images": images,
            "lineCount": len(lines),
            "imageCount": len(images),
            "socialPlatform": platform,
        }

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
        for key, value in CORS_HEADERS.items():
            self.send_header(key, value)
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def serve_proxy_image(self, query, conn):
        require_auth(self, conn)
        raw = (query.get("url") or [""])[0]
        url = validate_fetch_url(raw)
        # 站内图片直接读本地静态文件：避免服务端出站抓取自身域名被部署网关拦下
        try:
            parsed = urllib.parse.urlparse(url)
            candidate = (PUBLIC_DIR / parsed.path.lstrip("/")).resolve()
            candidate.relative_to(PUBLIC_DIR.resolve())
            if candidate.is_file():
                data = candidate.read_bytes()
                ctype = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
                if ctype.startswith("image/"):
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "max-age=86400")
                    self.end_headers()
                    self.wfile.write(data)
                    return
        except ApiError:
            raise
        except Exception:
            pass
        req = urllib.request.Request(url, headers={"User-Agent": FETCH_UA})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                data = resp.read(PROXY_IMAGE_MAX_BYTES + 1)
        except ApiError:
            raise
        except Exception:
            raise ApiError(502, "图片拉取失败")
        if len(data) > PROXY_IMAGE_MAX_BYTES:
            raise ApiError(413, "图片过大")
        if not ctype.startswith("image/"):
            raise ApiError(400, "链接不是图片")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400")
        for key, value in CORS_HEADERS.items():
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
                if path == "/api/proxy-image":
                    # 图片代理：绕过第三方防盗链，供预览缩略图与 OCR 拉取
                    self.serve_proxy_image(query, conn)
                    return
                if method in ("POST", "PUT", "PATCH", "DELETE"):
                    if self.headers.get("X-Requested-With") != "XMLHttpRequest":
                        raise ApiError(403, "请求来源校验失败")
                status, payload = handle_api(self, method, path, query, conn)
                if isinstance(payload, dict) and "token" in payload:
                    # 同时返回给前端存为 Bearer Token：Cookie 跨站不可靠，Token 可让静态版共用账号
                    extra_headers["Set-Cookie"] = self.session_cookie(payload["token"])
                if path == "/api/auth/logout" and status == 200:
                    extra_headers["Set-Cookie"] = self.cleared_cookie()
                self.send_json(status, payload, extra_headers)
            except ApiError as exc:
                payload = {"error": exc.message}
                payload.update(exc.extra or {})
                self.send_json(exc.status, payload)
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
        # 前端模块更新频繁且体积小，统一 no-cache 避免发版后浏览器长时间停留在旧代码
        self.send_header("Cache-Control", "no-cache")
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

    def do_OPTIONS(self):
        # 静态版跨站调用 API 的预检请求；无需鉴权，直接放行
        if urllib.parse.urlparse(self.path).path.startswith("/api/"):
            self.send_response(204)
            for key, value in CORS_HEADERS.items():
                self.send_header(key, value)
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            self.send_error(405)


def main():
    init_db()
    conn = db_connect()
    try:
        seed_official_archive(conn)
    finally:
        conn.close()
    port = int(os.environ.get("PORT") or 8765)
    # 部署环境（容器 / 反向代理）需要绑定 0.0.0.0，本地默认仅回环
    host = os.environ.get("HOST") or ("0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print("COPY ARCHIVE running at http://{}:{}".format(host, port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
