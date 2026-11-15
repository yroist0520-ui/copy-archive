/* 文案库：搜索、筛选、排序、双视图、分页、批量管理 */
import {
  state, api, route, esc, debounce, navigate, requireLogin, openAuth,
  openModal, confirmDialog, toast, copyText, currentQuery, loadCategories,
} from './core.js';
import {
  copyGrid, bindCopyCards, emptyState, categoryChips, bindChips, pagination,
} from './ui.js';

export function registerArchive() {
  route(/^\/archive$/, async ({ app }) => {
    if (!state.user) {
      app.innerHTML = `<div class="container section">${emptyState('PRIVATE ARCHIVE', '文案库需要登录', '登录后可管理你保存的全部文案。', '<button class="btn btn-sm btn-primary" id="archive-login">登录 / 注册</button>')}</div>`;
      document.getElementById('archive-login').addEventListener('click', openAuth);
      return;
    }

    const q0 = currentQuery().get('q') || '';
    const cat0 = currentQuery().get('category');
    const view = {
      q: q0,
      categoryIds: cat0 ? [Number(cat0)] : [],
      favoriteOnly: false,
      sort: 'newest',
      mode: localStorage.getItem('ca_view') || 'grid',
      page: 1,
      meta: { items: [], total: 0, hasMore: false, pageSize: state.pageSize },
      selection: new Set(),
    };

    app.innerHTML = `
      <div class="container section" style="padding-top:56px">
        <div class="section-head reveal"><span class="section-index">ARCHIVE</span><h1 class="section-title">文案库</h1><span class="section-note" id="archive-count">— 条记录</span></div>

        <div class="search-field reveal d1" style="margin-bottom:20px">
          <span class="search-glyph">⌕</span>
          <input class="search-input" id="archive-search" type="search" autocomplete="off" placeholder="搜索正文、标题、分类或标签…" value="${esc(view.q)}">
          <button class="search-clear hidden" id="archive-clear" aria-label="清除">✕</button>
        </div>

        <div class="toolbar reveal d2">
          <div class="toolbar-group"><span class="toolbar-label">分类</span><select class="select" id="filter-category"><option value="">全部分类</option>${state.categories.map((c) => `<option value="${c.id}" ${view.categoryIds[0] === c.id ? 'selected' : ''}>${esc(c.name)}（${c.count}）</option>`).join('')}</select></div>
          <div class="toolbar-group"><span class="toolbar-label">排序</span><select class="select" id="filter-sort">
            <option value="newest">最新上传</option><option value="oldest">最早上传</option>
            <option value="favorite">收藏优先</option><option value="copies">复制次数</option><option value="random">随机浏览</option>
          </select></div>
          <div class="toolbar-group"><button class="chip" id="filter-fav" aria-pressed="false">☆ 仅看收藏</button></div>
          <div class="toolbar-group" style="margin-left:auto">
            <div class="segmented"><button data-mode="grid" class="${view.mode === 'grid' ? 'active' : ''}">网格</button><button data-mode="list" class="${view.mode === 'list' ? 'active' : ''}">列表</button></div>
          </div>
        </div>

        <div class="toolbar hidden" id="batch-bar">
          <span class="mono" style="font-size:var(--t-small)">已选 <b id="batch-num" class="accent">0</b> 条</span>
          <button class="btn btn-sm" data-batch="copy">批量复制</button>
          <button class="btn btn-sm" data-batch="favorite">收藏</button>
          <button class="btn btn-sm" data-batch="unfavorite">取消收藏</button>
          <button class="btn btn-sm" data-batch="addcat">添加分类</button>
          <button class="btn btn-sm" data-batch="remcat">移除分类</button>
          <button class="btn btn-sm btn-danger" data-batch="delete">删除</button>
          <button class="link-btn" data-batch="clear" style="margin-left:auto">取消选择</button>
        </div>

        <div id="archive-content"></div>
        <div id="archive-pager"></div>
      </div>`;

    const content = app.querySelector('#archive-content');
    const pager = app.querySelector('#archive-pager');
    const batchBar = app.querySelector('#batch-bar');
    const search = app.querySelector('#archive-search');
    const clear = app.querySelector('#archive-clear');
    app.querySelector('#filter-sort').value = view.sort;

    function selectedIds() {
      return [...view.selection];
    }

    function updateBatchBar() {
      const n = selectedIds().length;
      batchBar.classList.toggle('hidden', n === 0);
      app.querySelector('#batch-num').textContent = n;
    }

    content.addEventListener('change', (e) => {
      if (!e.target.matches('[data-select]')) return;
      const id = Number(e.target.dataset.select);
      if (e.target.checked) view.selection.add(id); else view.selection.delete(id);
      updateBatchBar();
    });

    function renderItems(append = false) {
      const { items, total } = view.meta;
      if (!items.length) {
        content.innerHTML = emptyState(
          view.q ? 'NO MATCH' : 'EMPTY ARCHIVE',
          view.q ? '没有匹配的文案' : '档案还是空的',
          view.q ? '试试更换关键词或清除筛选条件。' : '上传第一条文案，让档案开始生长。',
          view.q ? '<button class="btn btn-sm" id="reset-filters">清除筛选</button>' : '<a class="btn btn-sm btn-primary" href="/upload" data-link>＋ 上传文案</a>',
        );
        app.querySelector('#reset-filters')?.addEventListener('click', () => {
          view.q = ''; view.categoryIds = []; view.favoriteOnly = false;
          search.value = ''; app.querySelector('#filter-category').value = '';
          app.querySelector('#filter-fav').classList.remove('active');
          load(1);
        });
      } else {
        content.innerHTML = copyGrid(items, { query: view.q, list: view.mode === 'list', selectable: true, startIndex: 0 });
        view.selection.forEach((id) => {
          const box = content.querySelector(`[data-select="${id}"]`);
          if (box) box.checked = true;
        });
        bindCopyCards(content, { onChanged: () => load(1), onDetail: openDetailFor, onEdit: openEdit });
      }
      app.querySelector('#archive-count').textContent = `${total} 条记录`;
      pager.innerHTML = '';
      if (items.length) {
        pager.appendChild(pagination(view.meta, (next) => load(next, true)));
      }
    }

    async function load(page = 1, append = false) {
      view.page = page;
      if (!append) { view.selection.clear(); updateBatchBar(); }
      const params = new URLSearchParams({ page: String(page), pageSize: String(state.pageSize), sort: view.sort });
      if (view.q) params.set('q', view.q);
      if (view.categoryIds.length) params.set('category', view.categoryIds.join(','));
      if (view.favoriteOnly) params.set('favorite', '1');
      try {
        const data = await api('/api/copies?' + params.toString(), { quiet: true });
        view.meta = append ? { ...data, items: [...contentCache, ...data.items] } : data;
        contentCache = view.meta.items.slice();
        renderItems();
      } catch (err) {
        if (!append) content.innerHTML = emptyState('LOAD ERROR', '加载失败', err.message);
      }
    }
    let contentCache = [];

    search.addEventListener('input', debounce(() => {
      view.q = search.value;
      clear.classList.toggle('hidden', !view.q);
      load(1);
    }, 250));
    clear.addEventListener('click', () => { search.value = ''; view.q = ''; clear.classList.add('hidden'); load(1); search.focus(); });
    app.querySelector('#filter-category').addEventListener('change', (e) => {
      view.categoryIds = e.target.value ? [Number(e.target.value)] : [];
      load(1);
    });
    app.querySelector('#filter-sort').addEventListener('change', (e) => { view.sort = e.target.value; load(1); });
    app.querySelector('#filter-fav').addEventListener('click', (e) => {
      view.favoriteOnly = !view.favoriteOnly;
      e.target.classList.toggle('active', view.favoriteOnly);
      e.target.textContent = view.favoriteOnly ? '★ 仅看收藏' : '☆ 仅看收藏';
      load(1);
    });
    app.querySelectorAll('[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
      view.mode = btn.dataset.mode;
      localStorage.setItem('ca_view', view.mode);
      app.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      renderItems();
    }));

    batchBar.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-batch]')?.dataset.batch;
      if (!action) return;
      const ids = selectedIds();
      if (action === 'clear') { view.selection.clear(); updateBatchBar(); renderItems(); return; }
      if (action === 'copy') {
        if (!ids.length) return;
        const byId = new Map(view.meta.items.map((x) => [x.id, x]));
        const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
        openModal({
          kicker: 'BATCH COPY', title: `复制 ${ordered.length} 条文案`,
          body: `<label class="check-item" style="border:1px solid var(--rule);background:var(--surface)"><input type="checkbox" id="with-number"> 添加序号（01. 02. …）</label>
                 <p class="field-hint" style="margin-top:12px">按当前列表顺序排列，每条之间保留一个空行。仅复制正文。</p>`,
          foot: '<button class="btn btn-sm" data-cancel>取消</button><button class="btn btn-sm btn-primary" data-copy>复制到剪贴板</button>',
          onMount(root, close) {
            root.querySelector('[data-cancel]').onclick = close;
            root.querySelector('[data-copy]').onclick = async () => {
              const numbered = root.querySelector('#with-number').checked;
              const text = ordered.map((x, i) => (numbered ? `${String(i + 1).padStart(2, '0')}. ` : '') + x.content).join('\n\n');
              const ok = await copyText(text);
              if (ok) {
                await Promise.all(ordered.map((x) => api(`/api/copies/${x.id}/copy`, { method: 'POST', body: {}, quiet: true }).catch(() => {})));
                toast(`已复制 ${ordered.length} 条文案`);
                close();
                load(1);
              } else toast('复制失败，请检查浏览器权限', 'error');
            };
          },
        });
        return;
      }
      if (action === 'delete') {
        const ok = await confirmDialog(`将删除选中的 ${ids.length} 条文案，此操作无法撤销。`, { title: '批量删除', okText: '确认删除' });
        if (!ok) return;
        try {
          await api('/api/copies/bulk', { method: 'POST', body: { ids, action: 'delete' } });
          toast(`已删除 ${ids.length} 条`);
          view.selection.clear(); load(1);
        } catch { /* 已提示 */ }
        return;
      }
      if (action === 'addcat' || action === 'remcat') {
        openModal({
          kicker: 'BATCH CATEGORY', title: action === 'addcat' ? '批量添加分类' : '批量移除分类',
          body: `<p class="field-hint" style="margin-bottom:12px">可多选。移除分类不会删除文案。</p>
                 <div class="check-grid">${state.categories.map((c) => `<label class="check-item" style="--cat-color:${esc(c.color)}"><input type="checkbox" value="${c.id}"><span class="cat-dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</label>`).join('')}</div>`,
          foot: '<button class="btn btn-sm" data-cancel>取消</button><button class="btn btn-sm btn-primary" data-ok>确认</button>',
          onMount(root, close) {
            root.querySelector('[data-cancel]').onclick = close;
            root.querySelector('[data-ok]').onclick = async () => {
              const categoryIds = [...root.querySelectorAll('input:checked')].map((i) => Number(i.value));
              if (!categoryIds.length) { toast('请至少选择一个分类', 'error'); return; }
              try {
                const result = await api('/api/copies/bulk', {
                  method: 'POST', body: { ids, action: action === 'addcat' ? 'add_category' : 'remove_category', categoryIds },
                });
                toast(`已处理 ${result.count} 条`);
                close(); load(1);
              } catch { /* 已提示 */ }
            };
          },
        });
        return;
      }
      try {
        const result = await api('/api/copies/bulk', { method: 'POST', body: { ids, action } });
        toast(`已处理 ${result.count} 条`);
        view.selection.clear(); load(1);
      } catch { /* 已提示 */ }
    });

    await load(1);
    if (currentQuery().get('focus')) setTimeout(() => search.focus(), 200);
  });
}

export function openDetailFor(item) {
  import('./detail.js').then(({ openDetail }) => openDetail(item));
}

export function openEdit(id) {
  import('./detail.js').then(({ openEditById }) => openEditById(id));
}
