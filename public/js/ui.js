/* COPY ARCHIVE — 共享 UI 组件：分类chip、文案卡片、空状态、分页 */
import { esc, highlight, fmtDate, padNum, api, copyText, toast, openModal, confirmDialog, state } from './core.js';

export function categoryChips(categories, selectedIds = [], { single = false } = {}) {
  const selected = selectedIds.map(Number);
  return categories.map((c) => `
    <button type="button" class="chip ${selected.includes(c.id) ? 'active' : ''}" data-cat="${c.id}" aria-pressed="${selected.includes(c.id)}">
      <span class="cat-dot" style="background:${esc(c.color)}"></span>${esc(c.name)}
    </button>`).join('');
}

export function bindChips(root, onChange) {
  root.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.cat);
      const active = btn.classList.toggle('active');
      btn.setAttribute('aria-pressed', String(active));
      onChange([...root.querySelectorAll('.chip.active')].map((b) => Number(b.dataset.cat)));
    });
  });
}

export function emptyState(code, title, desc, action = '') {
  return `<div class="empty">
    <div class="empty-code">${esc(code)}</div>
    <h2 class="empty-title">${esc(title)}</h2>
    <p class="empty-desc">${esc(desc)}</p>
    ${action}
  </div>`;
}

export function copyCard(item, {
  index = null, query = '', selectable = false, editable = true, publicView = false, list = false,
} = {}) {
  const cats = (item.categories || []).map((c) => `<span class="chip" style="min-height:22px;padding:1px 7px"><span class="cat-dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</span>`).join('');
  const tags = (item.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const long = item.content.length > 260 || item.content.split('\n').length > 6;
  const idx = index === null ? padNum(item.id) : padNum(index);
  const canEdit = editable && !publicView;
  return `
  <article class="copy-card ${selectable ? 'selectable' : ''}" data-copy-id="${item.id}">
    ${selectable ? `<input type="checkbox" class="card-check" data-select="${item.id}" aria-label="选择此文案">` : ''}
    <div class="card-meta-side">
      <div class="card-index">NO. <em>${idx}</em></div>
      ${item.title ? `<div class="card-title">${highlight(item.title, query)}</div>` : ''}
    </div>
    <div class="card-body">
      <div class="card-content ${long ? 'clamped' : ''}" data-content>${highlight(item.content, query)}</div>
      ${long ? '<button class="card-expand" data-expand>展开全文 ↓</button>' : ''}
      ${tags ? `<div class="card-tags">${tags}</div>` : ''}
    </div>
    <div class="card-footer">
      <div>
        <div class="card-cats">${cats || '<span class="tag" style="opacity:.5">未分类</span>'}</div>
        <time datetime="${esc(item.createdAt)}">${fmtDate(item.createdAt)} · 复制 ${item.copyCount}</time>
      </div>
      <div class="card-actions">
        <button class="action-btn" data-action="copy" title="复制正文" aria-label="复制正文" data-raw="${esc(item.content)}">⧉</button>
        ${publicView ? '' : state.user ? `<button class="action-btn ${item.isFavorite ? 'fav-on' : ''}" data-action="favorite" title="${item.isFavorite ? '取消收藏' : '收藏'}" aria-label="收藏">${item.isFavorite ? '★' : '☆'}</button>` : ''}
        <button class="action-btn" data-action="detail" title="查看详情" aria-label="查看详情">↗</button>
        ${canEdit ? `<button class="action-btn" data-action="edit" title="编辑" aria-label="编辑">✎</button>
        <button class="action-btn" data-action="delete" title="删除" aria-label="删除">✕</button>` : ''}
      </div>
    </div>
  </article>`;
}

export function copyGrid(items, options = {}) {
  if (!items.length) return '';
  return `<div class="copy-grid ${options.list ? 'list' : ''}">${items.map((item, i) => copyCard(item, {
    ...options,
    index: (options.startIndex || 0) + i + 1,
  })).join('')}</div>`;
}

/** 绑定卡片交互；回调：onChanged() 数据变更后刷新，onDetail(item) 打开详情 */
export function bindCopyCards(root, { onChanged = () => {}, onDetail = null, onEdit = null, selectable = false } = {}) {
  if (root._copyClickHandler) root.removeEventListener('click', root._copyClickHandler);
  if (root._copyChangeHandler) root.removeEventListener('change', root._copyChangeHandler);
  const handler = async (e) => {
    const expand = e.target.closest('[data-expand]');
    if (expand) {
      const content = expand.parentElement.querySelector('[data-content]');
      const clamped = content.classList.toggle('clamped');
      expand.textContent = clamped ? '展开全文 ↓' : '收起 ↑';
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('[data-copy-id]');
    const id = Number(card.dataset.copyId);
    const action = btn.dataset.action;

    if (action === 'copy') {
      const raw = card.querySelector('[data-raw]').dataset.raw;
      const ok = await copyText(raw);
      if (!ok) {
        openModal({
          kicker: 'MANUAL COPY', title: '手动复制',
          body: `<p class="field-hint" style="margin-bottom:12px">浏览器阻止了自动复制，请全选下方文字手动复制：</p><textarea class="input" rows="8" readonly>${esc(raw)}</textarea>`,
          foot: '<button class="btn btn-sm" data-close>完成</button>',
          onMount(r, close) { r.querySelector('[data-close]').onclick = close; r.querySelector('textarea').select(); },
        });
        return;
      }
      try {
        await api(`/api/copies/${id}/copy`, { method: 'POST', body: {}, quiet: true });
        const time = card.querySelector('time');
        if (time) time.textContent = time.textContent.replace(/复制 \d+/, (m) => '复制 ' + (Number(m.split(' ')[1]) + 1));
      } catch { /* 复制本身已成功 */ }
      btn.classList.add('copied');
      btn.textContent = '✓';
      toast('已复制文案正文');
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '⧉'; }, 1400);
      return;
    }

    if (action === 'favorite') {
      const wanted = !btn.classList.contains('fav-on');
      try {
        await api(`/api/copies/${id}/favorite`, { method: 'POST', body: { value: wanted } });
        btn.classList.toggle('fav-on', wanted);
        btn.textContent = wanted ? '★' : '☆';
        toast(wanted ? '已加入收藏' : '已取消收藏');
        onChanged();
      } catch { /* 已提示 */ }
      return;
    }

    if (action === 'detail') {
      if (onDetail) {
        try {
          let item;
          try {
            item = await api(`/api/copies/${id}`, { quiet: true });
          } catch {
            item = await api(`/api/public/copies/${id}`, { quiet: true });
          }
          onDetail(item);
        } catch {
          const content = card.querySelector('[data-content]').textContent;
          onDetail({ id, content, title: '', categories: [], tags: [], note: '', copyCount: 0, createdAt: '' });
        }
      }
      return;
    }

    if (action === 'edit' && onEdit) { onEdit(id); return; }

    if (action === 'delete') {
      const ok = await confirmDialog('删除后无法恢复。分类关联和收藏记录会一并移除，其他文案不受影响。', {
        title: '删除这条文案？', okText: '确认删除',
      });
      if (!ok) return;
      try {
        await api(`/api/copies/${id}`, { method: 'DELETE' });
        toast('文案已删除');
        onChanged();
      } catch { /* 已提示 */ }
    }
  };
  root._copyClickHandler = handler;
  root.addEventListener('click', handler);

  if (selectable) {
    const changeHandler = (e) => {
      if (e.target.matches('[data-select]')) {
        root.dispatchEvent(new CustomEvent('selectionchange', { bubbles: true }));
      }
    };
    root._copyChangeHandler = changeHandler;
    root.addEventListener('change', changeHandler);
  }
}

export function pagination(meta, onPage) {
  const host = document.createElement('div');
  host.className = 'load-more';
  const totalPages = Math.max(1, Math.ceil(meta.total / meta.pageSize));
  host.innerHTML = meta.hasMore
    ? `<button class="btn btn-sm" data-more>载入更多 · ${meta.items.length} / ${meta.total}</button>`
    : `<span class="mono faint" style="font-size:var(--t-micro)">— 已显示全部 ${meta.total} 条 / 共 ${totalPages} 页 —</span>`;
  const more = host.querySelector('[data-more]');
  if (more) more.addEventListener('click', () => onPage(meta.page + 1, host));
  return host;
}

export function categorySelect(categories, selected = [], id = 'batch-category') {
  return `<select class="select" id="${id}" multiple size="5" style="width:100%;min-height:130px">
    ${categories.map((c) => `<option value="${c.id}" ${selected.includes(c.id) ? 'selected' : ''}>${esc(c.name)}（${c.count}）</option>`).join('')}
  </select>`;
}
