/* 我的收藏：分类筛选、复制、取消收藏 */
import {
  state, api, route, esc, openAuth, toast, copyText, openModal,
} from './core.js';
import { copyGrid, bindCopyCards, emptyState, pagination } from './ui.js';

export function registerFavorites() {
  route(/^\/favorites$/, async ({ app }) => {
    if (!state.user) {
      app.innerHTML = `<div class="container section">${emptyState('AUTH REQUIRED', '收藏夹需要登录', '登录后可以收藏自己或公开档案中的文案。', '<button class="btn btn-sm btn-primary" id="fav-login">登录 / 注册</button>')}</div>`;
      document.getElementById('fav-login').addEventListener('click', openAuth);
      return;
    }
    const view = { category: '', page: 1, cache: [], meta: { items: [], total: 0, hasMore: false, pageSize: state.pageSize } };
    app.innerHTML = `
      <div class="container section" style="padding-top:56px">
        <div class="section-head reveal"><span class="section-index">SAVED</span><h1 class="section-title">我的收藏</h1><span class="section-note" id="fav-count">— 条</span></div>
        <div class="toolbar reveal d1">
          <div class="toolbar-group"><span class="toolbar-label">分类筛选</span><select class="select" id="fav-cat"><option value="">全部分类</option>${state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
          <div class="toolbar-group" style="margin-left:auto"><button class="btn btn-sm" id="fav-copy-all">⧉ 复制全部收藏</button></div>
        </div>
        <div id="fav-content"></div><div id="fav-pager"></div>
      </div>`;
    const content = app.querySelector('#fav-content');
    const pager = app.querySelector('#fav-pager');

    function render() {
      if (!view.meta.items.length) {
        content.innerHTML = emptyState('NO SAVED ENTRIES', '还没有收藏', '点击文案卡片上的 ☆ 收藏按钮，喜欢的句子会出现在这里。', '<a class="btn btn-sm" href="/archive" data-link>去文案库看看</a>');
      } else {
        content.innerHTML = copyGrid(view.meta.items, { selectable: false });
        bindCopyCards(content, { onChanged: () => load(1), onDetail: (item) => import('./detail.js').then((m) => m.openDetail(item)) });
      }
      app.querySelector('#fav-count').textContent = `${view.meta.total} 条`;
      pager.innerHTML = '';
      if (view.meta.items.length) pager.appendChild(pagination(view.meta, (p) => load(p, true)));
    }

    async function load(page = 1, append = false) {
      view.page = page;
      const params = new URLSearchParams({ favorite: '1', page: String(page), pageSize: String(state.pageSize), sort: 'newest' });
      if (view.category) params.set('category', view.category);
      try {
        const data = await api('/api/copies?' + params, { quiet: true });
        view.meta = append ? { ...data, items: [...view.cache, ...data.items] } : data;
        view.cache = view.meta.items.slice();
        render();
      } catch (err) {
        if (!append) content.innerHTML = emptyState('LOAD ERROR', '加载失败', err.message);
      }
    }
    app.querySelector('#fav-cat').addEventListener('change', (e) => { view.category = e.target.value; load(1); });
    app.querySelector('#fav-copy-all').addEventListener('click', () => {
      const items = view.meta.items;
      if (!items.length) { toast('没有可复制的收藏', 'error'); return; }
      openModal({
        kicker: 'BATCH COPY', title: `复制 ${items.length} 条收藏`,
        body: `<label class="check-item" style="border:1px solid var(--rule);background:var(--surface)"><input type="checkbox" id="fav-number"> 添加序号</label>`,
        foot: '<button class="btn btn-sm" data-cancel>取消</button><button class="btn btn-sm btn-primary" data-go>复制</button>',
        onMount(root, close) {
          root.querySelector('[data-cancel]').onclick = close;
          root.querySelector('[data-go]').onclick = async () => {
            const numbered = root.querySelector('#fav-number').checked;
            const text = items.map((x, i) => (numbered ? `${String(i + 1).padStart(2, '0')}. ` : '') + x.content).join('\n\n');
            const ok = await copyText(text);
            if (ok) {
              await Promise.all(items.map((x) => api(`/api/copies/${x.id}/copy`, { method: 'POST', body: {}, quiet: true }).catch(() => {})));
              toast(`已复制 ${items.length} 条`); close(); load(1);
            } else toast('复制失败', 'error');
          };
        },
      });
    });
    await load(1);
  });
}
