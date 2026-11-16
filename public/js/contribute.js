/* 投稿页：把本地/静态版档案的全部或部分文案带入完整版并公开，让所有人可搜索。
 * 数据通过 URL hash（#ct=<url-safe base64>）从静态版带过来，不经过服务器中转。 */
import {
  state, api, route, esc, toast, navigate, openAuth, renderRoute, refreshSession,
  FULL_VERSION_URL,
} from './core.js';
import { emptyState } from './ui.js';

const MAX_B64 = 600_000; // hash 体积保护

/* ---- 编解码（URL-safe base64，支持中文） ---- */

export function encodeContribution(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeContribution(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/* 静态版生成投稿链接用：完整版地址 + sharecode + hash 数据 */
export function buildContributeUrl(payload) {
  const target = new URL(FULL_VERSION_URL);
  return `${target.origin}/contribute${target.search}#ct=${encodeContribution(payload)}`;
}

function readPayloadFromHash() {
  const m = /(?:^|[#&])ct=([^&]+)/.exec(location.hash || '');
  if (!m) return null;
  try {
    const p = decodeContribution(m[1]);
    if (!p || !Array.isArray(p.entries)) return null;
    return p;
  } catch {
    return null;
  }
}

/* ---- 路由 ---- */

export function registerContribute() {
  route(/^\/contribute$/, async ({ app }) => {
    const payload = readPayloadFromHash();

    if (!payload) {
      app.innerHTML = `<div class="container section">
        <div class="section-head reveal"><span class="section-index">CONTRIBUTE</span><h1 class="section-title">投稿到公开档案</h1><span class="section-note">把你的档案全部或部分文案投稿到公开档案馆</span></div>
        <div class="notice reveal d1">在静态版「我的档案 → Share」点击 <strong>投稿到公开档案</strong>，勾选全部或部分分类后会生成一个投稿链接，打开它即可完成投稿。投稿后所有人都能在公开档案里搜到这些文案。</div>
        <div class="reveal d2" style="margin-top:20px"><a class="btn btn-sm" href="/discover" data-link>先去逛逛公开档案 ↗</a></div>
        <section class="section" style="margin-top:48px">
          <div class="section-head reveal"><span class="section-index">MANUAL</span><h2 class="section-title">手动粘贴投稿内容</h2><span class="section-note">链接失效时的兜底方式</span></div>
          <div class="field reveal d1"><textarea class="input" id="ct-paste" rows="5" placeholder="粘贴从静态版复制的投稿链接或投稿码…"></textarea></div>
          <div class="modal-foot reveal d1"><button class="btn btn-sm btn-primary" id="ct-paste-go">读取并继续</button></div>
        </section>
      </div>`;
      app.querySelector('#ct-paste-go').addEventListener('click', () => {
        const raw = app.querySelector('#ct-paste').value.trim();
        const m = /ct=([A-Za-z0-9\-_]+)/.exec(raw);
        if (!m) { toast('没有识别到投稿内容', 'error'); return; }
        location.hash = `ct=${m[1]}`;
        renderRoute();
      });
      return;
    }

    if (!state.user) {
      app.innerHTML = `<div class="container section">
        <div class="section-head reveal"><span class="section-index">CONTRIBUTE</span><h1 class="section-title">投稿到公开档案</h1><span class="section-note">登录 / 注册后即可完成投稿</span></div>
        <div class="notice reveal d1">收到 <strong>${payload.entries.length} 条</strong>来自「${esc(payload.from || '静态版档案')}」的投稿内容。登录或注册你的档案后，这些文案会导入你的档案并按你的选择公开。</div>
        <div class="reveal d2" style="margin-top:20px;display:flex;gap:12px;flex-wrap:wrap">
          <button class="btn btn-primary" id="ct-auth">登录 / 注册</button>
          <a class="btn" href="/discover" data-link>先逛逛公开档案</a>
        </div>
      </div>`;
      app.querySelector('#ct-auth').addEventListener('click', () => openAuth('register'));
      return;
    }

    const cats = (payload.categories || []);
    app.innerHTML = `<div class="container section">
      <div class="section-head reveal"><span class="section-index">CONTRIBUTE</span><h1 class="section-title">确认投稿</h1><span class="section-note">来自「${esc(payload.from || '静态版档案')}」</span></div>
      <div class="profile-stats reveal d1" style="margin:20px 0">
        <div><div class="stat-num">${payload.entries.length}</div><div class="stat-label">条文案</div></div>
        <div><div class="stat-num">${cats.length}</div><div class="stat-label">个分类</div></div>
        <div><div class="stat-num" id="ct-dup">…</div><div class="stat-label">已存在将跳过</div></div>
      </div>
      <div class="chip-row reveal d1" style="margin-bottom:24px">${cats.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
      <div id="ct-result"></div>
      <div class="modal-foot reveal d2"><button class="btn btn-primary" id="ct-go">确认投稿</button></div>
    </div>`;

    // 查重提示（≤200 条/批）
    const dupBox = app.querySelector('#ct-dup');
    (async () => {
      let dupCount = 0;
      for (let i = 0; i < payload.entries.length; i += 200) {
        const slice = payload.entries.slice(i, i + 200).map((e) => e.content);
        try {
          const d = await api('/api/copies/check-duplicates', { method: 'POST', body: { contents: slice }, quiet: true });
          dupCount += Object.keys(d.existing || {}).length;
        } catch { /* 忽略 */ }
      }
      dupBox.textContent = String(dupCount);
    })();

    app.querySelector('#ct-go').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = '正在投稿…';
      try {
        const res = await importEntries(payload);
        await renderPublishGuide(app.querySelector('#ct-result'), res.importedCats, res);
        e.target.closest('.modal-foot').remove();
        toast(`投稿完成：导入 ${res.created} 条`);
      } catch (err) {
        toast(err.message || '投稿失败', 'error');
        e.target.disabled = false;
        e.target.textContent = '确认投稿';
      }
    });
  });
}

/* ---- 导入：建分类 → 分批批量写入 ---- */

async function importEntries(payload) {
  // 1. 查重（分批，200/批）
  const dupSet = new Set();
  for (let i = 0; i < payload.entries.length; i += 200) {
    const slice = payload.entries.slice(i, i + 200).map((x) => x.content);
    const d = await api('/api/copies/check-duplicates', { method: 'POST', body: { contents: slice } });
    Object.keys(d.existing || {}).forEach((k) => dupSet.add(k));
  }
  const fresh = payload.entries.filter((x) => x.content && !dupSet.has(x.content));

  // 2. 分类映射：已有 → 直接用；缺失 → 创建
  const catData = await api('/api/categories');
  const nameMap = new Map(catData.items.map((c) => [c.name, c.id]));
  for (const cname of payload.categories || []) {
    if (!nameMap.has(cname)) {
      try {
        const created = await api('/api/categories', { method: 'POST', body: { name: String(cname).slice(0, 30) } });
        nameMap.set(cname, created.id);
      } catch { /* 同名冲突等，跳过该分类 */ }
    }
  }

  // 3. 分批写入（≤200/批）
  const items = fresh.map((x) => ({
    content: x.content,
    title: x.title || '',
    tags: Array.isArray(x.tags) ? x.tags : [],
    categoryIds: (x.categories || []).map((n) => nameMap.get(n)).filter(Boolean),
  }));
  for (let i = 0; i < items.length; i += 200) {
    await api('/api/copies/batch', { method: 'POST', body: { items: items.slice(i, i + 200) } });
  }

  return {
    created: items.length,
    skipped: payload.entries.length - items.length,
    importedCats: [...new Set((payload.categories || []).filter((n) => nameMap.has(n)))],
  };
}

/* ---- 公开引导：投稿后让内容真正可被搜索 ---- */

async function renderPublishGuide(box, importedCats, res) {
  const me = state.user;
  const summary = `<div class="notice">✅ 投稿完成：导入 <strong>${res.created} 条</strong>${res.skipped ? `，跳过 ${res.skipped} 条已存在` : ''}。</div>`;

  if (me.privacy === 'public') {
    box.innerHTML = `${summary}
      <div class="notice" style="margin-top:16px">你的档案是<strong>完全公开</strong>——现在任何人都能在公开档案搜索到这些文案。</div>
      <div style="margin-top:16px;display:flex;gap:12px;flex-wrap:wrap">
        <a class="btn btn-sm btn-primary" href="/discover" data-link>去发现页看看 ↗</a>
        <a class="btn btn-sm" href="/archive" data-link>查看我的文案库</a>
      </div>`;
    return;
  }

  const cats = await api('/api/categories');
  const wanted = cats.items.filter((c) => importedCats.includes(c.name)).map((c) => c.id);
  const missing = wanted.filter((id) => !(me.publicCategoryIds || []).includes(id));

  if (me.privacy === 'partial' && !missing.length) {
    box.innerHTML = `${summary}
      <div class="notice" style="margin-top:16px">投稿的分类已在你的公开范围内——别人现在就能搜到这些文案。</div>
      <div style="margin-top:16px"><a class="btn btn-sm btn-primary" href="/discover" data-link>去发现页看看 ↗</a></div>`;
    return;
  }

  box.innerHTML = `${summary}
    <div class="notice warn" style="margin-top:16px">要让别人搜到投稿的文案，需要把它们公开。选择公开方式：</div>
    <div class="check-grid" style="grid-template-columns:1fr 1fr;margin-top:16px">
      <button class="check-item plain" id="pub-all" style="padding:16px;text-align:left"><b>完全公开</b><div class="field-hint" style="margin-top:6px">档案内全部文案与分类均可被浏览与搜索</div></button>
      <button class="check-item plain" id="pub-partial" style="padding:16px;text-align:left"><b>部分公开</b><div class="field-hint" style="margin-top:6px">只公开投稿涉及的分类（${esc((importedCats || []).join('、') || '—')}），其余保持私密</div></button>
    </div>`;

  box.querySelector('#pub-all').addEventListener('click', async () => {
    await api('/api/profile', { method: 'PUT', body: { privacy: 'public' } });
    await refreshSession();
    toast('档案已完全公开');
    renderPublishGuide(box, importedCats, res);
  });
  box.querySelector('#pub-partial').addEventListener('click', async () => {
    const union = [...new Set([...(me.publicCategoryIds || []), ...wanted])];
    await api('/api/profile', { method: 'PUT', body: { privacy: 'partial', publicCategoryIds: union } });
    await refreshSession();
    toast('投稿分类已公开');
    renderPublishGuide(box, importedCats, res);
  });
}
