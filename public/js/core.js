/* COPY ARCHIVE — 核心层：API、路由、状态、UI 原语 */

import { localApi, setLocalMode, seedLocalSamples, localArchiveInfo, checkLocalAccount } from './local-api.js';

export const state = {
  user: null,
  categories: [],
  theme: 'paper',
  pageSize: 24,
  localMode: false,   // 当前站点没有同源后端（GitHub Pages 静态版）
  cloudMode: false,   // 静态版默认连完整版云端 API，实现三端账号通用
  offlineMode: false, // 用户主动选择的本地离线档案（数据只在当前浏览器）
};

const app = document.getElementById('app');
const modalHost = document.getElementById('modal-host');
const toastHost = document.getElementById('toast-host');

/* ---------------- 部署基路径 ---------------- */

/**
 * 应用根路径。GitHub Pages 子路径部署时为 /copy-archive/，本地运行为 /。
 * 由模块自身地址推导，因此任何部署深度都能正确解析。
 */
export const BASE = new URL('../', import.meta.url).pathname;

const BASE_NO_SLASH = BASE === '/' ? '' : BASE.replace(/\/$/, '');

/**
 * 分享码。部分托管网关要求所有请求携带 sharecode 才能放行，
 * 一旦缺失，页面内部跳转与分享出去的链接都会失效。
 * 从当前地址读取后贯穿整个会话，所有生成的路径都会自动带上。
 */
export const SHARE_CODE = new URLSearchParams(location.search).get('sharecode') || '';

/**
 * 完整版（真实多人后端）入口，也是静态版默认连接的云端 API 地址。
 * 静态版与完整版共用账号数据；只有主动选择「本地离线体验」时才改用当前浏览器存储。
 * 换后端地址时只需要改这一处。
 */
export const FULL_VERSION_URL = 'https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host/?sharecode=HC3YZORW3G';

/**
 * 云端 API 地址。允许测试/临时部署通过 window.CA_CLOUD_URL 覆盖，
 * 默认就是完整版本地址，因此静态版注册登录后三端看到的是同一份数据。
 */
const CLOUD_URL = new URL(window.CA_CLOUD_URL || FULL_VERSION_URL);
const CLOUD_ORIGIN = CLOUD_URL.origin;
const CLOUD_SHARE = CLOUD_URL.searchParams.get('sharecode') || '';
const TOKEN_KEY = 'ca_cloud_token';

/** 登录令牌：同源用 Cookie，跨站静态版用 Bearer Token */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * 从本地离线档案切回云端账号。
 * 离线模式曾把账号写进浏览器自己的库，和云端是两套数据；
 * 清掉模式标记后刷新，用户用同一个账号密码登录即可看到云端（三端通用）档案。
 * 本地档案数据仍保留在浏览器，随时可用 ?local=1 再看。
 */
export function switchToCloud() {
  localStorage.removeItem('ca_entry_choice');
  localStorage.removeItem('ca_mode');
  sessionStorage.removeItem('ca_offline_session');
  clearToken();
  location.reload();
}

/** 静态版调用云端 API 的完整地址（自动带网关 sharecode） */
export function cloudApiUrl(path) {
  const url = new URL(path, `${CLOUD_ORIGIN}/`);
  if (CLOUD_SHARE && !url.searchParams.has('sharecode')) {
    url.searchParams.set('sharecode', CLOUD_SHARE);
  }
  return url.toString();
}

