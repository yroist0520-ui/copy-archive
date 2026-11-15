/* 上传：单条 / 批量换行 / 快速粘贴，含导入预览、查重、逐条分类 */
import {
  state, api, route, esc, requireLogin, openAuth, openModal, toast, loadCategories,
} from './core.js';
import { categoryChips, bindChips } from './ui.js';

export function registerUpload() {
  route(/^\/upload$/, async ({ app }) => {
    if (!state.user) {
      app.innerHTML = `<div class="container section" style="padding-top:56px"><div class="empty">
        <div class="empty-code">AUTH REQUIRED</div><h1 class="empty-title">建立档案后才能上传</h1>
        <p class="empty-desc">登录后，你的文案会永久保存在你的私人档案中。</p>
        <button class="btn btn-sm btn-primary" id="up-login">登录 / 注册</button></div></div>`;
      document.getElementById('up-login').addEventListener('click', openAuth);
      return;
    }
    await loadCategories();

    app.innerHTML = `
      <div class="container section" style="padding-top:56px">
        <div class="section-head reveal"><span class="section-index">UPLOAD</span><h1 class="section-title">收录文案</h1><span class="section-note">原文保留 · 不自动改写</span></div>
        <div class="tabs reveal d1">
          <button class="tab active" data-tab="single">01 / 单条录入</button>
          <button class="tab" data-tab="batch">02 / 批量换行</button>
          <button class="tab" data-tab="paste">03 / 快速粘贴</button>
        </div>
        <div id="upload-pane"></div>
      </div>`;

    const pane = app.querySelector('#upload-pane');
    let active = 'single';

    function catPicker(id, selected = []) {
      return `<div class="check-grid" id="${id}">${categoryChips(state.categories, selected)}</div>`;
    }

    function render() {
      if (active === 'single') renderSingle();
      else renderBatch(active === 'paste');
    }
    app.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', () => {
      active = tab.dataset.tab;
      app.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
      render();
    }));
    render();

    function renderSingle() {
      pane.innerHTML = `
        <div class="form-grid reveal">
          <div class="field full"><label class="field-label" for="s-content">文案正文 *</label>
            <textarea class="input" id="s-content" rows="7" placeholder="粘贴或输入文案，保留原始标点与换行…" style="min-height:170px"></textarea>
            <div class="field-hint" id="s-len">0 字符</div></div>
          <div class="field"><label class="field-label" for="s-title">标题（选填）</label><input class="input" id="s-title" placeholder="给这条文案起个名字"></div>
          <div class="field"><label class="field-label" for="s-tags">自定义标签（选填）</label><input class="input" id="s-tags" placeholder="用逗号分隔，如：dream, 清冷"></div>
          <div class="field full"><label class="field-label" for="s-note">备注（选填）</label><textarea class="input" id="s-note" rows="2"></textarea></div>
          <div class="field full"><label class="field-label">关联分类（可多选 / 可留空后补）</label>${catPicker('s-cats')}
            <div class="field-hint">同一条文案可归入多个分类，不会产生重复数据。</div></div>
        </div>
        <div class="modal-foot"><button class="btn btn-sm" id="s-reset">清空</button><button class="btn btn-sm btn-primary" id="s-save">保存到档案</button></div>`;
      const content = pane.querySelector('#s-content');
      content.addEventListener('input', () => { pane.querySelector('#s-len').textContent = `${content.value.length} 字符`; });
      bindChips(pane.querySelector('#s-cats'), () => {});
      pane.querySelector('#s-reset').onclick = () => {
        pane.querySelectorAll('input, textarea').forEach((el) => { el.value = ''; });
        pane.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        content.dispatchEvent(new Event('input'));
      };
      pane.querySelector('#s-save').onclick = async (e) => {
        const text = content.value;
        if (!text.trim()) { toast('请输入文案正文', 'error'); return; }
        e.target.disabled = true;
        try {
          const result = await api('/api/copies', {
            method: 'POST',
            body: {
              content: text,
              title: pane.querySelector('#s-title').value,
              tags: pane.querySelector('#s-tags').value,
              note: pane.querySelector('#s-note').value,
              categoryIds: [...pane.querySelectorAll('#s-cats .chip.active')].map((b) => Number(b.dataset.cat)),
            },
          });
          toast(`已收录，编号 CA-${String(result.id).padStart(5, '0')}`);
          content.value = ''; pane.querySelector('#s-title').value = '';
          pane.querySelector('#s-len').textContent = '0 字符';
          pane.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
          await loadCategories();
        } catch { /* 已提示 */ } finally { e.target.disabled = false; }
      };
    }

    function renderBatch(isPaste) {
      pane.innerHTML = `
        <div class="notice">${isPaste
          ? '把任意来源的多行文字粘贴到下框，每行会作为一条独立文案。空格、标点、Unicode 与行内空白都会被原样保留。'
          : '每行一条文案。空行会被忽略；行首行尾的空格和特殊符号会完整保留。'}</div>
        <div class="field"><label class="field-label" for="b-text">${isPaste ? '粘贴文本' : '批量文本'}</label>
          <textarea class="input" id="b-text" rows="10" placeholder="Dream without limits.&#10;Stay strange.&#10;Lost in another world." style="min-height:220px"></textarea>
          <div class="field-hint"><span id="b-count">0</span> 行将被导入</div></div>
        ${isPaste ? '<button class="btn btn-sm" id="b-clipboard" style="margin-bottom:20px">从剪贴板读取</button>' : ''}
        <div class="field"><label class="field-label">统一分类（可多选，预览时可逐条修改）</label>${catPicker('b-cats')}</div>
        <div class="field"><label class="field-label" for="b-tags">统一标签（选填，逗号分隔）</label><input class="input" id="b-tags"></div>
        <div class="modal-foot">
          <button class="btn btn-sm" id="b-preview">生成导入预览</button>
          <button class="btn btn-sm btn-primary" id="b-save" disabled>确认保存</button>
        </div>
        <div id="b-preview-host" style="margin-top:32px"></div>`;

      const textarea = pane.querySelector('#b-text');
      const updateCount = () => { pane.querySelector('#b-count').textContent = parseLines(textarea.value).length; };
      textarea.addEventListener('input', updateCount);
      bindChips(pane.querySelector('#b-cats'), () => {});
      pane.querySelector('#b-clipboard')?.addEventListener('click', async () => {
        try {
          textarea.value = await navigator.clipboard.readText();
          updateCount();
          toast('已读取剪贴板内容');
        } catch { toast('浏览器未授权读取剪贴板，请手动粘贴', 'error'); }
      });

      let previewItems = [];
      const saveBtn = pane.querySelector('#b-save');
      pane.querySelector('#b-preview').addEventListener('click', async () => {
        const lines = parseLines(textarea.value);
        if (!lines.length) { toast('没有可导入的内容', 'error'); return; }
        const globalCats = [...pane.querySelectorAll('#b-cats .chip.active')].map((b) => Number(b.dataset.cat));
        const tags = pane.querySelector('#b-tags').value;
        previewItems = lines.map((content) => ({ content, categoryIds: [...globalCats], tags }));
        let existing = {};
        try {
          const r = await api('/api/copies/check-duplicates', { method: 'POST', body: { contents: lines }, quiet: true });
          existing = r.existing;
        } catch { /* 查重失败不阻断导入 */ }
        const seen = new Set();
        const dupFlags = lines.map((line) => {
          const dup = Boolean(existing[line]) || seen.has(line);
          seen.add(line);
          return dup;
        });
        const dupCount = dupFlags.filter(Boolean).length;
        pane.querySelector('#b-preview-host').innerHTML = `
          <div class="section-head"><span class="section-index">PREVIEW</span><h2 class="section-title">导入预览</h2>
            <span class="section-note">${lines.length} 条 · ${dupCount} 条疑似重复</span></div>
          ${dupCount ? `<div class="notice">检测到 ${dupCount} 条与档案中已有内容完全相同（或本次重复）。系统只做提醒，不会擅自删除；你仍可照常保存。</div>` : ''}
          <div class="preview-list">${lines.map((line, i) => `
            <div class="preview-row ${dupFlags[i] ? 'dup' : ''}" data-row="${i}">
              <div class="preview-num">${String(i + 1).padStart(2, '0')}</div>
              <div class="preview-text">${esc(line)}</div>
              <div style="text-align:right">
                ${dupFlags[i] ? '<div class="preview-flag">重复</div>' : ''}
                <button class="link-btn" data-row-cat="${i}">分类 ${previewItems[i].categoryIds.length ? '· ' + previewItems[i].categoryIds.length : ''}</button>
              </div>
            </div>`).join('')}</div>`;
        pane.querySelectorAll('[data-row-cat]').forEach((btn) => btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.rowCat);
          openModal({
            kicker: 'PER ENTRY CATEGORY', title: `第 ${idx + 1} 条的分类`,
            body: `<p class="field-hint" style="margin-bottom:12px">${esc(previewItems[idx].content.slice(0, 80))}</p>${catPicker('row-cats', previewItems[idx].categoryIds)}`,
            foot: '<button class="btn btn-sm btn-primary" data-ok>完成</button>',
            onMount(root, close) {
              bindChips(root.querySelector('#row-cats'), (ids) => { previewItems[idx].categoryIds = ids; });
              root.querySelector('[data-ok]').onclick = close;
            },
          });
        }));
        saveBtn.disabled = false;
        saveBtn.textContent = `确认保存 ${lines.length} 条`;
      });

      saveBtn.addEventListener('click', async () => {
        if (!previewItems.length) return;
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
        try {
          const result = await api('/api/copies/batch', {
            method: 'POST', body: { items: previewItems },
          });
          toast(`成功收录 ${result.count} 条文案`);
          textarea.value = ''; updateCount();
          pane.querySelector('#b-preview-host').innerHTML = '';
          previewItems = [];
          saveBtn.disabled = true;
          saveBtn.textContent = '确认保存';
          await loadCategories();
        } catch { /* 已提示 */ } finally {
          saveBtn.disabled = false;
          if (previewItems.length) saveBtn.textContent = `确认保存 ${previewItems.length} 条`;
        }
      });
    }
  });
}

/** 按换行拆分，只丢弃完全空行，不做 trim，不改标点/空格/Unicode */
function parseLines(text) {
  return String(text || '').split(/\r\n|\n|\r/).filter((line) => line !== '');
}
