/* 分类管理：新建、改名、配色、排序、删除（只解除关联）、查看分类文案 */
import {
  state, api, route, esc, loadCategories, openAuth, openModal, confirmDialog, toast, navigate, requireLogin,
} from './core.js';
import { emptyState } from './ui.js';

export function registerCategories() {
  route(/^\/categories$/, async ({ app }) => {
    if (!state.user) {
      app.innerHTML = `<div class="container section">${emptyState('AUTH REQUIRED', '分类管理需要登录', '登录后即可获得 30 个推荐分类，并自由增删改。', '<button class="btn btn-sm btn-primary" id="cat-login">登录 / 注册</button>')}</div>`;
      document.getElementById('cat-login').addEventListener('click', openAuth);
      return;
    }
    await loadCategories();
    app.innerHTML = `
      <div class="container section" style="padding-top:56px">
        <div class="section-head reveal"><span class="section-index">TAXONOMY</span><h1 class="section-title">分类管理</h1>
          <span class="section-note">${state.categories.length} 个分类 · 一条文案可属于多个分类</span></div>
        <div class="notice reveal d1">删除分类只会解除它与文案的关联，<strong>不会删除任何文案</strong>。自定义分类可改名、改色和调整顺序。</div>
        <div class="toolbar reveal d1"><div class="toolbar-group"><input class="input" id="cat-new" placeholder="新分类名称" style="width:220px">
          <input type="color" id="cat-color" value="#b23a2b" class="color-input" aria-label="分类颜色"></div>
          <button class="btn btn-sm btn-primary" id="cat-create">＋ 新建分类</button></div>
        <div id="cat-list" class="reveal d2"></div>
      </div>`;
    const host = app.querySelector('#cat-list');

    function render() {
      const groups = {};
      state.categories.forEach((c) => { (groups[c.group] ||= []).push(c); });
      host.innerHTML = Object.entries(groups).map(([group, list]) => `
        <div class="group-label">${esc(group)} — ${String(list.length).padStart(2, '0')}</div>
        <div class="manage-row manage-head mono faint" style="font-size:var(--t-micro)">
          <span></span><span>分类名称</span><span>配色</span><span>文案数量</span><span style="text-align:right">操作</span>
        </div>
        ${list.map((c, i) => `
          <div class="manage-row" data-id="${c.id}">
            <span class="mono faint">${String(i + 1).padStart(2, '0')}</span>
            <button class="cat-name" style="text-align:left;--cat-color:${esc(c.color)}" data-view="${c.id}"><span class="cat-dot" style="display:inline-block;width:8px;height:8px;background:${esc(c.color)};margin-right:8px"></span>${esc(c.name)}</button>
            <span><input type="color" value="${esc(c.color)}" data-color="${c.id}" class="color-input color-input-sm" aria-label="修改颜色"></span>
            <a class="mono link-btn" href="/archive?category=${c.id}" data-link>${c.count} 条 ↗</a>
            <div class="manage-actions">
              <button class="move-btn" data-move="up" title="上移" aria-label="上移"></button>
              <button class="move-btn" data-move="down" title="下移" aria-label="下移"></button>
              <button class="move-btn" data-edit="${c.id}" title="改名" aria-label="改名"></button>
              <button class="move-btn" data-del="${c.id}" title="删除" aria-label="删除"></button>
            </div>
          </div>`).join('')}`).join('');
    }
    render();

    app.querySelector('#cat-create').addEventListener('click', async () => {
      const input = app.querySelector('#cat-new');
      const name = input.value.trim();
      if (!name) { toast('请输入分类名称', 'error'); return; }
      try {
        await api('/api/categories', {
          method: 'POST', body: { name, color: app.querySelector('#cat-color').value },
        });
        toast(`分类「${name}」已创建`);
        input.value = '';
        await loadCategories(); render();
      } catch { /* 已提示 */ }
    });
    app.querySelector('#cat-new').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') app.querySelector('#cat-create').click();
    });

    host.addEventListener('change', async (e) => {
      const id = e.target.dataset.color;
      if (!id) return;
      try {
        await api(`/api/categories/${id}`, { method: 'PATCH', body: { color: e.target.value } });
        await loadCategories(); render();
      } catch { /* 已提示 */ }
    });

    host.addEventListener('click', async (e) => {
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const c = state.categories.find((x) => x.id === Number(edit.dataset.edit));
        openModal({
          kicker: 'RENAME CATEGORY', title: '修改分类',
          body: `<div class="field"><label class="field-label">分类名称</label><input class="input" id="rename-input" value="${esc(c.name)}"></div>`,
          foot: '<button class="btn btn-sm" data-cancel>取消</button><button class="btn btn-sm btn-primary" data-ok>保存</button>',
          onMount(root, close) {
            root.querySelector('[data-cancel]').onclick = close;
            root.querySelector('[data-ok]').onclick = async () => {
              const name = root.querySelector('#rename-input').value.trim();
              if (!name) return;
              try {
                await api(`/api/categories/${c.id}`, { method: 'PATCH', body: { name } });
                toast('分类已更新'); close(); await loadCategories(); render();
              } catch { /* 已提示 */ }
            };
          },
        });
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        const id = Number(del.dataset.del);
        const c = state.categories.find((x) => x.id === id);
        const ok = await confirmDialog(
          `将删除分类「${c.name}」。该分类下的 ${c.count} 条文案会被完整保留，只解除分类关联。`,
          { title: '删除分类', okText: '确认删除' },
        );
        if (!ok) return;
        try {
          await api(`/api/categories/${id}`, { method: 'DELETE' });
          toast('分类已删除，文案已保留'); await loadCategories(); render();
        } catch { /* 已提示 */ }
        return;
      }
      const move = e.target.closest('[data-move]');
      if (move) {
        const row = move.closest('[data-id]');
        const id = Number(row.dataset.id);
        const index = state.categories.findIndex((x) => x.id === id);
        const next = move.dataset.move === 'up' ? index - 1 : index + 1;
        if (next < 0 || next >= state.categories.length) return;
        const ids = state.categories.map((x) => x.id);
        [ids[index], ids[next]] = [ids[next], ids[index]];
        try {
          await api('/api/categories/reorder', { method: 'POST', body: { ids } });
          await loadCategories(); render();
        } catch { /* 已提示 */ }
        return;
      }
      const view = e.target.closest('[data-view]');
      if (view) navigate(`/archive?category=${view.dataset.view}`);
    });
  });
}