/** 应用内路径 → 浏览器可访问的完整路径 */
export function appUrl(path) {
  if (!path.startsWith('/')) return path;
  const base = `${BASE_NO_SLASH}${path}`;
  if (!SHARE_CODE || base.includes('sharecode=')) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}sharecode=${encodeURIComponent(SHARE_CODE)}`;
}

/** 浏览器路径 → 应用内路径 */
export function stripBase(pathname) {
  if (BASE_NO_SLASH && pathname.startsWith(BASE_NO_SLASH)) {
    const rest = pathname.slice(BASE_NO_SLASH.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return pathname;
}

/* ---------------- 后端探测 ---------------- */

/**
 * 判定当前部署形态。
 *
 * 不再用独立的健康探测接口，改为直接看真实请求的响应类型：
 * 纯静态托管（GitHub Pages）下 /api/* 返回的是 HTML 404，而真实后端始终返回 JSON。
 * 这样可避免「一次网络抖动就把整个会话误判成单机模式」——
 * 那会让用户以为注册成功，实际数据却只落在浏览器里。
 */

function markLocalMode() {
  if (state.localMode) return;
  state.localMode = true;
  // 只有用户主动选择「本地离线档案」或带 ?local=1 时才留在浏览器本地数据。
  // 静态深链会先经 404.html 跳回站点根，原始查询串暂存在 ca_redirect，这里要一并读取。
  const params = new URLSearchParams(location.search);
  const redirect = sessionStorage.getItem('ca_redirect') || '';
  if (redirect.includes('?')) {
    for (const [key, value] of new URLSearchParams(redirect.split('?')[1])) params.set(key, value);
  }
  // 核心原则：浏览器里已存在本地档案（账号或文案）时，默认进入本地模式。
  // 否则老用户的本地账号会被带到云端 → 账号密码错误、文案看起来不见了。
  // 只有全新浏览器、或用户明确选择云端/带 ?cloud=1 时才走云端账号体系。
  const localInfo = localArchiveInfo();
  const hasLocalArchive = localInfo.users > 0 || localInfo.copies > 0;
  const choice = localStorage.getItem('ca_entry_choice');
  const forcedCloud = params.get('cloud') === '1';
  const forcedOffline = !forcedCloud && (
    params.get('local') === '1'
    || sessionStorage.getItem('ca_offline_session') === '1'
    || choice === 'local'
    || hasLocalArchive  // 有本地档案数据：留在本地，保证老账号可登录、文案可见
  );
  state.offlineMode = forcedOffline;
  state.cloudMode = !forcedOffline;
  setLocalMode(state.offlineMode);
  document.documentElement.dataset.mode = state.offlineMode ? 'local' : 'cloud';
  // 页脚说明区分云端账号版 / 本地离线版
  const foot = document.querySelector('.mode-foot');
  if (foot) {
    foot.hidden = false;
    foot.textContent = state.offlineMode
      ? '本地离线档案 · 数据只保存在当前浏览器'
      : '静态托管版本 · 与完整版共用云端账号，三端通用';
  }
}

/* ---------------- API ---------------- */

export async function api(path, { method = 'GET', body, quiet = false } = {}) {
  const token = getToken();
  const options = {
    method,
    // 云端跨站调用只用 Bearer Token，不依赖第三方 Cookie
    credentials: state.cloudMode ? 'omit' : 'same-origin',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  };
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
    // 部分部署网关会剥离标准鉴权头，但会透传自定义头，双写更稳
    options.headers['X-CA-Token'] = token;
  }
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  // 用户主动选择的本地离线档案：仍然使用浏览器本地数据
  if (state.offlineMode && path.startsWith('/api/')) {
    try {
      return await localApi(path, { method, body });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('操作失败');
      if (!quiet && error.status !== 404) toast(error.message, 'error');
      throw error;
    }
  }

  const target = state.cloudMode && path.startsWith('/api/')
    ? cloudApiUrl(path)
    : appUrl(path);

  let response;
  try {
    response = await fetch(target, options);
  } catch (err) {
    // 首次请求才发现没有同源后端：识别后改走云端 API 重试一次
    if (path.startsWith('/api/') && !state.localMode) {
      markLocalMode();
      return api(path, { method, body, quiet });
    }
    if (!quiet) toast('网络连接失败，请检查网络后重试', 'error');
    throw err;
  }

  // 静态托管下同源 /api/* 会命中 SPA 回退，返回 HTML 而非 JSON → 切云端重试
  const contentType = response.headers.get('content-type') || '';
  if (path.startsWith('/api/') && !state.localMode && !contentType.includes('application/json')) {
    markLocalMode();
    return api(path, { method, body, quiet });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { error: '服务器返回异常' };
  }
  if (payload && typeof payload === 'object' && payload.token) {
    setToken(payload.token);
    delete payload.token;
  }
  if (!response.ok) {
    // 令牌失效时清掉本地凭证，让用户重新登录即可（换设备登录也走这里）
    if (response.status === 401 && token) clearToken();
    const error = new Error(payload.error || '操作失败');
    error.status = response.status;
    if (!quiet && response.status !== 404) toast(error.message, 'error');
    throw error;
  }
  return payload;
}

/* ---------------- 工具 ---------------- */

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

export function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  return withTime ? `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}` : base;
}

export function highlight(text, query) {
  const safe = esc(text);
  const words = (query || '').trim().split(/\s+/).filter((w) => w.length > 0);
  if (!words.length) return safe;
  let result = safe;
  for (const raw of words) {
    const word = esc(raw);
    if (!word) continue;
    const pattern = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(pattern, '<mark class="hit">$1</mark>');
  }
  return result;
}

export function padNum(n, width = 4) {
  return String(n).padStart(width, '0');
}

export function debounce(fn, wait = 220) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 走备用方案 */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function toast(message, kind = 'ok', ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 180ms';
    setTimeout(() => el.remove(), 200);
  }, ms);
}

/* ---------------- 弹层 ---------------- */

export function openModal({ kicker = '', title = '', body = '', foot = '', wide = false, onMount, closable = true }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <div>
          ${kicker ? `<div class="modal-kicker">${esc(kicker)}</div>` : ''}
          <h2 class="modal-title">${esc(title)}</h2>
        </div>
        <button class="modal-close" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </section>`;
  modalHost.appendChild(backdrop);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape' && closable) close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && closable) close(); });
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  if (onMount) onMount(backdrop, close);
  const first = backdrop.querySelector('input, textarea, button:not(.modal-close)');
  if (first) setTimeout(() => first.focus(), 60);
  return close;
}

