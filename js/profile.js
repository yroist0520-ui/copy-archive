/* 个人档案：编辑、隐私设置、分享链接；公开档案匿名访问与站内搜索 */
import {
  state, api, route, esc, fmtDate, openAuth, logout, toast, copyText,
  loadCategories, debounce, refreshSession, updateAuthButton, renderRoute, BASE,
  loadSamples, seedSampleEntries, SHARE_CODE, FULL_VERSION_URL, currentQuery, openModal,
} from './core.js';
import { copyGrid, bindCopyCards, emptyState, categoryChips, bindChips, pagination } from './ui.js';
import { openDetail } from './detail.js';
import { bindImageSlot } from './image.js';
import { buildContributeUrl } from './contribute.js';
import { localApi } from './local-api.js';

const PRIVACY_LABEL = { public: '完全公开', partial: '部分公开', private: '仅自己可见' };

function avatarHTML(name, url, size = '') {
  return `<div class="avatar ${size}" ${size ? `style="width:${size}px;height:${size}px"` : ''}>${url ? `<img src="${esc(url)}" alt="${esc(name)}的头像" onerror="this.remove()">` : esc((name || '?').slice(0, 1).toUpperCase())}</div>`;
}

export function registerProfile() {
  // ---- 我的档案 ----
  route(/^\/profile$/, async ({ app }) => {
    if (!state.user) {
      app.innerHTML = `<div class="container section">${emptyState('AUTH REQUIRED', '档案需要登录', '登录后可以完善个人档案并生成分享链接。', '<button class="btn btn-sm btn-primary" id="p-login">登录 / 注册</button>')}</div>`;
      document.getElementById('p-login').addEventListener('click', () => openAuth('login'));
      return;
    }
    await loadCategories();
    const me = state.user;
    const data = await api('/api/copies?pageSize=6&sort=newest', { quiet: true }).catch(() => ({ items: [], total: 0 }));
    const sharePath = `${BASE.replace(/\/$/, '')}/u/${encodeURIComponent(me.username)}`;
    // 部分托管网关要求 sharecode 才能放行，分享链接必须带上
    const shareUrl = `${location.origin}${sharePath}${SHARE_CODE ? `?sharecode=${encodeURIComponent(SHARE_CODE)}` : ''}`;
    const publicCats = state.categories.filter((c) => (me.publicCategoryIds || []).includes(c.id));
    const samples = await loadSamples();
    const sampleTotal = samples
      ? samples.groups.reduce((n, g) => n + g.items.reduce((m, i) => m + i.texts.length, 0), 0)
      : 0;

    app.innerHTML = `
      <div class="container">
        <section class="profile-hero">
          <div class="section-head reveal"><span class="section-index">PROFILE</span><h1 class="section-title">我的档案</h1><span class="section-note">创建于 ${fmtDate(me.createdAt)}</span></div>
          ${me.coverUrl ? `<div class="cover-strip" style="background-image:url('${esc(me.coverUrl)}')"></div>` : ''}
          <div class="profile-head reveal d1">
            ${avatarHTML(me.displayName, me.avatarUrl)}
            <div>
              <h2 class="profile-name">${esc(me.displayName)}</h2>
              <div class="profile-handle">@${esc(me.username)} · ${PRIVACY_LABEL[me.privacy] || me.privacy}</div>
              <p class="profile-bio">${esc(me.bio || '还没有写下简介。用一两句话介绍你的文案口味吧。')}</p>
            </div>
            <div class="profile-stats">
              <div><div class="stat-num">${data.total}</div><div class="stat-label">文案</div></div>
              <div><div class="stat-num">${state.categories.length}</div><div class="stat-label">分类</div></div>
              <div><div class="stat-num">${publicCats.length}</div><div class="stat-label">公开分类</div></div>
            </div>
          </div>
        </section>

        <section class="section">
          <div class="section-head reveal"><span class="section-index">01</span><h2 class="section-title">Settings</h2><span class="section-note">外观、资料与公开范围</span></div>
          <div class="form-grid reveal d1">
            <div class="field"><label class="field-label">昵称</label><input class="input" id="p-name" value="${esc(me.displayName)}"></div>
            <div class="field"><label class="field-label">头像</label>
              <div class="upload-slot upload-avatar" id="p-avatar-slot">
                <input type="file" id="p-avatar-file" accept="image/*" hidden>
                <img class="upload-preview" alt="头像预览">
                <span class="upload-empty" aria-hidden="true">＋</span>
                <span class="upload-body"><span class="upload-title">点击选择头像图片</span><span class="upload-meta">支持 JPG / PNG / WebP，浏览器本地压缩后保存</span></span>
                <button type="button" class="upload-clear">移除</button>
              </div>
            </div>
            <div class="field full"><label class="field-label">个人简介</label><textarea class="input" id="p-bio" rows="3">${esc(me.bio || '')}</textarea></div>
            <div class="field full"><label class="field-label">档案封面</label>
              <div class="upload-slot upload-cover" id="p-cover-slot">
                <input type="file" id="p-cover-file" accept="image/*" hidden>
                <img class="upload-preview" alt="封面预览">
                <span class="upload-empty" aria-hidden="true">＋</span>
                <span class="upload-body"><span class="upload-title">点击选择封面图片</span><span class="upload-meta">建议宽高比 16:5，会自动居中裁剪并压缩</span></span>
                <button type="button" class="upload-clear">移除</button>
              </div>
            </div>
            <div class="field full"><label class="field-label">档案主题</label>
              <div class="segmented"><button data-theme-set="paper" class="${me.theme === 'paper' ? 'active' : ''}">纸白 PAPER</button><button data-theme-set="ink" class="${me.theme === 'ink' ? 'active' : ''}">墨黑 INK</button><button data-theme-set="newsprint" class="${me.theme === 'newsprint' ? 'active' : ''}">新闻纸 NEWSPRINT</button></div></div>
          </div>
          <div class="modal-foot"><button class="btn btn-sm btn-primary" id="p-save">保存档案设置</button></div>
        </section>

        <section class="section">
          <div class="section-head reveal"><span class="section-index">02</span><h2 class="section-title">Sample entries</h2><span class="section-note">让公开档案先丰富起来</span></div>
          <div class="notice reveal d1">一键为档案填充 <strong>${sampleTotal || 90} 条</strong>示例文案，覆盖 30 个分类，按分类自动关联并打上语种标签。已存在的相同文案会自动跳过，重复点击不会产生重复数据。</div>
          <div class="modal-foot reveal d1"><button class="btn btn-sm btn-primary" id="p-seed">填充示例文案</button></div>
        </section>

        <section class="section">
          <div class="section-head reveal"><span class="section-index">03</span><h2 class="section-title">Privacy</h2><span class="section-note">服务端强制校验，私密文案不会被任何入口访问</span></div>
          <div class="form-grid reveal d1">
            <div class="field full"><label class="field-label">公开模式</label>
              <div class="check-grid" style="grid-template-columns:repeat(3,1fr);max-height:none">
                ${[['public', '完全公开', '所有文案与分类均可浏览'], ['partial', '部分公开', '只公开下方勾选的分类'], ['private', '仅自己可见', '档案不对外开放']].map(([v, label, desc]) => `
                  <label class="check-item plain" style="display:block;padding:14px"><input type="radio" name="privacy" value="${v}" ${me.privacy === v ? 'checked' : ''} style="margin-right:8px"><b>${label}</b><div class="field-hint" style="margin:6px 0 0 22px">${desc}</div></label>`).join('')}
              </div>
            </div>
            <div class="field full" id="public-cat-field"><label class="field-label">公开展示的分类（部分公开模式生效）</label>
              <div class="check-grid" id="p-public-cats">${categoryChips(state.categories, me.publicCategoryIds || [])}</div>
              <div class="field-hint">只公开勾选分类中的文案；未分类文案不会公开。</div></div>
          </div>
          <div class="modal-foot"><button class="btn btn-sm btn-primary" id="p-save-privacy">保存隐私设置</button></div>
        </section>

        ${state.offlineMode ? `
        <section class="section">
          <div class="section-head reveal"><span class="section-index">04</span><h2 class="section-title">Share</h2><span class="section-note">本地版无法直接分享 · 可投稿到公开档案</span></div>
          <div class="notice reveal d1">这是<strong>本地版</strong>：档案与文案只保存在当前设备的浏览器里，直接发链接别人看不到。两个办法把文案带给别人：<strong>投稿</strong>到完整版的公开档案馆（所有人可搜索、复制），或在完整版建立档案后分享链接。</div>
          <div class="reveal d1" style="margin-top:12px;display:flex;gap:12px;flex-wrap:wrap">
            <button class="btn btn-sm btn-primary" id="p-contribute">投稿到公开档案 ↗</button>
            <a class="btn btn-sm" href="${esc(FULL_VERSION_URL)}" target="_blank" rel="noopener">打开完整版 · 建立可分享的档案</a>
            <a class="btn btn-sm" href="/archive" data-link>继续整理本地文案</a>
          </div>
        </section>` : `
        <section class="section">
          <div class="section-head reveal"><span class="section-index">04</span><h2 class="section-title">Share</h2><span class="section-note">任何人无需注册即可浏览公开档案</span></div>
          <div class="notice reveal d1">当前链接指向 <strong>${PRIVACY_LABEL[me.privacy]}</strong> 模式的档案。${me.privacy === 'private' ? '私密模式下访客将无法访问该链接。' : '复制下方链接分享给朋友，打开就能看到你的文案。'}</div>
          <div class="search-field reveal d1"><span class="mono muted" style="font-size:var(--t-small)">LINK</span>
            <input class="input" id="p-share" readonly value="${esc(shareUrl)}" style="border:0;background:transparent;font-family:var(--mono);font-size:var(--t-small)">
            <button class="btn btn-sm" id="p-copy-link">复制链接</button></div>
          <div style="margin-top:12px"><a class="link-btn" href="/u/${encodeURIComponent(me.username)}" data-link>预览我的公开档案 ↗</a></div>
        </section>`}

        <section class="section">
          <div class="section-head reveal"><span class="section-index">05</span><h2 class="section-title">Recent</h2><span class="section-note">最新上传</span></div>
          <div id="p-recent">${data.items.length ? copyGrid(data.items) : emptyState('EMPTY', '还没有文案', '上传第一条文案，档案就开始生长了。', '<a class="btn btn-sm btn-primary" href="/upload" data-link>＋ 上传</a>')}</div>
        </section>

        <section class="section">
          <div class="section-head reveal"><span class="section-index">06</span><h2 class="section-title">Account</h2><span class="section-note">当前身份 @${esc(me.username)}</span></div>
          <div class="notice reveal d1">切换账号无需先退出：直接登录另一个账号即可，登录成功后会自动进入对方的档案。退出后文案不会丢失，下次登录仍会回到这里。</div>
          <div class="reveal d1" style="margin-top:12px;display:flex;gap:12px;flex-wrap:wrap">
            <button class="btn btn-sm btn-primary" id="p-switch">切换账号</button>
            <button class="btn btn-sm btn-danger" id="p-logout">退出登录</button>
          </div>
        </section>
      </div>`;

    let themeChoice = me.theme;
    let avatarValue = me.avatarUrl || '';
    let coverValue = me.coverUrl || '';

    // 头像与封面：本地选择图片 → 浏览器压缩 → 保存
    bindImageSlot(app.querySelector('#p-avatar-slot'), {
      value: avatarValue,
      maxWidth: 256,
      maxHeight: 256,
      crop: true,
      onChange: (v) => { avatarValue = v; },
      onStatus: (msg, kind) => toast(msg, kind),
    });
    bindImageSlot(app.querySelector('#p-cover-slot'), {
      value: coverValue,
      maxWidth: 1600,
      maxHeight: 500,
      crop: true,
      quality: 0.8,
      onChange: (v) => { coverValue = v; },
      onStatus: (msg, kind) => toast(msg, kind),
    });

    app.querySelectorAll('[data-theme-set]').forEach((btn) => btn.addEventListener('click', () => {
      themeChoice = btn.dataset.themeSet;
      app.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('active', b === btn));
      document.documentElement.dataset.theme = themeChoice;
    }));
    bindChips(app.querySelector('#p-public-cats'), () => {});
    app.querySelector('#p-save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api('/api/profile', {
          method: 'PUT',
          body: {
            displayName: app.querySelector('#p-name').value,
            avatarUrl: avatarValue,
            bio: app.querySelector('#p-bio').value,
            coverUrl: coverValue,
            theme: themeChoice,
          },
        });
        localStorage.setItem('ca_theme', themeChoice);
        await refreshSession(); updateAuthButton();
        // 即时反映到页面顶部，无需刷新
        const box = app.querySelector('.profile-head .avatar');
        if (box) {
          box.innerHTML = avatarValue
            ? `<img src="${esc(avatarValue)}" alt="头像" onerror="this.remove()">`
            : esc((app.querySelector('#p-name').value || '?').slice(0, 1).toUpperCase());
        }
        const strip = app.querySelector('.cover-strip');
        if (coverValue) {
          if (strip) strip.style.backgroundImage = `url('${coverValue}')`;
          else {
            const el = document.createElement('div');
            el.className = 'cover-strip';
            el.style.backgroundImage = `url('${coverValue}')`;
            app.querySelector('.profile-hero').prepend(el);
          }
        } else if (strip) {
          strip.remove();
        }
        toast('档案设置已保存');
      } catch { /* 已提示 */ } finally { e.target.disabled = false; }
    });
    app.querySelector('#p-save-privacy').addEventListener('click', async (e) => {
      const privacy = app.querySelector('input[name="privacy"]:checked').value;
      const publicCategoryIds = [...app.querySelectorAll('#p-public-cats .chip.active')].map((b) => Number(b.dataset.cat));
      e.target.disabled = true;
      try {
        await api('/api/profile', { method: 'PUT', body: { privacy, publicCategoryIds } });
        await refreshSession();
        toast('隐私设置已保存'); renderRoute();
      } catch { /* 已提示 */ } finally { e.target.disabled = false; }
    });
    const copyLinkBtn = app.querySelector('#p-copy-link');
    if (copyLinkBtn) copyLinkBtn.addEventListener('click', async () => {
      const ok = await copyText(shareUrl);
      toast(ok ? '分享链接已复制' : '复制失败，请手动选择链接', ok ? 'ok' : 'error');
    });
    const seedBtn = app.querySelector('#p-seed');
    if (seedBtn) {
      seedBtn.addEventListener('click', async (e) => {
        e.target.disabled = true;
        const original = e.target.textContent;
        e.target.textContent = '正在填充…';
        try {
          const res = await seedSampleEntries();
          toast(res.created
            ? `已填充 ${res.created} 条示例文案`
            : '示例文案已全部存在，无需重复填充');
          await loadCategories();
          await refreshSession();
          renderRoute();
        } catch (err) {
          toast(err.message || '填充失败', 'error');
          e.target.textContent = original;
        } finally {
          e.target.disabled = false;
        }
      });
    }
    const contributeBtn = app.querySelector('#p-contribute');
    if (contributeBtn) contributeBtn.addEventListener('click', () => openContributeModal(me));
    // 切换账号：直接开登录框（含注册入口）。登录成功后 openAuth 内部会 refreshSession + renderRoute，
    // 页面自动变为新账号档案；同域新 session 覆盖旧 cookie，无需先退出。
    const switchBtn = app.querySelector('#p-switch');
    if (switchBtn) switchBtn.addEventListener('click', () => openAuth('login'));
    const logoutBtn = app.querySelector('#p-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', () => logout());
    bindCopyCards(app.querySelector('#p-recent'), { onChanged: () => renderRoute(), onDetail: openDetail });
  });

  // ---- 公开档案 ----
  route(/^\/u\/([^/]+)$/, async ({ params, app }) => {
    const username = decodeURIComponent(params[0]);
    let profile;
    try {
      profile = await api(`/api/public/u/${encodeURIComponent(username)}`, { quiet: true });
    } catch {
      app.innerHTML = `<div class="container section">${emptyState('ARCHIVE UNAVAILABLE', '档案不存在或未公开', '这个地址可能已失效，或档案主理人选择了仅自己可见。', '<a class="btn btn-sm" href="/discover" data-link>浏览其他公开档案</a>')}</div>`;
      return;
    }
    let categories = [];
    try { categories = (await api(`/api/public/u/${encodeURIComponent(username)}/categories`, { quiet: true })).items; } catch { /* 忽略 */ }

    // 支持从首页分类卡片带 ?category= 进来，直接落到该分类
    const initialCat = currentQuery().get('category') || '';

    const view = { q: '', category: initialCat, page: 1, cache: [], meta: { items: [], total: 0, hasMore: false, pageSize: state.pageSize } };
    app.innerHTML = `
      <div class="container">
        <section class="profile-hero">
          ${profile.coverUrl ? `<div class="cover-strip" style="background-image:url('${esc(profile.coverUrl)}')"></div>` : ''}
          <div class="section-head reveal"><span class="section-index">PUBLIC ARCHIVE</span><h1 class="section-title">公开档案</h1><span class="section-note">创建于 ${fmtDate(profile.createdAt)}</span></div>
          <div class="profile-head reveal d1">
            ${avatarHTML(profile.displayName, profile.avatarUrl)}
            <div>
              <h2 class="profile-name">${esc(profile.displayName)}</h2>
              <div class="profile-handle">@${esc(profile.username)} <span class="privacy-badge" style="margin-left:10px">${PRIVACY_LABEL[profile.privacy] || ''}</span></div>
              <p class="profile-bio">${esc(profile.bio || '这位档案主理人还没有写下简介。')}</p>
            </div>
            <div class="profile-stats">
              <div><div class="stat-num">${profile.copyCount}</div><div class="stat-label">文案</div></div>
              <div><div class="stat-num">${profile.categoryCount}</div><div class="stat-label">分类</div></div>
              <div><div class="stat-num">${categories.length}</div><div class="stat-label">公开分类</div></div>
            </div>
          </div>
        </section>

        <section class="section">
          <div class="section-head reveal"><span class="section-index">01</span><h2 class="section-title">Browse & copy</h2><span class="section-note">访客可浏览、搜索与复制，不能修改</span></div>
          <div class="search-field reveal d1"><span class="search-glyph">⌕</span>
            <input class="search-input" id="pub-q" type="search" placeholder="搜索此档案中的文案…" aria-label="档案内搜索">
            <button class="search-clear hidden" id="pub-clear" aria-label="清除">✕</button></div>
          <div class="search-meta"><span id="pub-count">共 ${profile.copyCount} 条公开文案</span><span class="search-hint">支持分类名、标签与关键词</span></div>
          <div class="chip-row reveal d1" style="margin-top:20px">
            <button class="chip active" data-pub-cat="">全部</button>
            ${categories.map((c) => `<button class="chip" data-pub-cat="${c.id}" style="--cat-color:${esc(c.color)}"><span class="cat-dot" style="background:${esc(c.color)}"></span>${esc(c.name)} · ${c.count}</button>`).join('')}
          </div>
          <div id="pub-content" style="margin-top:28px"></div><div id="pub-pager"></div>
        </section>
      </div>`;

    const content = app.querySelector('#pub-content');
    const pager = app.querySelector('#pub-pager');
    function render() {
      if (!view.meta.items.length) {
        content.innerHTML = emptyState(view.q ? 'NO MATCH' : 'NO PUBLIC ENTRIES', view.q ? '没有匹配的文案' : '还没有公开文案', view.q ? '换个关键词试试。' : '这位主理人还没有公开文案。');
      } else {
        content.innerHTML = copyGrid(view.meta.items, { query: view.q, publicView: true, editable: false });
        bindCopyCards(content, { onDetail: openDetail });
      }
      app.querySelector('#pub-count').textContent = `找到 ${view.meta.total} 条${view.q ? '匹配' : ''}文案`;
      pager.innerHTML = '';
      if (view.meta.items.length) pager.appendChild(pagination(view.meta, (p) => load(p, true)));
    }
    async function load(page = 1, append = false) {
      view.page = page;
      const params = new URLSearchParams({ page: String(page), pageSize: String(state.pageSize), sort: 'newest' });
      if (view.q) params.set('q', view.q);
      if (view.category) params.set('category', view.category);
      try {
        const data = await api(`/api/public/u/${encodeURIComponent(username)}/copies?${params}`, { quiet: true });
        view.meta = append ? { ...data, items: [...view.cache, ...data.items] } : data;
        view.cache = view.meta.items.slice();
        render();
      } catch (err) {
        if (!append) content.innerHTML = emptyState('LOAD ERROR', '加载失败', err.message);
      }
    }
    const qInput = app.querySelector('#pub-q');
    qInput.addEventListener('input', debounce(() => {
      view.q = qInput.value;
      app.querySelector('#pub-clear').classList.toggle('hidden', !view.q);
      load(1);
    }, 240));
    app.querySelector('#pub-clear').addEventListener('click', () => { qInput.value = ''; view.q = ''; load(1); });
    app.querySelectorAll('[data-pub-cat]').forEach((chip) => chip.addEventListener('click', () => {
      app.querySelectorAll('[data-pub-cat]').forEach((c) => c.classList.toggle('active', c === chip));
      view.category = chip.dataset.pubCat;
      load(1);
    }));
    // 带 ?category= 进入时激活对应胶囊；分类不可见（部分公开未勾选）则回退全部
    if (initialCat) {
      const chip = app.querySelector(`[data-pub-cat="${CSS.escape(initialCat)}"]`);
      if (chip) {
        app.querySelectorAll('[data-pub-cat]').forEach((c) => c.classList.toggle('active', c === chip));
      } else {
        view.category = '';
      }
    }
    await load(1);
  });
}

