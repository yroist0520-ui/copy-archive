/* COPY ARCHIVE — 核心层：API、路由、状态、UI 原语 */

import { localApi, setLocalMode, seedLocalSamples } from './local-api.js';

export const state = {
  user: null,
  categories: [],
  theme: 'paper',
  pageSize: 24,
  localMode: false,
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
 * 完整版（真实多人后端）入口。
 * 静态托管版本的文案数据只保存在当前浏览器里，无法被别人访问；
 * 「去公开档案」引导与本地版的分享提示都指向这个地址。
 * 换后端地址时只需要改这一处。
 */
export const FULL_VERSION_URL = 'https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host/?sharecode=HC3YZORW3G';

/** 应用内路径 → 浏览器可访问的完整路径 */
function appUrl(path) {
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
  setLocalMode(true);
  document.documentElement.dataset.mode = 'local';
  // 页脚的本地版说明只该在静态托管时出现，后端版始终隐藏
  const foot = document.querySelector('.mode-foot');
  if (foot) foot.hidden = false;
}

/* ---------------- API ---------------- */

export async function api(path, { method = 'GET', body, quiet = false } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  // 已经确认是纯静态托管，直接走本地实现
  if (state.localMode && path.startsWith('/api/')) {
    try {
      return await localApi(path, { method, body });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('操作失败');
      if (!quiet && error.status !== 404) toast(error.message, 'error');
      throw error;
    }
  }

  let response;
  try {
    response = await fetch(appUrl(path), options);
  } catch (err) {
    // 网络不可达：退化为本地模式，保证功能仍可使用
    if (path.startsWith('/api/')) {
      markLocalMode();
      try {
        return await localApi(path, { method, body });
      } catch (localErr) {
        const error = localErr instanceof Error ? localErr : new Error('操作失败');
        if (!quiet) toast(error.message, 'error');
        throw error;
      }
    }
    if (!quiet) toast('网络连接失败，请检查网络后重试', 'error');
    throw err;
  }

  // 静态托管下 /api/* 会命中 SPA 回退，返回 HTML 而非 JSON → 判定为无后端
  const contentType = response.headers.get('content-type') || '';
  if (path.startsWith('/api/') && !contentType.includes('application/json')) {
    markLocalMode();
    try {
      return await localApi(path, { method, body });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('操作失败');
      if (!quiet && error.status !== 404) toast(error.message, 'error');
      throw error;
    }
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { error: '服务器返回异常' };
  }
  if (!response.ok) {
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
  try {
    const data = await api('/api/auth/me', { quiet: true });
    state.user = data.user;
  } catch {
    state.user = null;
  }
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
];/** 切换主题并记忆 */
export function applyTheme(theme, { remember = true } = {}) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
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
      ${isLogin ? '' : `<div class="field"><label class="field-label" for="auth-email">邮箱</label><input class="input" id="auth-email" type="email" placeholder="you@example.com"></div>`}
      <div class="field">
        <label class="field-label" for="auth-pass">密码</label>
        <input class="input" id="auth-pass" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" placeholder="至少 6 位">
      </div>
      ${isLogin ? '' : `<div class="field"><label class="field-label" for="auth-name">显示昵称（选填）</label><input class="input" id="auth-name" placeholder="留空则使用用户名"></div>`}
      <p class="field-hint">${isLogin ? '登录后可使用全部管理功能。' : '注册即自动生成 30 个推荐分类，之后可自由管理。'}</p>
      <button class="link-btn auth-switch" style="margin-top:16px">${isLogin ? '还没有档案？注册 →' : '已有档案？返回登录 →'}</button>`;
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
              email: root.querySelector('#auth-email').value.trim(),
              password,
              displayName: root.querySelector('#auth-name').value.trim() || undefined,
            },
          });
        }
        await refreshSession();
        await loadCategories();
        close();
        toast(isLogin ? '欢迎回来' : '档案已建立，开始收集吧');
        renderRoute();
      } catch {
        // api 已提示
      } finally {
        button.disabled = false;
      }
    };
  };
  let close;
  close = openModal({
    kicker: 'ARCHIVE ACCESS',
    title: '登录档案',
    body: '<div class="auth-body"></div>',
    foot: '<button class="btn btn-sm btn-primary" data-submit>登录</button>',
    onMount(root) { render(initial, root); },
  });
}

export async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* 忽略 */ }
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
