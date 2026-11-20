/* COPY ARCHIVE — 本地模式适配层
 *
 * GitHub Pages 只能托管静态文件，无法运行 Python 后端。本模块在前端检测到
 * /api 不可用时启用，用 localStorage 复刻 server.py 的同一套 API 契约，
 * 使静态托管版本仍然是一个可完整操作的档案馆。
 *
 * 与后端保持一致的语义：
 *   · 账号数据按 userId 隔离，跨账号读写一律 404
 *   · 分类与文案多对多关联，联合主键去重
 *   · 三档隐私 public / partial / private，公开入口按服务端同款规则过滤
 *   · 收藏独立存储，复制只累加计数不改内容
 *   · 文案正文原样保存，不做任何标点、空格、Unicode 改写
 *
 * 界面会持续显示「本地模式」标识，明确数据仅保存在当前浏览器。
 */

const DB_KEY = 'ca_local_db_v1';
const SESSION_KEY = 'ca_local_session';

const DEFAULT_CATEGORIES = [
  ['风格类', ['INS', '韩系', '暗黑', '怪诞', '古风', '少女', '可爱', '萌物', '复古', '清冷', '高级感', '治愈', '赛博朋克', '哥特']],
  ['用途类', ['短句', '水印', '亮晶晶', '实拍', '朋友圈', '个性签名', '社交媒体', '图片配文', '海报文案', '英文排版']],
  ['其他类', ['情绪表达', '节日', '爱情', '友情', '日常', '文字素材']],
];

const GROUP_COLORS = { '风格类': '#262521', '用途类': '#5a5750', '其他类': '#8c877d', '自定义': '#1a1917' };

/* ---------------- 错误类型 ---------------- */

export class LocalApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------------- 底层存储 ---------------- */

function emptyDb() {
  return {
    users: [],
    profiles: [],
    categories: [],
    copies: [],
    copyCategories: [],
    favorites: [],
    sessions: [],
    seq: { users: 0, categories: 0, copies: 0 },
  };
}

function readDb() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return emptyDb();
    const db = JSON.parse(raw);
    return { ...emptyDb(), ...db, seq: { ...emptyDb().seq, ...(db.seq || {}) } };
  } catch {
    return emptyDb();
  }
}

function writeDb(db) {
  // 必须同步落盘：注册/登录后紧接着的 /api/auth/me 会在同一轮微任务内读回，
  // 若延迟写入会导致会话查不到（微任务不会让出给定时器）。
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch (err) {
    console.warn('本地存储写入失败', err);
  }
}

function nowIso() {
  // 与后端 isoformat(timespec='seconds') 对齐
  return `${new Date().toISOString().slice(0, 19)}+00:00`;
}

/* ---------------- 密码哈希 ---------------- */

async function hashPassword(password, salt) {
  const raw = `${salt}::${password}`;
  if (window.crypto && window.crypto.subtle) {
    const bytes = new TextEncoder().encode(raw);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // 非安全上下文降级（仅本地演示模式）
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fallback_${h.toString(16)}`;
}

async function makeHash(password) {
  const salt = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${salt}$${await hashPassword(password, salt)}`;
}

async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, digest] = String(stored).split('$');
  if (!salt || !digest) return false;
  const actual = await hashPassword(password, salt);
  if (actual.length !== digest.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual.charCodeAt(i) ^ digest.charCodeAt(i);
  return diff === 0;
}

/* ---------------- 查询辅助 ---------------- */

function nextId(db, key) {
  db.seq[key] = (db.seq[key] || 0) + 1;
  return db.seq[key];
}

function findUser(db, id) {
  return db.users.find((u) => u.id === Number(id)) || null;
}

function findUserByName(db, name) {
  const key = String(name || '').toLowerCase();
  return db.users.find((u) => u.username.toLowerCase() === key) || null;
}

function getProfile(db, userId) {
  return db.profiles.find((p) => p.userId === Number(userId)) || null;
}

function categoriesOf(db, copyId) {
  const ids = db.copyCategories.filter((cc) => cc.copyId === Number(copyId)).map((cc) => cc.categoryId);
  return db.categories
    .filter((c) => ids.includes(c.id))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map((c) => ({ id: c.id, name: c.name, color: c.color, group: c.group }));
}

function serializeCopy(db, row, viewerId) {
  const item = {
    id: row.id,
    ownerId: row.userId,
    title: row.title,
    content: row.content,
    note: row.note,
    tags: Array.isArray(row.tags) ? row.tags : [],
    copyCount: row.copyCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isFavorite: viewerId
      ? db.favorites.some((f) => f.userId === Number(viewerId) && f.copyId === row.id)
      : false,
    categories: categoriesOf(db, row.id),
  };
  return item;
}

