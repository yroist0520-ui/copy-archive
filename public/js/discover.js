/* 发现页：浏览公开档案 */
import { route, api, esc, debounce } from './core.js';
import { copyGrid, bindCopyCards, emptyState } from './ui.js';
import { openDetail } from './detail.js';

export function registerDiscover() {
  route(/^\/discover$/, async ({ app }) => {
    let data = { archives: [], popular: [] };
    try { data = await api('/api/discover', { quiet: true }); } catch { /* 忽略 */ }
    app.innerHTML = `
      <div class="container section" style="padding-top:56px">
        <div class="section-head reveal"><span class="section-index">DISCOVER</span><h1 class="section-title">发现</h1><span class="section-note">公开档案 · 无需注册即可浏览</span></div>
        <div class="search-field reveal d1" style="margin-bottom:32px"><span class="search-glyph">⌕</span>
          <input class="search-input" id="dis-q" type="search" placeholder="搜索档案主理人…" aria-label="搜索档案">
          <button class="search-clear hidden" id="dis-clear" aria-label="清除">✕</button></div>
        <div class="search-meta"><span id="dis-count">${data.archives.length} 个公开档案</span><span class="search-hint">点击进入档案，可站内搜索与复制</span></div>
        <div id="dis-list" style="margin-top:28px"></div>
        <section class="section" style="margin-top:64px">
          <div class="section-head reveal"><span class="section-index">POPULAR</span><h2 class="section-title">被反复收藏的句子</h2><span class="section-note">来自公开档案</span></div>
          <div id="dis-popular">${data.popular.length ? copyGrid(data.popular.slice(0, 8), { publicView: true, editable: false }) : emptyState('NO DATA', '暂无公开文案', '公开档案后，这里会出现热门文案。')}</div>
        </section>
      </div>`;

    const list = app.querySelector('#dis-list');
    function renderArchives(items) {
      list.innerHTML = items.length ? `<div class="archive-grid reveal">${items.map((a, i) => `
        <a class="archive-card" href="/u/${encodeURIComponent(a.username)}" data-link>
          <div class="archive-card-top"><span>NO. ${String(i + 1).padStart(3, '0')}</span><span>${a.copy_count} ITEMS</span></div>
          <div class="archive-card-name">${esc(a.display_name)}${a.username === 'official' ? '<span class="privacy-badge" style="margin-left:10px">内置文案库</span>' : ''}</div>
          <div class="archive-card-bio">${esc(a.bio || '这位档案主理人还没有写下简介。')}</div>
          <div class="mono faint" style="font-size:var(--t-micro);margin-top:16px">@${esc(a.username)} · ${a.category_count} 分类 ↗</div>
        </a>`).join('')}</div>`
        : emptyState('NO RESULT', '没有匹配的档案', '换个昵称或关键词试试。');
    }
    renderArchives(data.archives);
    const q = app.querySelector('#dis-q');
    q.addEventListener('input', debounce(() => {
      const term = q.value.trim().toLowerCase();
      app.querySelector('#dis-clear').classList.toggle('hidden', !term);
      const filtered = data.archives.filter((a) =>
        !term || [a.display_name, a.username, a.bio].some((v) => String(v || '').toLowerCase().includes(term)));
      app.querySelector('#dis-count').textContent = `${filtered.length} 个档案`;
      renderArchives(filtered);
    }, 200));
    app.querySelector('#dis-clear').addEventListener('click', () => { q.value = ''; q.dispatchEvent(new Event('input')); });
    bindCopyCards(app.querySelector('#dis-popular'), { onDetail: openDetail });
  });
}
