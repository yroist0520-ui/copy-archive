/* 首页：搜索入口、分类速览、最新上传、热门文案、推荐档案 */
import {
  state, api, route, esc, highlight, debounce, navigate, openAuth,
} from './core.js';
import { copyGrid, bindCopyCards, emptyState } from './ui.js';

export function registerHome() {
  route(/^\/$/, async ({ app }) => {
    let discover = { archives: [], popular: [] };
    let latest = { items: [], total: 0 };
    let officialCats = [];
    try {
      discover = await api('/api/discover', { quiet: true });
    } catch { /* 空数据兜底 */ }
    if (state.user) {
      try { latest = await api('/api/copies?sort=newest&pageSize=6', { quiet: true }); } catch { /* 忽略 */ }
    } else {
      // 访客也能逛分类：官方精选公开档案的分类免登录可看
      try { officialCats = (await api('/api/public/u/official/categories', { quiet: true })).items || []; } catch { /* 静态版无官方档案 */ }
    }
    const totalCopies = state.user ? latest.total : discover.popular.length;
    const groupOrder = ['风格类', '用途类', '其他类', '自定义'];
    const cats = state.categories;
    const grouped = groupOrder.map((g) => ({ group: g, items: cats.filter((c) => c.group === g) })).filter((g) => g.items.length);
    const officialGrouped = groupOrder.map((g) => ({ group: g, items: officialCats.filter((c) => c.group === g) })).filter((g) => g.items.length);

    app.innerHTML = `
      <div class="container">
        <section class="hero">
          <div class="hero-grid">
            <div>
              <div class="hero-eyebrow reveal d1">PERSONAL TEXT ARCHIVE / EST. 2026</div>
              <h1 class="hero-title reveal d2"><span>Copy</span><span class="title-outline">Archive</span></h1>
              <p class="hero-sub reveal d3">把散落的句子收进档案。按风格与用途整理，随时复制，或把你的档案公开给同好。一个为文字而生的私人馆藏空间。</p>
              <div class="reveal d4" style="margin-top:32px;display:flex;gap:12px;flex-wrap:wrap">
                ${state.user
                  ? `<a class="btn btn-primary" href="/upload" data-link>＋ 上传文案</a><a class="btn" href="/archive" data-link>进入文案库</a>`
                  : `<button class="btn btn-primary" id="hero-auth">建立我的档案</button><a class="btn" href="/discover" data-link>浏览公开档案</a>`}
              </div>
            </div>
            <aside class="hero-meta reveal d5">
              <div class="hero-meta-row"><div class="hero-meta-label">ARCHIVED ITEMS</div><div class="hero-meta-value">${String(totalCopies).padStart(4, '0')}</div></div>
              <div class="hero-meta-row"><div class="hero-meta-label">CATEGORIES</div><div class="hero-meta-value">${String(state.user ? cats.length : 30).padStart(2, '0')}</div></div>
              <div class="hero-meta-row"><div class="hero-meta-label">PUBLIC ARCHIVES</div><div class="hero-meta-value">${String(discover.archives.length).padStart(2, '0')}</div></div>
            </aside>
          </div>
        </section>

        <section class="search-block section" id="home-search">
          <div class="section-head reveal"><span class="section-index">01</span><h2 class="section-title">Search the archive</h2><span class="section-note">关键词 / 标题 / 分类 / 标签</span></div>
          <div class="search-field reveal d1">
            <span class="search-glyph">⌕</span>
            <input class="search-input" id="home-q" type="search" autocomplete="off" placeholder="输入关键词，开始检索…" aria-label="搜索文案">
            <button class="search-clear hidden" id="home-clear" aria-label="清除搜索">✕</button>
          </div>
          <div class="search-meta"><span id="home-result-count">${state.user ? '输入关键词搜索你的全部文案' : '输入关键词搜索公开文案'}</span><span class="search-hint">支持中英文混合 · 多关键词空格分隔</span></div>
          <div id="home-results" style="margin-top:28px"></div>
        </section>

        <section class="section" id="home-categories">
          <div class="section-head reveal"><span class="section-index">02</span><h2 class="section-title">Categories</h2><span class="section-note">${state.user ? '点击进入分类 · 可自由管理' : officialGrouped.length ? '点击预览官方精选分类 · 无需注册' : '注册后自动生成 · 可自由管理'}</span></div>
          ${state.user && grouped.length ? grouped.map((g, i) => `
            <div class="group-label reveal d${Math.min(i + 1, 5)}">${esc(g.group)} — ${String(g.items.length).padStart(2, '0')} ITEMS</div>
            <div class="category-grid reveal">${g.items.slice(0, 10).map((c) => `
              <button class="category-tile" data-cat-tile="${c.id}" style="--cat-color:${esc(c.color)}">
                <div class="category-tile-top"><span class="cat-dot" style="background:${esc(c.color)}"></span>${esc(g.group.slice(0, 2))}</div>                <div><div class="category-tile-name">${esc(c.name)}</div><div class="category-tile-count">${c.count} 条文案 ↗</div></div>
              </button>`).join('')}</div>`).join('')
            : officialGrouped.length ? officialGrouped.map((g, i) => `
              <div class="group-label reveal d${Math.min(i + 1, 5)}">${esc(g.group)} — ${String(g.items.length).padStart(2, '0')} ITEMS</div>
              <div class="category-grid reveal">${g.items.map((c) => `
                <button class="category-tile" data-cat-tile="${c.id}" data-official="1" style="--cat-color:${esc(c.color)}">
                  <div class="category-tile-top"><span class="cat-dot" style="background:${esc(c.color)}"></span>${esc(g.group.slice(0, 2))}</div>                  <div><div class="category-tile-name">${esc(c.name)}</div><div class="category-tile-count">${c.count} 条文案 ↗</div></div>
                </button>`).join('')}</div>`).join('')
            : `<div class="category-grid">${['INS','韩系','暗黑','怪诞','古风','少女','可爱','萌物','复古','清冷','高级感','治愈','赛博朋克','哥特','短句','水印','亮晶晶','实拍','朋友圈','个性签名'].map((n) => `<button class="category-tile" data-presets><div class="category-tile-top">PRESET</div><div><div class="category-tile-name">${n}</div><div class="category-tile-count">注册后启用</div></div></button>`).join('')}</div>`}
        </section>

        <section class="section">
          <div class="section-head reveal"><span class="section-index">03</span><h2 class="section-title">Latest entries</h2><span class="section-note">${state.user ? '最近上传' : '公开档案最新上传'}</span></div>
          <div id="home-latest">${latest.items.length ? copyGrid(latest.items, { editable: true }) : copyGrid(discover.popular.slice(0, 6), { publicView: true, editable: false })}</div>
        </section>

        <section class="section">
          <div class="section-head reveal"><span class="section-index">04</span><h2 class="section-title">Most copied</h2><span class="section-note">被复制次数最多的公开文案</span></div>
          <div id="home-popular">${discover.popular.length ? copyGrid(discover.popular.slice(0, 6), { publicView: true, editable: false }) : emptyState('NO PUBLIC DATA', '还没有公开文案', '公开你的档案后，热门文案会在这里出现。')}</div>
        </section>

        <section class="section">
          <div class="section-head reveal"><span class="section-index">05</span><h2 class="section-title">Public archives</h2><span class="section-note">来自其他档案主理人</span></div>
          ${discover.archives.length ? `<div class="archive-grid reveal">${discover.archives.slice(0, 6).map((a, i) => `
            <a class="archive-card" href="/u/${encodeURIComponent(a.username)}" data-link>
              <div class="archive-card-top"><span>NO. ${String(i + 1).padStart(3, '0')}</span><span>${a.copy_count} ITEMS</span></div>
              <div class="archive-card-name">${esc(a.display_name)}</div>
              <div class="archive-card-bio">${esc(a.bio || '这位档案主理人还没有写下简介。')}</div>
              <div style="margin-top:16px" class="mono faint" style="font-size:var(--t-micro)">@${esc(a.username)} ↗</div>
            </a>`).join('')}</div>`
            : emptyState('NO PUBLIC ARCHIVE', '还没有公开的档案', '成为第一个公开档案的人，让别人也能读到你的收藏。', `<a class="btn btn-sm" href="/profile" data-link>设置我的档案</a>`)}
        </section>
      </div>`;

    document.getElementById('hero-auth')?.addEventListener('click', openAuth);
    bindCopyCards(app, {
      onChanged: () => {},
      onDetail: showDetail,
    });
    app.querySelectorAll('[data-cat-tile]').forEach((tile) => {
      tile.addEventListener('click', () => {
        if (!state.user) {
          if (tile.dataset.official) navigate(`/u/official?category=${tile.dataset.catTile}`);
          else openAuth();
          return;
        }
        navigate(`/archive?category=${tile.dataset.catTile}`);
      });
    });
    document.querySelectorAll('[data-presets]').forEach((tile) => tile.addEventListener('click', () => {
      if (!state.user) openAuth();
    }));

    const input = document.getElementById('home-q');
    const clear = document.getElementById('home-clear');
    const results = document.getElementById('home-results');
    const count = document.getElementById('home-result-count');
    let seq = 0;
    const search = async () => {
      const q = input.value;
      clear.classList.toggle('hidden', !q);
      const mySeq = ++seq;
      if (!q.trim()) {
        results.innerHTML = '';
        count.textContent = state.user ? '输入关键词搜索你的全部文案' : '输入关键词搜索公开文案';
        return;
      }
      count.textContent = '检索中…';
      try {
        const data = state.user
          ? await api('/api/copies?q=' + encodeURIComponent(q) + '&pageSize=12', { quiet: true })
          : await api('/api/discover?q=' + encodeURIComponent(q), { quiet: true });
        if (mySeq !== seq) return;
        const items = state.user ? data.items : data.popular;
        count.textContent = `找到 ${data.total ?? items.length} 条匹配结果`;
        results.innerHTML = items.length
          ? copyGrid(items, { query: q, publicView: !state.user, editable: !!state.user })
          : emptyState('NO MATCH', '没有找到匹配的文案', '试试更短的关键词，或换个说法。');
        bindCopyCards(results, { onDetail: showDetail });
      } catch {
        count.textContent = '检索失败';
      }
    };
    input.addEventListener('input', debounce(search, 260));
    clear.addEventListener('click', () => { input.value = ''; search(); input.focus(); });
  });
}

function showDetail(item) {
  import('./detail.js').then(({ openDetail }) => openDetail(item));
}
