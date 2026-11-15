/* 文案详情与编辑弹层 */
import {
  api, esc, fmtDate, openModal, toast, copyText, state, renderRoute, confirmDialog,
} from './core.js';
import { categoryChips, bindChips } from './ui.js';

export function openDetail(item) {
  const cats = (item.categories || []).map((c) => `<span class="chip" style="--cat-color:${esc(c.color)}"><span class="cat-dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</span>`).join('');
  const tags = (item.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const own = state.user && Number(item.ownerId) === state.user.id;
  openModal({
    kicker: 'ENTRY / ' + String(item.id).padStart(5, '0'),
    title: item.title || '文案详情',
    wide: true,
    body: `
      <div class="detail-content">${esc(item.content)}</div>
      ${tags ? `<div class="card-tags">${tags}</div>` : ''}
      <dl class="detail-meta">
        <div><dt>所属分类</dt><dd><div class="chip-row">${cats || '<span class="muted">未分类</span>'}</div></dd></div>
        <div><dt>上传时间</dt><dd class="mono">${fmtDate(item.createdAt, true)}</dd></div>
        <div><dt>复制次数</dt><dd class="mono">${item.copyCount ?? 0}</dd></div>
        <div><dt>备注</dt><dd>${esc(item.note || '—')}</dd></div>
      </dl>`,
    foot: `
      <button class="btn btn-sm" data-copy>复制正文</button>
      ${own ? '<button class="btn btn-sm" data-edit>编辑</button>' : ''}
      <button class="btn btn-sm" data-close>关闭</button>`,
    onMount(root, close) {
      root.querySelector('[data-close]').onclick = close;
      root.querySelector('[data-copy]').onclick = async (e) => {
        const ok = await copyText(item.content);
        if (!ok) { toast('复制失败', 'error'); return; }
        try { await api(`/api/copies/${item.id}/copy`, { method: 'POST', body: {}, quiet: true }); } catch { /* 忽略 */ }
        e.target.textContent = '已复制';
        e.target.classList.add('copied');
        toast('已复制文案正文');
      };
      root.querySelector('[data-edit]')?.addEventListener('click', () => { close(); openEditById(item.id); });
    },
  });
}

export async function openEditById(id) {
  let item;
  try {
    item = await api(`/api/copies/${id}`, { quiet: true });
  } catch {
    toast('文案不存在或无权编辑', 'error');
    return;
  }
  openEdit(item);
}

export function openEdit(item) {
  const selected = (item.categories || []).map((c) => c.id);
  openModal({
    kicker: 'EDIT ENTRY / ' + String(item.id).padStart(5, '0'),
    title: '编辑文案',
    wide: true,
    body: `
      <div class="field"><label class="field-label" for="edit-content">文案正文 *</label>
        <textarea class="input" id="edit-content" rows="8" style="min-height:190px">${esc(item.content)}</textarea>
        <div class="field-hint">保留原始标点、空格与换行，不会被自动改写。</div></div>
      <div class="form-grid">
        <div class="field"><label class="field-label" for="edit-title">标题（选填）</label><input class="input" id="edit-title" value="${esc(item.title || '')}"></div>
        <div class="field"><label class="field-label" for="edit-tags">标签（逗号分隔）</label><input class="input" id="edit-tags" value="${esc((item.tags || []).join(', '))}"></div>
      </div>
      <div class="field"><label class="field-label" for="edit-note">备注（选填）</label><textarea class="input" id="edit-note" rows="2">${esc(item.note || '')}</textarea></div>
      <div class="field"><label class="field-label">关联分类（可多选）</label>
        <div class="check-grid" id="edit-cats">${categoryChips(state.categories, selected).replace(/class="chip /g, 'class="chip edit-cat ').replace(/class="chip"/g, 'class="chip edit-cat"')}</div>
      </div>`,
    foot: `<button class="btn btn-sm" data-cancel>取消</button><button class="btn btn-sm btn-primary" data-save>保存修改</button>`,
    onMount(root, close) {
      bindChips(root.querySelector('#edit-cats'), () => {});
      root.querySelector('[data-cancel]').onclick = close;
      root.querySelector('[data-save]').onclick = async (e) => {
        const content = root.querySelector('#edit-content').value;
        if (!content.trim()) { toast('文案正文不能为空', 'error'); return; }
        const categoryIds = [...root.querySelectorAll('#edit-cats .chip.active')].map((b) => Number(b.dataset.cat));
        e.target.disabled = true;
        try {
          await api(`/api/copies/${item.id}`, {
            method: 'PATCH',
            body: {
              content,
              title: root.querySelector('#edit-title').value,
              note: root.querySelector('#edit-note').value,
              tags: root.querySelector('#edit-tags').value,
              categoryIds,
            },
          });
          toast('修改已保存');
          close();
          renderRoute();
        } catch { /* 已提示 */ } finally { e.target.disabled = false; }
      };
    },
  });
}