/* ---- 投稿选择弹层：本地版选全部/部分文案 → 生成投稿链接 ---- */

async function openContributeModal(me) {
  // 拉全量本地文案（pageSize 上限 100，分页取尽）
  let all = [];
  let page = 1;
  try {
    for (; page <= 20; page++) {
      const data = await localApi(`/api/copies?page=${page}&pageSize=100&sort=newest`);
      all = all.concat(data.items || []);
      if (!data.hasMore || !(data.items || []).length) break;
    }
  } catch (err) {
    toast(err.message || '读取本地文案失败', 'error');
    return;
  }
  if (!all.length) {
    toast('还没有文案可投稿，先去上传几条吧', 'error');
    return;
  }

  // 按分类分组（含未分类）
  const groups = new Map();
  all.forEach((c) => {
    const names = (c.categories || []).map((x) => x.name);
    (names.length ? names : ['未分类']).forEach((n) => {
      if (!groups.has(n)) groups.set(n, []);
      groups.get(n).push(c);
    });
  });

  openModal({
    kicker: 'CONTRIBUTE',
    title: '投稿到公开档案',
    wide: true,
    body: `
      <div class="field-hint" style="margin-bottom:16px">选择要投稿的分类（默认全选）。生成投稿链接后在完整版打开、登录你的档案即可完成投稿——投稿后所有人都能在公开档案里搜索到这些文案。</div>
      <div class="check-grid" id="ct-groups" style="max-height:260px;overflow:auto">
        ${[...groups.entries()].map(([name, list]) => `
          <label class="check-item plain"><input type="checkbox" data-ct-group value="${esc(name)}" checked style="margin-right:8px"><b>${esc(name)}</b><span class="field-hint" style="margin-left:8px">${list.length} 条</span></label>`).join('')}
      </div>
      <div style="margin-top:12px;display:flex;gap:12px;align-items:center">
        <button class="btn btn-sm" id="ct-sel-all">全选</button>
        <button class="btn btn-sm" id="ct-sel-none">清空</button>
        <span class="field-hint" id="ct-count"></span>
      </div>
      <div id="ct-link-box" hidden style="margin-top:16px">
        <div class="field-hint" style="margin-bottom:8px">投稿链接已生成（长链接属正常现象），复制后粘贴给浏览器打开，或直接点击按钮：</div>
        <textarea class="input" id="ct-link" rows="4" readonly></textarea>
      </div>`,
    foot: `
      <button class="btn btn-sm btn-primary" id="ct-make">生成投稿链接</button>
      <button class="btn btn-sm" id="ct-open" hidden>打开并继续投稿 ↗</button>
      <button class="btn btn-sm" data-close>关闭</button>`,
    onMount(root, close) {
      root.querySelector('[data-close]').onclick = close;
      const boxes = [...root.querySelectorAll('[data-ct-group]')];
      const countEl = root.querySelector('#ct-count');
      const updateCount = () => {
        const picked = new Set(boxes.filter((b) => b.checked).map((b) => b.value));
        const n = all.filter((c) => {
          const names = (c.categories || []).map((x) => x.name);
          return (names.length ? names : ['未分类']).some((x) => picked.has(x));
        }).length;
        countEl.textContent = `将投稿 ${n} 条文案`;
        return n;
      };
      boxes.forEach((b) => b.addEventListener('change', updateCount));
      updateCount();
      root.querySelector('#ct-sel-all').onclick = () => { boxes.forEach((b) => { b.checked = true; }); updateCount(); };
      root.querySelector('#ct-sel-none').onclick = () => { boxes.forEach((b) => { b.checked = false; }); updateCount(); };

      root.querySelector('#ct-make').onclick = () => {
        const picked = new Set(boxes.filter((b) => b.checked).map((b) => b.value));
        if (!picked.size) { toast('至少选择一个分类', 'error'); return; }
        const entries = all
          .filter((c) => {
            const names = (c.categories || []).map((x) => x.name);
            return (names.length ? names : ['未分类']).some((x) => picked.has(x));
          })
          .map((c) => ({
            content: c.content,
            title: c.title || '',
            tags: c.tags || [],
            categories: (c.categories || []).map((x) => x.name),
          }));
        const catNames = [...new Set(entries.flatMap((x) => x.categories))];
        const url = buildContributeUrl({ v: 1, from: me.displayName, entries, categories: catNames });
        const box = root.querySelector('#ct-link-box');
        box.hidden = false;
        root.querySelector('#ct-link').value = url;
        root.querySelector('#ct-open').hidden = false;
        root.querySelector('#ct-open').onclick = () => window.open(url, '_blank', 'noopener');
        root.querySelector('#ct-make').textContent = '重新生成';
        toast('投稿链接已生成，已自动复制');
        copyText(url);
      };
    },
  });
}