function publicCategoryIds(profile) {
  if (!profile) return [];
  if (profile.privacy === 'public') return null;
  if (profile.privacy === 'private') return [];
  return Array.isArray(profile.publicCategoryIds) ? profile.publicCategoryIds : [];
}

function visibleCopy(db, copyId, viewerId) {
  const row = db.copies.find((c) => c.id === Number(copyId));
  if (!row) return null;
  if (viewerId && row.userId === Number(viewerId)) return row;
  const profile = getProfile(db, row.userId);
  const allowed = publicCategoryIds(profile);
  if (allowed === null) return row;
  if (!allowed.length) return null;
  const ids = db.copyCategories.filter((cc) => cc.copyId === row.id).map((cc) => cc.categoryId);
  return ids.some((id) => allowed.includes(id)) ? row : null;
}

function seedDefaults(db, userId) {
  let order = 0;
  for (const [group, names] of DEFAULT_CATEGORIES) {
    for (const name of names) {
      order += 1;
      db.categories.push({
        id: nextId(db, 'categories'),
        userId,
        name,
        group,
        color: GROUP_COLORS[group],
        sortOrder: order,
        isDefault: true,
        createdAt: nowIso(),
      });
    }
  }
}

function resolveCategoryIds(db, userId, raw) {
  if (!Array.isArray(raw)) return [];
  const owned = db.categories.filter((c) => c.userId === Number(userId)).map((c) => c.id);
  const out = [];
  for (const v of raw) {
    const id = Number(v);
    if (owned.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function cleanText(value, label, { required = false, maxLen = 2000 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new LocalApiError(400, `${label}不能为空`);
    return '';
  }
  const text = String(value);
  if (required && !text.trim()) throw new LocalApiError(400, `${label}不能为空`);
  if (text.length > maxLen) throw new LocalApiError(400, `${label}过长`);
  return text;
}

function parseTags(raw) {
  if (Array.isArray(raw)) {
    const out = [];
    for (const t of raw) {
      const s = String(t ?? '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
    return out.slice(0, 20);
  }
  if (typeof raw === 'string') {
    const out = [];
    for (const t of raw.split(/[,，\s]+/)) {
      const s = t.trim();
      if (s && !out.includes(s)) out.push(s);
    }
    return out.slice(0, 20);
  }
  return [];
}

/* ---------------- 会话 ---------------- */

function currentSession(db) {
  const token = localStorage.getItem(SESSION_KEY);
  if (!token) return null;
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    db.sessions = db.sessions.filter((s) => s.token !== token);
    writeDb(db);
    return null;
  }
  return session;
}

function requireUser(db) {
  const session = currentSession(db);
  if (!session) throw new LocalApiError(401, '请先登录');
  const user = findUser(db, session.userId);
  if (!user) throw new LocalApiError(401, '请先登录');
  return user;
}

/* ---------------- 列表查询（对齐后端 list_copies） ---------------- */

function listCopies(db, viewerId, targetUserId, params) {
  const q = String(params.q || '').trim();
  const categoryIds = (String(params.category || '').match(/\d+/g) || []).map(Number).filter((n) => n > 0);
  const favoriteOnly = params.favorite === '1';
  const sort = params.sort || 'newest';
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 24));

  let rows = db.copies.filter((c) => c.userId === Number(targetUserId));

  if (q) {
    const keywords = q.split(/\s+/).filter(Boolean).slice(0, 8);
    const lower = q.toLowerCase();
    rows = rows.filter((row) => {
      const tagText = JSON.stringify(row.tags || []).toLowerCase();
      const catText = categoriesOf(db, row.id).map((c) => c.name).join(' ').toLowerCase();
      const haystack = `${row.content}\n${row.title}\n${row.note}\n${tagText}\n${catText}`.toLowerCase();
      return keywords.every((kw) => haystack.includes(kw.toLowerCase()));
    });
    void lower;
  }

  if (categoryIds.length) {
    rows = rows.filter((row) => {
      const ids = db.copyCategories.filter((cc) => cc.copyId === row.id).map((cc) => cc.categoryId);
      return categoryIds.some((cid) => ids.includes(cid));
    });
  }

  if (favoriteOnly && viewerId) {
    rows = rows.filter((row) => db.favorites.some((f) => f.userId === Number(viewerId) && f.copyId === row.id));
  }

  if (Number(viewerId) !== Number(targetUserId)) {
    const profile = getProfile(db, targetUserId);
    const allowed = publicCategoryIds(profile);
    if (allowed !== null) {
      if (!allowed.length) {
        return { items: [], total: 0, page, pageSize, hasMore: false };
      }
      rows = rows.filter((row) => {
        const ids = db.copyCategories.filter((cc) => cc.copyId === row.id).map((cc) => cc.categoryId);
        return ids.some((id) => allowed.includes(id));
      });
    }
  }

  const favCount = (row) => db.favorites.filter((f) => f.copyId === row.id).length;
  const sorted = [...rows];
  if (sort === 'oldest') {
    sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  } else if (sort === 'favorite') {
    sorted.sort((a, b) => favCount(b) - favCount(a) || b.createdAt.localeCompare(a.createdAt));
  } else if (sort === 'copies') {
    sorted.sort((a, b) => b.copyCount - a.copyCount || b.createdAt.localeCompare(a.createdAt));
  } else if (sort === 'random') {
    for (let i = sorted.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
    }
  } else {
    sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  }

  const total = sorted.length;
  const items = sorted.slice((page - 1) * pageSize, page * pageSize).map((row) => serializeCopy(db, row, viewerId));
  return { items, total, page, pageSize, hasMore: page * pageSize < total };
}

/* ---------------- 路由 ---------------- */

async function handle(db, method, path, query, body) {
  // ---- 健康检查 ----
  if (method === 'GET' && path === '/api/health') {
    return { ok: true, time: nowIso(), local: true };
  }

  // ---- 注册 ----
  if (method === 'POST' && path === '/api/auth/register') {
    const username = String(body.username || '').trim();
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      throw new LocalApiError(400, '用户名需为 3–20 位字母、数字或下划线');
    }
    // 邮箱改为可选：未提供时用用户名派生唯一占位邮箱，兼容已存用户。
    const rawEmail = String(body.email || '').trim();
    if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      throw new LocalApiError(400, '邮箱格式不正确');
    }
    const email = rawEmail || `${username.toLowerCase()}@noemail.local`;
    const password = String(body.password || '');
    if (password.length < 6) throw new LocalApiError(400, '密码至少需要 6 位');
    const displayName = cleanText(body.displayName || username, '昵称', { required: true, maxLen: 40 }).trim() || username;
    if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase()
      || (u.email || '').toLowerCase() === email.toLowerCase())) {
      throw new LocalApiError(409, rawEmail ? '用户名或邮箱已被注册' : '用户名已被注册');
    }
    const uid = nextId(db, 'users');
    db.users.push({
      id: uid,
      username,
      email,
      passwordHash: await makeHash(password),
      createdAt: nowIso(),
    });
    db.profiles.push({
      userId: uid,
      displayName,
      bio: '',
      avatarUrl: '',
      coverUrl: '',
      theme: 'paper',
      privacy: 'public',
      publicCategoryIds: [],
      createdAt: nowIso(),
    });
    seedDefaults(db, uid);
    const token = `local_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    db.sessions.push({ token, userId: uid, createdAt: nowIso(), expiresAt: new Date(Date.now() + 30 * 864e5).toISOString() });
    localStorage.setItem(SESSION_KEY, token);
    writeDb(db);
    return { user: { id: uid, username, email, displayName }, token };
  }

  // ---- 登录 ----
  if (method === 'POST' && path === '/api/auth/login') {
    const account = String(body.account || '').trim();
    const password = String(body.password || '');
    const user = findUserByName(db, account)
      || db.users.find((u) => (u.email || '').toLowerCase() === account.toLowerCase());
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new LocalApiError(401, '账号或密码不正确');
    }
    const token = `local_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    db.sessions.push({ token, userId: user.id, createdAt: nowIso(), expiresAt: new Date(Date.now() + 30 * 864e5).toISOString() });
    localStorage.setItem(SESSION_KEY, token);
    writeDb(db);
    const profile = getProfile(db, user.id);
    return { user: { id: user.id, username: user.username, email: user.email, displayName: profile.displayName }, token };
  }

  // ---- 退出 ----
  if (method === 'POST' && path === '/api/auth/logout') {
    const token = localStorage.getItem(SESSION_KEY);
    if (token) {
      db.sessions = db.sessions.filter((s) => s.token !== token);
      writeDb(db);
    }
    localStorage.removeItem(SESSION_KEY);
    return { ok: true };
  }

  // ---- 修改密码 ----
  if (method === 'POST' && path === '/api/auth/change-password') {
    const me = requireUser(db);
    const oldPassword = String(body.oldPassword || '');
    const newPassword = body.newPassword;
    if (!(await verifyPassword(oldPassword, me.passwordHash))) {
      throw new LocalApiError(400, '当前密码不正确');
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      throw new LocalApiError(400, '新密码至少需要 6 位');
    }
    if (newPassword === oldPassword) throw new LocalApiError(400, '新密码不能与当前密码相同');
    me.passwordHash = await makeHash(newPassword);
    // 与服务端一致：其他会话失效，当前设备换发令牌保持在线。
    db.sessions = db.sessions.filter((s) => s.userId !== me.id);
    const token = `local_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    db.sessions.push({ token, userId: me.id, createdAt: nowIso(), expiresAt: new Date(Date.now() + 30 * 864e5).toISOString() });
    localStorage.setItem(SESSION_KEY, token);
    writeDb(db);
    return { ok: true, token };
  }

  // ---- 当前用户 ----
  if (method === 'GET' && path === '/api/auth/me') {
    const session = currentSession(db);
    if (!session) return { user: null };
    const user = findUser(db, session.userId);
    if (!user) return { user: null };
    const profile = getProfile(db, user.id);
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: profile.displayName,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        coverUrl: profile.coverUrl,
        theme: profile.theme,
        privacy: profile.privacy,
        publicCategoryIds: profile.publicCategoryIds,
        createdAt: profile.createdAt,
      },
    };
  }

  // ---- 分类 ----
  if (path === '/api/categories' && method === 'GET') {
    const me = requireUser(db);
    const rows = db.categories.filter((c) => c.userId === me.id).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      group: r.group,
      color: r.color,
      sortOrder: r.sortOrder,
      isDefault: r.isDefault,
      count: db.copyCategories.filter((cc) => cc.categoryId === r.id).length,
    }));
    return { items };
  }

  if (path === '/api/categories' && method === 'POST') {
    const me = requireUser(db);
    const name = cleanText(body.name, '分类名称', { required: true, maxLen: 30 }).trim();
    const color = cleanText(body.color || '#1a1917', '颜色', { maxLen: 20 });
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new LocalApiError(400, '颜色需为 #RRGGBB 格式');
    if (db.categories.some((c) => c.userId === me.id && c.name === name)) {
      throw new LocalApiError(409, '分类名称已存在');
    }
    const order = Math.max(0, ...db.categories.filter((c) => c.userId === me.id).map((c) => c.sortOrder)) + 1;
    const id = nextId(db, 'categories');
    db.categories.push({
      id, userId: me.id, name, group: '自定义', color, sortOrder: order, isDefault: false, createdAt: nowIso(),
    });
    writeDb(db);
    return { id, name, color, group: '自定义', count: 0 };
  }

  let m = path.match(/^\/api\/categories\/(\d+)$/);
  if (m && (method === 'PATCH' || method === 'DELETE')) {
    const me = requireUser(db);
    const cid = Number(m[1]);
    const row = db.categories.find((c) => c.id === cid && c.userId === me.id);
    if (!row) throw new LocalApiError(404, '分类不存在');
    if (method === 'DELETE') {
      // 只解除关联，不删除任何文案
      db.copyCategories = db.copyCategories.filter((cc) => cc.categoryId !== cid);
      db.categories = db.categories.filter((c) => c.id !== cid);
      db.profiles.forEach((p) => {
        p.publicCategoryIds = (p.publicCategoryIds || []).filter((x) => x !== cid);
      });
      writeDb(db);
      return { ok: true, message: '分类已删除，文案已保留' };
    }
    let name = row.name;
    let color = row.color;
    let sortOrder = row.sortOrder;
    if ('name' in body) {
      name = cleanText(body.name, '分类名称', { required: true, maxLen: 30 }).trim();
      if (db.categories.some((c) => c.userId === me.id && c.name === name && c.id !== cid)) {
        throw new LocalApiError(409, '分类名称已存在');
      }
    }
    if ('color' in body) {
      color = cleanText(body.color, '颜色', { maxLen: 20 });
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new LocalApiError(400, '颜色需为 #RRGGBB 格式');
    }
    if ('sortOrder' in body) {
      sortOrder = Number(body.sortOrder) || 0;
    }
    row.name = name;
    row.color = color;
    row.sortOrder = sortOrder;
    writeDb(db);
    return { id: cid, name, color, sortOrder };
  }

  if (path === '/api/categories/reorder' && method === 'POST') {
    const me = requireUser(db);
    const ids = (body.ids || []).filter((x) => String(x).match(/^\d+$/)).map(Number);
    ids.forEach((cid, idx) => {
      const row = db.categories.find((c) => c.id === cid && c.userId === me.id);
      if (row) row.sortOrder = idx + 1;
    });
    writeDb(db);
    return { ok: true };
  }

  // ---- 文案查重 ----
  if (path === '/api/copies/check-duplicates' && method === 'POST') {
    const me = requireUser(db);
    const existing = {};
    (body.contents || []).slice(0, 200).forEach((text) => {
      if (typeof text !== 'string' || !text) return;
      const row = db.copies.find((c) => c.userId === me.id && c.content === text);
      if (row) existing[text] = row.id;
    });
    return { existing };
  }

  // ---- 链接导入（本地静态版）：通过 r.jina.ai 免代理抓取网页正文 ----
  // 完整版有服务端代理与 SSRF 防护；静态版没有后端，用公开转换服务兜底。
  if (path === '/api/fetch-url' && method === 'POST') {
    requireUser(db);
    let raw = String(body.url || '').trim();
    if (!raw) throw new LocalApiError(400, '请提供链接');
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    let target;
    try {
      const u = new URL(raw);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol');
      const host = u.hostname;
      if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[::1\])/.test(host)) {
        throw new Error('private');
      }
      target = u.toString();
    } catch {
      throw new LocalApiError(400, '请提供有效的 http(s) 链接');
    }
    let md = '';
    try {
      const res = await fetch(`https://r.jina.ai/${target}`, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(String(res.status));
      md = await res.text();
    } catch {
      throw new LocalApiError(502, '抓取失败：转换服务不可用或链接无法访问，建议使用完整版导入');
    }
    // r.jina.ai 返回 Markdown：标题摘出，正文按行清洗，图片从 ![](src) 提取
    const lines = [];
    const seen = new Set();
    let title = '';
    for (const rawLine of md.split(/\r?\n/)) {
      const line = rawLine.trim();
      const mTitle = line.match(/^title:\s*(.+)$/i);
      if (!title && mTitle) { title = mTitle[1].trim().slice(0, 150); continue; }
      if (/^(url:|markdown content:|---$)/i.test(line)) continue;
      if (/^!\[[^\]]*\]\(/.test(line)) continue;
      if (!line || line.length < 2) continue;
      const plain = line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
      if (plain.length < 2) continue;
      const key = plain.replace(/\s+/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(plain.slice(0, 600));
      if (lines.length >= 400) break;
    }
    const images = [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)]
      .map((m) => (m[1].startsWith('//') ? 'https:' + m[1] : m[1]))
      .filter((src) => /^https?:\/\//.test(src))
      .filter((src, i, arr) => arr.indexOf(src) === i)
      .slice(0, 24);
    if (!lines.length && !images.length) {
      throw new LocalApiError(422, '没有从该页面提取到内容，可能是纯图片页或需要登录的页面');
    }
    return { url: target, title, lines, images, lineCount: lines.length, imageCount: images.length };
  }

  // ---- 文案列表 ----
  if (path === '/api/copies' && method === 'GET') {
    const session = currentSession(db);
    if (!session) throw new LocalApiError(401, '请先登录');
    const viewerId = session.userId;
    let target = viewerId;
    if (query.owner) {
      const owner = findUserByName(db, query.owner);
      if (!owner) throw new LocalApiError(404, '用户不存在');
      target = owner.id;
    }
    return listCopies(db, viewerId, target, query);
  }

  // ---- 单条上传 ----
  if (path === '/api/copies' && method === 'POST') {
    const me = requireUser(db);
    const content = cleanText(body.content, '文案正文', { required: true });
    const title = cleanText(body.title, '标题', { maxLen: 120 });
    const note = cleanText(body.note, '备注', { maxLen: 2000 });
    const tags = parseTags(body.tags);
    const cids = resolveCategoryIds(db, me.id, body.categoryIds);
    const ts = nowIso();
    const id = nextId(db, 'copies');
    db.copies.push({
      id, userId: me.id, title, content, note, tags, copyCount: 0, createdAt: ts, updatedAt: ts,
    });
    cids.forEach((cid) => db.copyCategories.push({ copyId: id, categoryId: cid }));
    writeDb(db);
    return serializeCopy(db, db.copies.find((c) => c.id === id), me.id);
  }

  // ---- 批量上传（跳过重复，只导入剩余文案） ----
  if (path === '/api/copies/batch' && method === 'POST') {
    const me = requireUser(db);
    const rawItems = body.items || [];
    if (!Array.isArray(rawItems) || !rawItems.length) throw new LocalApiError(400, '没有可导入的文案');
    if (rawItems.length > 200) throw new LocalApiError(400, '单次最多导入 200 条');
    const globalCids = resolveCategoryIds(db, me.id, body.categoryIds);
    const known = new Set(db.copies.filter((c) => c.userId === me.id).map((c) => c.content));
    const ts = nowIso();
    const items = [];
    let skipped = 0;
    rawItems.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const content = cleanText(item.content, '文案正文', { required: true });
      if (known.has(content)) { skipped += 1; return; }
      known.add(content); // 本次批次内部的重复同样跳过
      const title = cleanText(item.title, '标题', { maxLen: 120 });
      const note = cleanText(item.note, '备注', { maxLen: 2000 });
      const tags = parseTags(item.tags);
      const cids = 'categoryIds' in item ? resolveCategoryIds(db, me.id, item.categoryIds) : globalCids;
      const id = nextId(db, 'copies');
      db.copies.push({
        id, userId: me.id, title, content, note, tags, copyCount: 0, createdAt: ts, updatedAt: ts,
      });
      cids.forEach((cid) => db.copyCategories.push({ copyId: id, categoryId: cid }));
      items.push(serializeCopy(db, db.copies.find((c) => c.id === id), me.id));
    });
    writeDb(db);
    return { items, count: items.length, skipped };
  }

  // ---- 单条文案 ----
  m = path.match(/^\/api\/copies\/(\d+)$/);
  if (m) {
    const me = requireUser(db);
    const cid = Number(m[1]);
    const row = db.copies.find((c) => c.id === cid && c.userId === me.id);
    if (!row) throw new LocalApiError(404, '文案不存在或无权访问');
    if (method === 'GET') return serializeCopy(db, row, me.id);
    if (method === 'PATCH') {
      const content = 'content' in body ? cleanText(body.content, '文案正文', { required: true }) : row.content;
      const title = cleanText(body.title === undefined ? row.title : body.title, '标题', { maxLen: 120 });
      const note = cleanText(body.note === undefined ? row.note : body.note, '备注', { maxLen: 2000 });
      const tags = 'tags' in body ? parseTags(body.tags) : row.tags;
      row.content = content;
      row.title = title;
      row.note = note;
      row.tags = tags;
      row.updatedAt = nowIso();
      if ('categoryIds' in body) {
        const cids = resolveCategoryIds(db, me.id, body.categoryIds);
        db.copyCategories = db.copyCategories.filter((cc) => cc.copyId !== cid);
        cids.forEach((x) => db.copyCategories.push({ copyId: cid, categoryId: x }));
      }
      writeDb(db);
      return serializeCopy(db, row, me.id);
    }
    if (method === 'DELETE') {
      db.copies = db.copies.filter((c) => c.id !== cid);
      db.copyCategories = db.copyCategories.filter((cc) => cc.copyId !== cid);
      db.favorites = db.favorites.filter((f) => f.copyId !== cid);
      writeDb(db);
      return { ok: true };
    }
  }

  // ---- 复制计数（公开访客也可） ----
  m = path.match(/^\/api\/copies\/(\d+)\/copy$/);
  if (m && method === 'POST') {
    const session = currentSession(db);
    const row = visibleCopy(db, Number(m[1]), session ? session.userId : null);
    if (!row) throw new LocalApiError(404, '文案不存在或无权访问');
    row.copyCount += 1;
    writeDb(db);
    return { ok: true, copyCount: row.copyCount };
  }

  // ---- 收藏 ----
  m = path.match(/^\/api\/copies\/(\d+)\/favorite$/);
  if (m && method === 'POST') {
    const me = requireUser(db);
    const cid = Number(m[1]);
    if (!visibleCopy(db, cid, me.id)) throw new LocalApiError(404, '文案不存在或无权访问');
    const wanted = Boolean(body.value);
    const idx = db.favorites.findIndex((f) => f.userId === me.id && f.copyId === cid);
    if (wanted && idx === -1) db.favorites.push({ userId: me.id, copyId: cid, createdAt: nowIso() });
    if (!wanted && idx !== -1) db.favorites.splice(idx, 1);
    writeDb(db);
    return { ok: true, isFavorite: wanted };
  }

  // ---- 批量管理 ----
  if (path === '/api/copies/bulk' && method === 'POST') {
    const me = requireUser(db);
    const ids = (body.ids || []).filter((x) => String(x).match(/^\d+$/)).map(Number);
    const action = body.action;
    if (!ids.length) throw new LocalApiError(400, '请先选择文案');
    if (ids.length > 200) throw new LocalApiError(400, '单次最多处理 200 条');
    const owned = ids.filter((id) => db.copies.some((c) => c.id === id && c.userId === me.id));
    if (action === 'delete') {
      db.copies = db.copies.filter((c) => !owned.includes(c.id));
      db.copyCategories = db.copyCategories.filter((cc) => !owned.includes(cc.copyId));
      db.favorites = db.favorites.filter((f) => !owned.includes(f.copyId));
      writeDb(db);
      return { ok: true, count: owned.length };
    }
    if (action === 'favorite' || action === 'unfavorite') {
      if (action === 'favorite') {
        ids.forEach((id) => {
          if (!db.favorites.some((f) => f.userId === me.id && f.copyId === id)) {
            db.favorites.push({ userId: me.id, copyId: id, createdAt: nowIso() });
          }
        });
      } else {
        db.favorites = db.favorites.filter((f) => !(f.userId === me.id && ids.includes(f.copyId)));
      }
      writeDb(db);
      return { ok: true, count: ids.length };
    }
    if (action === 'add_category' || action === 'remove_category') {
      const cids = resolveCategoryIds(db, me.id, body.categoryIds);
      if (!cids.length) throw new LocalApiError(400, '请选择分类');
      if (action === 'add_category') {
        owned.forEach((copyId) => cids.forEach((cid) => {
          if (!db.copyCategories.some((cc) => cc.copyId === copyId && cc.categoryId === cid)) {
            db.copyCategories.push({ copyId, categoryId: cid });
          }
        }));
      } else {
        db.copyCategories = db.copyCategories.filter(
          (cc) => !(owned.includes(cc.copyId) && cids.includes(cc.categoryId)),
        );
      }
      writeDb(db);
      return { ok: true, count: owned.length };
    }
    throw new LocalApiError(400, '未知操作');
  }

  // ---- 个人档案更新 ----
  if (path === '/api/profile' && method === 'PUT') {
    const me = requireUser(db);
    const profile = getProfile(db, me.id);
    const displayName = cleanText(body.displayName === undefined ? profile.displayName : body.displayName, '昵称', { required: true, maxLen: 40 });
    const bio = cleanText(body.bio === undefined ? profile.bio : body.bio, '简介', { maxLen: 500 });
    // 头像与封面为浏览器端压缩后的 data URL，容量远大于普通链接
    const avatarUrl = cleanText(body.avatarUrl === undefined ? profile.avatarUrl : body.avatarUrl, '头像', { maxLen: 400000 });
    const coverUrl = cleanText(body.coverUrl === undefined ? profile.coverUrl : body.coverUrl, '封面', { maxLen: 600000 });
    const theme = body.theme === undefined ? profile.theme : body.theme;
    if (!['paper', 'ink', 'newsprint'].includes(theme)) throw new LocalApiError(400, '主题不正确');
    const privacy = body.privacy === undefined ? profile.privacy : body.privacy;
    if (!['public', 'partial', 'private'].includes(privacy)) throw new LocalApiError(400, '隐私模式不正确');
    if ('publicCategoryIds' in body) {
      profile.publicCategoryIds = resolveCategoryIds(db, me.id, body.publicCategoryIds);
    }
    profile.displayName = displayName;
    profile.bio = bio;
    profile.avatarUrl = avatarUrl;
    profile.coverUrl = coverUrl;
    profile.theme = theme;
    profile.privacy = privacy;
    writeDb(db);
    return { ok: true };
  }

  // ---- 发现页 ----
  if (path === '/api/discover' && method === 'GET') {
    const session = currentSession(db);
    const viewerId = session ? session.userId : null;
    const archives = db.users
      .map((u) => {
        const profile = getProfile(db, u.id);
        if (!profile || profile.privacy === 'private') return null;
        return {
          id: u.id,
          username: u.username,
          display_name: profile.displayName,
          bio: profile.bio,
          avatar_url: profile.avatarUrl,
          privacy: profile.privacy,
          created_at: profile.createdAt,
          copy_count: db.copies.filter((c) => c.userId === u.id).length,
          category_count: db.categories.filter((c) => c.userId === u.id).length,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.copy_count - a.copy_count || a.id - b.id)
      .slice(0, 12);
    const q = String(query.q || '').trim().toLowerCase();
    const popular = db.copies
      .filter((c) => {
        const profile = getProfile(db, c.userId);
        const allowed = publicCategoryIds(profile);
        if (allowed !== null) {
          if (!allowed.length) return false;
          const ids = db.copyCategories.filter((cc) => cc.copyId === c.id).map((cc) => cc.categoryId);
          if (!ids.some((id) => allowed.includes(id))) return false;
        }
        if (!q) return true;
        const hay = `${c.content}\n${c.title}\n${JSON.stringify(c.tags || [])}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => b.copyCount - a.copyCount || b.id - a.id)
      .slice(0, 24)
      .map((row) => serializeCopy(db, row, viewerId));
    return { archives, popular };
  }

  // ---- 公开文案详情 ----
  m = path.match(/^\/api\/public\/copies\/(\d+)$/);
  if (m && method === 'GET') {
    const session = currentSession(db);
    const row = visibleCopy(db, Number(m[1]), session ? session.userId : null);
    if (!row) throw new LocalApiError(404, '文案不存在或未公开');
    return serializeCopy(db, row, session ? session.userId : null);
  }

  // ---- 公开档案 ----
  m = path.match(/^\/api\/public\/u\/([^/]+)$/);
  if (m && method === 'GET') {
    const owner = findUserByName(db, decodeURIComponent(m[1]));
    if (!owner) throw new LocalApiError(404, '档案不存在');
    const profile = getProfile(db, owner.id);
    if (!profile || profile.privacy === 'private') throw new LocalApiError(404, '该档案未公开');
    const allowed = publicCategoryIds(profile);
    let total = 0;
    let catTotal = 0;
    if (allowed === null) {
      total = db.copies.filter((c) => c.userId === owner.id).length;
      catTotal = db.categories.filter((c) => c.userId === owner.id).length;
    } else if (allowed.length) {
      const ids = new Set(allowed);
      total = db.copies.filter((c) => {
        if (c.userId !== owner.id) return false;
        const cids = db.copyCategories.filter((cc) => cc.copyId === c.id).map((cc) => cc.categoryId);
        return cids.some((id) => ids.has(id));
      }).length;
      catTotal = db.categories.filter((c) => c.userId === owner.id && ids.has(c.id)).length;
    }
    return {
      username: owner.username,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      coverUrl: profile.coverUrl,
      theme: profile.theme,
      privacy: profile.privacy,
      createdAt: profile.createdAt,
      copyCount: total,
      categoryCount: catTotal,
    };
  }

  m = path.match(/^\/api\/public\/u\/([^/]+)\/categories$/);
  if (m && method === 'GET') {
    const owner = findUserByName(db, decodeURIComponent(m[1]));
    if (!owner) throw new LocalApiError(404, '档案不存在');
    const profile = getProfile(db, owner.id);
    const allowed = publicCategoryIds(profile);
    if (allowed !== null && !allowed.length) return { items: [] };
    const rows = db.categories
      .filter((c) => c.userId === owner.id)
      .filter((c) => allowed === null || allowed.includes(c.id))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        group: r.group,
        count: db.copyCategories.filter((cc) => cc.categoryId === r.id).length,
      })),
    };
  }

  m = path.match(/^\/api\/public\/u\/([^/]+)\/copies$/);
  if (m && method === 'GET') {
    const owner = findUserByName(db, decodeURIComponent(m[1]));
    if (!owner) throw new LocalApiError(404, '档案不存在');
    const profile = getProfile(db, owner.id);
    if (!profile || profile.privacy === 'private') throw new LocalApiError(404, '该档案未公开');
    const session = currentSession(db);
    return listCopies(db, session ? session.userId : null, owner.id, query);
  }

  throw new LocalApiError(404, '接口不存在');
}

/* ---------------- 对外入口 ---------------- */

export function isLocalMode() {
  return localStorage.getItem('ca_mode') === 'local';
}

export function setLocalMode(flag) {
  localStorage.setItem('ca_mode', flag ? 'local' : 'server');
}

export function localUserCount() {
  return readDb().users.length;
}

/**
 * 执行一次本地 API 调用，契约与后端完全一致。
 * @param {string} fullPath 含查询串的完整路径，如 /api/copies?q=abc
 */
export async function localApi(fullPath, { method = 'GET', body } = {}) {
  const parsed = new URL(fullPath, location.origin);
  const path = decodeURIComponent(parsed.pathname);
  const query = {};
  parsed.searchParams.forEach((v, k) => { query[k] = v; });
  const db = readDb();
  const result = await handle(db, method, path, query, body || {});
  writeDb(db);
  return result;
}

/** 清空本地数据库（设置面板用） */
export function resetLocalDb() {
  localStorage.removeItem(DB_KEY);
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem('ca_mode');
}

/** 按文案语种自动打标签 */
function guessTags(text) {
  const tags = [];
  if (/[가-힣]/.test(text)) tags.push('韩文');
  if (/[一-鿿]/.test(text)) tags.push('中文');
  if (/[A-Za-z]/.test(text)) tags.push('英文');
  return tags;
}

/**
 * 用示例文案库填充当前用户的档案：按分类名匹配，自动关联分类并打语种标签。
 * 已存在的相同文案会被跳过，重复调用不会产生重复数据。
 * @param {object} library samples.json 的内容
 */
export function seedLocalSamples(library) {
  const db = readDb();
  const session = currentSession(db);
  if (!session) throw new LocalApiError(401, '请先登录');
  const uid = session.userId;

  const owned = {};
  db.categories.filter((c) => c.userId === uid).forEach((c) => { owned[c.name] = c.id; });
  const existing = new Set(db.copies.filter((c) => c.userId === uid).map((c) => c.content));

  let created = 0;
  let skipped = 0;
  let step = 0;
  const base = Date.now();
  for (const grp of (library && library.groups) || []) {
    for (const item of grp.items || []) {
      const cid = owned[item.name];
      if (!cid) continue;
      for (const text of item.texts || []) {
        if (!text || existing.has(text)) { skipped += 1; continue; }
        step += 1;
        const ts = new Date(base - step * 1000).toISOString().slice(0, 19) + '+00:00';
        const id = nextId(db, 'copies');
        db.copies.push({
          id, userId: uid, title: '', content: text, note: '',
          tags: guessTags(text), copyCount: 0, createdAt: ts, updatedAt: ts,
        });
        db.copyCategories.push({ copyId: id, categoryId: cid });
        existing.add(text);
        created += 1;
      }
    }
  }
  writeDb(db);
  return { ok: true, created, skipped };
}