export function confirmDialog(message, { title = '请确认', danger = true, okText = '确认' } = {}) {
  return new Promise((resolve) => {
    const close = openModal({
      kicker: danger ? 'IRREVERSIBLE ACTION' : 'CONFIRMATION',
      title,
      body: `<p style="font-size:.95rem;line-height:1.8">${esc(message)}</p>`,
      foot: `<button class="btn btn-sm" data-cancel>取消</button><button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText)}</button>`,
      onMount(root, dismiss) {
        root.querySelector('[data-cancel]').addEventListener('click', () => { dismiss(); resolve(false); });
        root.querySelector('[data-ok]').addEventListener('click', () => { dismiss(); resolve(true); });
      },
    });
    void close;
  });
}

/* ---------------- 会话 ---------------- */

export async function refreshSession() {
  let data = null;
  try {
    data = await api('/api/auth/me', { quiet: true });
    state.user = data.user || null;
  } catch {
    state.user = null;
  }
  // 云端令牌失效时后端返回 200 + user:null（不是 401），
  // 不清掉本地凭证就会一直卡在「看起来登录了、页面却提示登录」的状态。
  if (!state.user && data && state.cloudMode && getToken()) clearToken();
  // 手动切换过的主题优先记忆，其次沿用账号保存的主题
  const saved = localStorage.getItem('ca_theme');
  state.theme = saved || (state.user && state.user.theme) || 'paper';
  document.documentElement.dataset.theme = state.theme;
  updateAuthButton();
}

/** 主题清单：纸白 / 墨黑 / 新闻纸 */
export const THEMES = [
  { id: 'paper', label: '纸白' },
  { id: 'ink', label: '墨黑' },
  { id: 'newsprint', label: '新闻纸' },
];/** 主题 → 系统 UI 颜色（浏览器栏 / PWA 状态栏沉浸色随主题走） */
const THEME_COLORS = { paper: '#F7F7F5', ink: '#1A1A1C', newsprint: '#F5F0E7' };

/** 切换主题并记忆 */
export function applyTheme(theme, { remember = true } = {}) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.paper);
  if (remember) localStorage.setItem('ca_theme', theme);
}

/** 读取示例文案库（public/samples.json） */
export async function loadSamples() {
  try {
    const res = await fetch(appUrl('/samples.json'), { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 为当前账号填充示例文案。
 * 服务器模式走后端接口，静态托管模式用本地适配层实现同一套语义：
 * 按分类名匹配、自动关联分类、打语种标签、相同文案跳过不重复导入。
 */
export async function seedSampleEntries() {
  if (state.localMode) {
    const library = await loadSamples();
    if (!library) throw new Error('示例文案库加载失败');
    return seedLocalSamples(library);
  }
  return api('/api/samples/seed', { method: 'POST', body: {} });
}

export function updateAuthButton() {
  const btn = document.getElementById('auth-btn');
  if (!btn) return;
  btn.textContent = state.user ? (state.user.displayName || state.user.username).slice(0, 8) : '登录';
  btn.classList.toggle('btn-primary', !state.user);
  btn.title = state.user ? '打开我的档案' : '登录 / 注册';
}

export function requireLogin() {
  if (state.user) return true;
  toast('请先登录后再操作', 'error');
  openAuth();
  return false;
}

export function openAuth(initial = 'login') {
  const render = (mode, root) => {
    const isLogin = mode === 'login';
    root.querySelector('.modal-kicker').textContent = isLogin ? 'WELCOME BACK' : 'CREATE YOUR ARCHIVE';
    root.querySelector('.modal-title').textContent = isLogin ? '登录档案' : '建立我的档案';
    root.querySelector('.auth-body').innerHTML = `
      <div class="field">
        <label class="field-label" for="auth-account">${isLogin ? '用户名 / 邮箱' : '用户名'}</label>
        <input class="input" id="auth-account" autocomplete="username" placeholder="${isLogin ? 'yourname' : '3–20 位字母数字下划线'}">
      </div>
      <div class="field">
        <label class="field-label" for="auth-pass">密码</label>
        <input class="input" id="auth-pass" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" placeholder="至少 6 位">
      </div>
      ${isLogin ? '' : `<div class="field"><label class="field-label" for="auth-name">显示昵称（选填）</label><input class="input" id="auth-name" placeholder="留空则使用用户名"></div>`}
      <p class="field-hint">${state.offlineMode
        ? '当前是本地离线档案：账号只在这台设备有效。完整版账号请先到「我的档案 → 切回云端账号」。'
        : (isLogin ? '登录后账号三端通用，可使用全部管理功能。' : '注册即自动生成 30 个推荐分类，之后可自由管理。')}</p>
      <button class="link-btn auth-switch" style="margin-top:16px">${isLogin ? '还没有档案？注册 →' : '已有档案？返回登录 →'}</button>
      <div style="margin-top:10px;font-size:12px"><a class="link-btn" href="./rescue.html">找不到原来的文案？打开数据救援 →</a></div>`;
    root.querySelector('.auth-switch').addEventListener('click', () => render(isLogin ? 'register' : 'login', root));
    root.querySelector('[data-submit]').textContent = isLogin ? '登录' : '创建档案';
    root.querySelector('[data-submit]').onclick = async () => {
      const account = root.querySelector('#auth-account').value.trim();
      const password = root.querySelector('#auth-pass').value;
      const button = root.querySelector('[data-submit]');
      button.disabled = true;
      try {
        if (isLogin) {
          await api('/api/auth/login', { method: 'POST', body: { account, password } });
        } else {
          await api('/api/auth/register', {
            method: 'POST',
            body: {
              username: account,
              password,
              displayName: root.querySelector('#auth-name').value.trim() || undefined,
            },
          });
        }
        await refreshSession();
        await loadCategories();
        close();
        toast(isLogin ? '欢迎回来' : '档案已建立，开始收集吧');
        // 首页、发现页或别人的公开档案页登录后，主动进入「我的档案」；
        // 否则页面只重绘当前路由，用户会误以为登录没生效。
        if (returnPath === '/' || returnPath === '/discover' || returnPath.startsWith('/u/')) {
          navigate('/profile');
        } else {
          renderRoute();
        }
      } catch {
        // 云端登录失败：若该账号密码其实属于浏览器本地档案，给出一键切换入口。
        // 老用户曾把文案存在本地，升级到云端默认模式后会在这里卡住。
        if (isLogin && state.cloudMode && account && password) {
          const info = await checkLocalAccount(account, password);
          if (info.matched) {
            const hint = document.createElement('div');
            hint.className = 'notice';
            hint.style.marginTop = '14px';
            hint.innerHTML = `这个账号在你<strong>当前浏览器的本地档案</strong>里（${info.copies} 条文案）。云端没有它，所以登录失败。`
              + ' <button class="link-btn" id="auth-use-local">进入本地档案 →</button>';
            const body = root.querySelector('.auth-body');
            const older = body.querySelector('#local-login-hint');
            if (older) older.remove();
            hint.id = 'local-login-hint';
            body.appendChild(hint);
            hint.querySelector('#auth-use-local').addEventListener('click', async () => {
              await localApi('/api/auth/login', { method: 'POST', body: { account, password } });
              state.offlineMode = true;
              state.cloudMode = false;
              state.localMode = true;
              setLocalMode(true);
              document.documentElement.dataset.mode = 'local';
              await refreshSession();
              await loadCategories();
              close();
              toast('已进入本地档案，文案都还在');
              navigate('/profile');
            });
          }
        }
      } finally {
        button.disabled = false;
      }
    };
  };
  const returnPath = stripBase(location.pathname);
  let close;
  close = openModal({
    kicker: 'ARCHIVE ACCESS',
    title: '登录档案',
    body: '<div class="auth-body"></div>',
    foot: '<button class="btn btn-sm btn-primary" data-submit>登录</button>',
    onMount(root) { render(initial, root); },
  });
}

/**
 * 修改密码：校验旧密码后换发令牌。
 * 服务端会作废旧令牌（其他设备需重新登录），api() 自动保存新令牌，
 * 因此当前设备不会掉线。
 */
export function openChangePassword() {
  openModal({
    kicker: 'SECURITY',
    title: '修改密码',
    body: `
      <div class="field"><label class="field-label" for="pw-old">当前密码</label>
        <input class="input" id="pw-old" type="password" autocomplete="current-password" placeholder="输入现在的密码"></div>
      <div class="field"><label class="field-label" for="pw-new">新密码</label>
        <input class="input" id="pw-new" type="password" autocomplete="new-password" placeholder="至少 6 位"></div>
      <div class="field"><label class="field-label" for="pw-confirm">确认新密码</label>
        <input class="input" id="pw-confirm" type="password" autocomplete="new-password" placeholder="再输入一次新密码"></div>
      <p class="field-hint">修改成功后，其他设备需要用新密码重新登录；当前设备保持登录。</p>`,
    foot: '<button class="btn btn-sm" data-cancel>取消</button><button class="btn btn-sm btn-primary" data-submit>确认修改</button>',
    onMount(root, close) {
      root.querySelector('[data-cancel]').addEventListener('click', close);
      root.querySelector('[data-submit]').addEventListener('click', async (e) => {
        const oldPassword = root.querySelector('#pw-old').value;
        const newPassword = root.querySelector('#pw-new').value;
        const confirm = root.querySelector('#pw-confirm').value;
        if (newPassword.length < 6) { toast('新密码至少需要 6 位', 'error'); return; }
        if (newPassword !== confirm) { toast('两次输入的新密码不一致', 'error'); return; }
        e.target.disabled = true;
        try {
          await api('/api/auth/change-password', { method: 'POST', body: { oldPassword, newPassword } });
          close();
          toast('密码已修改，其他设备请重新登录');
        } catch { /* api 已提示 */ } finally { e.target.disabled = false; }
      });
    },
  });
}

export async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* 忽略 */ }
  clearToken();
  state.user = null;
  updateAuthButton();
  toast('已退出登录');
  navigate('/');
}

/* ---------------- 分类缓存 ---------------- */

export async function loadCategories() {
  if (!state.user) { state.categories = []; return []; }
  try {
    const data = await api('/api/categories', { quiet: true });
    state.categories = data.items;
  } catch {
    state.categories = [];
  }
  return state.categories;
}

export function categoryById(id) {
  return state.categories.find((c) => c.id === Number(id));
}

/* ---------------- 路由 ---------------- */

const routes = [];
export function route(pattern, handler) { routes.push({ pattern, handler }); }

export function navigate(path, replace = false) {
  const url = path.startsWith('/') ? appUrl(path) : path;
  if (replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  renderRoute();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

export function currentQuery() {
  return new URLSearchParams(location.search);
}

export async function renderRoute() {
  const path = stripBase(location.pathname);
  document.querySelectorAll('.nav-link').forEach((a) => {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href !== '/' ? path.startsWith(href) : path === '/');
  });
  const mobile = document.getElementById('mobile-nav');
  if (mobile) mobile.hidden = true;
  const toggle = document.getElementById('mobile-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');

  for (const item of routes) {
    const match = path.match(item.pattern);
    if (match) {
      app.innerHTML = '<div class="container" style="padding-top:80px"><div class="skeleton"></div></div>';
      try {
        await item.handler({ params: match.slice(1), query: currentQuery(), app });
      } catch (err) {
        app.innerHTML = `<div class="container section"><div class="empty">
          <div class="empty-code">ERROR / 500</div>
          <h1 class="empty-title">页面未能加载</h1>
          <p class="empty-desc">${esc(err.message || '未知错误')}</p>
          <button class="btn btn-sm" onclick="location.reload()">重新加载</button>
        </div></div>`;
      }
      observeReveals();
      return;
    }
  }
  app.innerHTML = `<div class="container section"><div class="empty">
    <div class="empty-code">404 / NOT FOUND</div>
    <h1 class="empty-title">这里没有档案</h1>
    <p class="empty-desc">链接可能已失效，或档案未被公开。</p>
    <a class="btn btn-sm" href="/" data-link>返回首页</a>
  </div></div>`;
}

export function observeReveals() {
  const items = app.querySelectorAll('.reveal:not(.is-in)');
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08, rootMargin: '0px 0px 40px 0px' });
  items.forEach((el) => observer.observe(el));
}

/* ---------------- 通用事件绑定 ---------------- */

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-link]');
  if (link && link.origin === location.origin) {
    e.preventDefault();
    navigate(stripBase(link.pathname) + link.search + link.hash);
  }
});

window.addEventListener('popstate', renderRoute);

export function initCore() {
  document.getElementById('year').textContent = new Date().getFullYear();
  document.getElementById('auth-btn').addEventListener('click', () => {
    if (state.user) navigate('/profile');
    else openAuth();
  });
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme || 'paper';
      const index = THEMES.findIndex((t) => t.id === current);
      const next = THEMES[(index + 1) % THEMES.length];
      applyTheme(next.id);
      toast(`已切换到${next.label}主题`);
    });
  }
  const toggle = document.getElementById('mobile-toggle');
  const mobileNav = document.getElementById('mobile-nav');
  toggle.addEventListener('click', () => {
    mobileNav.hidden = !mobileNav.hidden;
    toggle.setAttribute('aria-expanded', String(!mobileNav.hidden));
  });
  document.getElementById('global-search').addEventListener('click', () => {
    navigate('/archive?focus=1');
    setTimeout(() => document.getElementById('archive-search')?.focus(), 200);
  });
}
