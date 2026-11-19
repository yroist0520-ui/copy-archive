/* 上传：单条 / 批量换行 / 快速粘贴 / 链接导入（网页抓取 + 图片 OCR），含导入预览、查重、逐条分类 */
import {
  state, api, route, esc, requireLogin, openAuth, openModal, toast, loadCategories, appUrl,
} from './core.js';
import { categoryChips, bindChips } from './ui.js';

/* ===========================================================================
 * 链接导入：抓取网页 → 提取文字（按行）→ 图片 OCR → 勾选编辑 → 统一分类 → 批量导入
 * =========================================================================== */

let tessLibPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`加载失败: ${src}`));
    document.head.appendChild(el);
  });
}

/** OCR 引擎按需加载（双 CDN 兜底），首次加载中文语言包需要一些时间 */
async function loadTesseractLib() {
  if (!tessLibPromise) {
    tessLibPromise = (async () => {
      const sources = [
        'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js',
        'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
      ];
      for (const src of sources) {
        try {
          await loadScript(src);
          if (window.Tesseract) return window.Tesseract;
        } catch { /* 换下一个源 */ }
      }
      throw new Error('OCR 引擎加载失败，请检查网络');
    })();
  }
  return tessLibPromise;
}

/** OCR 文本行清洗：去短行、去重、修复中文 OCR 的字间空格 */
function cleanOcrLines(text, existingKeys = new Set()) {
  const out = [];
  const seen = new Set(existingKeys);
  for (const raw of String(text || '').split(/\r?\n/)) {
    // 中文 OCR 常见字间空格："你 被 大 地" → "你被大地"（仅压缩 CJK/中文标点间的空格）
    const line = raw.trim().replace(
      /([\u4e00-\u9fff、。！？；：，"'（）「」『』【】《》…—·])\s+(?=[\u4e00-\u9fff、。！？；：，"'（）「」『』【】《》…—·])/g,
      '$1',
    );
    if (line.length < 2) continue;
    const key = line.replace(/\s+/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

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
          <button class="tab" data-tab="link">04 / 链接导入</button>
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
      else if (active === 'link') renderLink();
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
      let pendingItems = [];
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
        } catch { /* 查重失败不阻断导入；后端仍会兜底跳过 */ }
        const seen = new Set();
        const dupFlags = lines.map((line) => {
          const dup = Boolean(existing[line]) || seen.has(line);
          seen.add(line);
          return dup;
        });
        const dupCount = dupFlags.filter(Boolean).length;
        const keepCount = lines.length - dupCount;
        pendingItems = previewItems.filter((_, i) => !dupFlags[i]);
        pane.querySelector('#b-preview-host').innerHTML = `
          <div class="section-head"><span class="section-index">PREVIEW</span><h2 class="section-title">导入预览</h2>
            <span class="section-note">${lines.length} 条 · 跳过 ${dupCount} 条重复 · 导入 ${keepCount} 条</span></div>
          ${dupCount ? `<div class="notice">检测到 ${dupCount} 条与档案中已有内容相同（或本次重复），这些行会自动跳过，只导入剩余 ${keepCount} 条。</div>` : ''}
          <div class="preview-list">${lines.map((line, i) => `
            <div class="preview-row ${dupFlags[i] ? 'dup' : ''}" data-row="${i}">
              <div class="preview-num">${String(i + 1).padStart(2, '0')}</div>
              <div class="preview-text">${esc(line)}</div>
              <div style="text-align:right">
                ${dupFlags[i]
                  ? '<div class="preview-flag">跳过 · 重复</div>'
                  : `<button class="link-btn" data-row-cat="${i}">分类 ${previewItems[i].categoryIds.length ? '· ' + previewItems[i].categoryIds.length : ''}</button>`}
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
        saveBtn.disabled = keepCount === 0;
        saveBtn.textContent = keepCount ? `确认保存 ${keepCount} 条` : '无可导入文案';
      });

      saveBtn.addEventListener('click', async () => {
        if (!pendingItems.length) return;
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
        try {
          const result = await api('/api/copies/batch', {
            method: 'POST', body: { items: pendingItems },
          });
          const skipped = Number(result.skipped || 0);
          toast(result.count
            ? `成功收录 ${result.count} 条文案${skipped ? `，跳过 ${skipped} 条重复` : ''}`
            : `全部为重复文案，已跳过 ${skipped} 条`);
          textarea.value = ''; updateCount();
          pane.querySelector('#b-preview-host').innerHTML = '';
          previewItems = []; pendingItems = [];
          saveBtn.disabled = true;
          saveBtn.textContent = '确认保存';
          await loadCategories();
        } catch { /* 已提示 */ } finally {
          saveBtn.disabled = !pendingItems.length;
          if (pendingItems.length) saveBtn.textContent = `确认保存 ${pendingItems.length} 条`;
        }
      });
    }

    /* ---------- 04 / 链接导入 ---------- */

    function renderLink() {
      pane.innerHTML = `
        <div class="notice">粘贴文章链接（公众号文章、网页日志…），自动打开链接提取文案：文字按行拆成一条条，图片里的文字可一键识别。导入前可逐条勾选、编辑，可单选或多选分类。</div>
        <div class="field"><label class="field-label" for="l-url">文章链接</label>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <input class="input" id="l-url" placeholder="https://mp.weixin.qq.com/s/…" style="flex:1;min-width:220px">
            <button class="btn btn-sm btn-primary" id="l-fetch">抓取内容</button>
          </div>
          <div class="field-hint">支持公众号文章与普通网页；图片较多的页面会自动提取图片供识别。</div></div>
        <div id="l-result"></div>`;

      const urlInput = pane.querySelector('#l-url');
      const fetchBtn = pane.querySelector('#l-fetch');
      const run = async () => {
        const url = urlInput.value.trim();
        if (!url) { toast('请先粘贴链接', 'error'); return; }
        fetchBtn.disabled = true;
        fetchBtn.textContent = '抓取中…';
        try {
          const res = await api('/api/fetch-url', { method: 'POST', body: { url } });
          renderLinkResult(res);
        } catch { /* api 已提示 */ } finally {
          fetchBtn.disabled = false;
          fetchBtn.textContent = '抓取内容';
        }
      };
      fetchBtn.addEventListener('click', run);
      urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    }

    function renderLinkResult(res) {
      const host = pane.querySelector('#l-result');
      let linesData = res.lines.map((t) => ({ text: t, keep: true, src: 'text' }));
      let imagesData = res.images.map((url) => ({ url, keep: false }));
      const ocrSrcKey = () => new Set(linesData.map((l) => l.text.replace(/\s+/g, '')));

      // 图片地址：完整版走同源代理（绕防盗链、OCR 可跨域）；本地版直接用原地址
      // appUrl 自动附加 sharecode——代理抓取自域图片时服务端需要它过网关
      const imgSrc = (url) => state.localMode
        ? url
        : appUrl(`/api/proxy-image?url=${encodeURIComponent(url)}`);

      host.innerHTML = `
        <div class="section-head" style="margin-top:28px"><span class="section-index">EXTRACTED</span>
          <h2 class="section-title">${esc(res.title || '提取结果')}</h2>
          <span class="section-note">${linesData.length} 行文字 · ${imagesData.length} 张图片</span></div>
        <div class="field"><label class="field-label">文字内容 <span class="field-hint" style="display:inline">（勾选要导入的行，可直接修改文字）</span></label>
          <div style="display:flex;gap:8px;margin-bottom:10px">
            <button class="btn btn-sm" id="l-sel-all">全选</button>
            <button class="btn btn-sm" id="l-sel-none">清空</button>
            <span class="field-hint" id="l-keep-count" style="align-self:center"></span>
          </div>
          <div id="l-lines"></div></div>
        ${imagesData.length ? `
        <div class="field"><label class="field-label">图片 <span class="field-hint" style="display:inline">（勾选图片后点「识别勾选图片」，图片中的文字会追加到上方列表）</span></label>
          <div class="l-img-grid" id="l-imgs">
            ${imagesData.map((im, i) => `
            <figure class="l-img-cell" data-img="${i}">
              <img src="${esc(imgSrc(im.url))}" loading="lazy" alt="" onerror="this.classList.add('l-img-broken')">
              <figcaption>
                <label class="l-img-check"><input type="checkbox" class="l-img-check-box" data-img-check="${i}"> 选择</label>
                <button class="link-btn" data-ocr-one="${i}">识别此图</button>
              </figcaption>
              <div class="field-hint l-img-status" id="l-img-status-${i}"></div>
            </figure>`).join('')}
          </div>
          <div style="margin-top:10px"><button class="btn btn-sm" id="l-ocr-all">识别勾选图片</button>
            <span class="field-hint" style="margin-left:10px">首次识别需下载中文识别引擎（约 10MB），请耐心等待</span></div>` : ''}
        <div class="field"><label class="field-label">统一分类（可单选 / 多选，导入前可逐条改）</label>
          <div class="check-grid" id="l-cats">${categoryChips(state.categories, [])}</div></div>
        <div class="field"><label class="field-label" for="l-tags">统一标签（选填，逗号分隔）</label><input class="input" id="l-tags"></div>
        <div class="modal-foot"><button class="btn btn-sm btn-primary" id="l-preview">生成导入预览</button></div>
        <div id="l-preview-host" style="margin-top:32px"></div>`;

      const lineList = host.querySelector('#l-lines');
      const keepCount = host.querySelector('#l-keep-count');

      function renderLineList() {
        lineList.innerHTML = linesData.map((l, i) => `
          <div class="l-line-row" data-line="${i}">
            <input type="checkbox" class="l-line-check" data-line-check="${i}" ${l.keep ? 'checked' : ''} aria-label="选择此行">
            <input type="text" class="input l-line-input" data-line-text="${i}" value="${esc(l.text)}">
            ${l.src === 'ocr' ? '<span class="l-line-badge">OCR</span>' : ''}
          </div>`).join('');
        lineList.querySelectorAll('[data-line-check]').forEach((cb) => cb.addEventListener('change', () => {
          linesData[Number(cb.dataset.lineCheck)].keep = cb.checked;
          updateKeep();
        }));
        lineList.querySelectorAll('[data-line-text]').forEach((inp) => inp.addEventListener('input', () => {
          linesData[Number(inp.dataset.lineText)].text = inp.value;
        }));
        updateKeep();
      }
      function updateKeep() {
        const n = linesData.filter((l) => l.keep).length;
        keepCount.textContent = `已选 ${n} / ${linesData.length} 行`;
      }
      host.querySelector('#l-sel-all').onclick = () => { linesData.forEach((l) => { l.keep = true; }); renderLineList(); };
      host.querySelector('#l-sel-none').onclick = () => { linesData.forEach((l) => { l.keep = false; }); renderLineList(); };
      bindChips(host.querySelector('#l-cats'), () => {});
      renderLineList();

      /* ---- OCR ---- */
      let ocrBusy = false;
      async function ocrImages(indices, statusFn) {
        if (ocrBusy) { toast('正在识别中，请稍候', 'error'); return; }
        if (!indices.length) { toast('请先勾选图片', 'error'); return; }
        ocrBusy = true;
        try {
          const Tesseract = await loadTesseractLib();
          const worker = await Tesseract.createWorker('chi_sim+eng', 1, {
            logger: (m) => { if (String(m.status || '').includes('loading')) statusFn(`引擎准备中 ${Math.round((m.progress || 0) * 100)}%`); },
          });
          try {
            for (const i of indices) {
              statusFn(`识别第 ${indices.indexOf(i) + 1}/${indices.length} 张…`);
              try {
                const { data } = await worker.recognize(imgSrc(imagesData[i].url));
                const added = cleanOcrLines(data.text, ocrSrcKey());
                added.forEach((t) => linesData.push({ text: t, keep: true, src: 'ocr' }));
                imagesData[i].status = added.length ? `识别到 ${added.length} 行` : '未识别到文字';
              } catch {
                imagesData[i].status = state.localMode ? '识别失败（图片受防盗链保护，请用完整版）' : '识别失败';
              }
              statusFn(imagesData[i].status);
              renderLineList();
            }
          } finally {
            await worker.terminate();
          }
          toast('图片识别完成，请检查追加的行', 'ok');
        } catch (err) {
          toast(err.message || 'OCR 失败', 'error');
        } finally {
          ocrBusy = false;
        }
      }

      host.querySelectorAll('[data-ocr-one]').forEach((btn) => btn.addEventListener('click', () => {
        const i = Number(btn.dataset.ocrOne);
        ocrImages([i], (s) => { const el = host.querySelector(`#l-img-status-${i}`); if (el) el.textContent = s; });
      }));
      host.querySelector('#l-ocr-all')?.addEventListener('click', () => {
        const picked = imagesData.map((im, i) => (host.querySelector(`[data-img-check="${i}"]`)?.checked ? i : -1)).filter((i) => i >= 0);
        ocrImages(picked, (s) => {
          picked.forEach((i) => { const el = host.querySelector(`#l-img-status-${i}`); if (el) el.textContent = s; });
        });
      });

      /* ---- 预览与导入 ---- */
      host.querySelector('#l-preview').addEventListener('click', async () => {
        const lines = linesData.filter((l) => l.keep && l.text.trim()).map((l) => l.text);
        if (!lines.length) { toast('没有勾选要导入的文案', 'error'); return; }
        const globalCats = [...host.querySelectorAll('#l-cats .chip.active')].map((b) => Number(b.dataset.cat));
        const tags = host.querySelector('#l-tags').value;
        const previewHost = host.querySelector('#l-preview-host');
        let existing = {};
        try {
          const r = await api('/api/copies/check-duplicates', { method: 'POST', body: { contents: lines }, quiet: true });
          existing = r.existing || {};
        } catch { /* 查重失败不阻断 */ }
        const seen = new Set();
        const dupFlags = lines.map((line) => {
          const dup = Boolean(existing[line]) || seen.has(line);
          seen.add(line);
          return dup;
        });
        const dupCount = dupFlags.filter(Boolean).length;
        const keepIndices = lines.map((_, i) => i).filter((i) => !dupFlags[i]);
        const keepCount = keepIndices.length;
        const perItemCats = lines.map(() => [...globalCats]);
        previewHost.innerHTML = `
          <div class="section-head"><span class="section-index">PREVIEW</span><h2 class="section-title">导入预览</h2>
            <span class="section-note">${lines.length} 条 · 跳过 ${dupCount} 条重复 · 导入 ${keepCount} 条</span></div>
          ${dupCount ? `<div class="notice">检测到 ${dupCount} 条与档案中已有内容相同（或本次重复），这些行会自动跳过，只导入剩余 ${keepCount} 条。</div>` : ''}
          <div class="preview-list">${lines.map((line, i) => `
            <div class="preview-row ${dupFlags[i] ? 'dup' : ''}" data-row="${i}">
              <div class="preview-num">${String(i + 1).padStart(2, '0')}</div>
              <div class="preview-text">${esc(line)}</div>
              <div style="text-align:right">
                ${dupFlags[i]
                  ? '<div class="preview-flag">跳过 · 重复</div>'
                  : `<button class="link-btn" data-row-cat="${i}">分类</button>`}
              </div>
            </div>`).join('')}</div>
          <div class="modal-foot"><button class="btn btn-sm btn-primary" id="l-save" ${keepCount ? '' : 'disabled'}>${keepCount ? `确认保存 ${keepCount} 条` : '无可导入文案'}</button></div>`;

        previewHost.querySelectorAll('[data-row-cat]').forEach((btn) => btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.rowCat);
          openModal({
            kicker: 'PER ENTRY CATEGORY', title: `第 ${idx + 1} 条的分类`,
            body: `<p class="field-hint" style="margin-bottom:12px">${esc(lines[idx].slice(0, 80))}</p>${catPicker('row-cats', perItemCats[idx])}`,
            foot: '<button class="btn btn-sm btn-primary" data-ok>完成</button>',
            onMount(root, close) {
              bindChips(root.querySelector('#row-cats'), (ids) => { perItemCats[idx] = ids; });
              root.querySelector('[data-ok]').onclick = close;
            },
          });
        }));
        previewHost.querySelector('#l-save').addEventListener('click', async (e) => {
          if (!keepIndices.length) return;
          e.target.disabled = true;
          e.target.textContent = '保存中…';
          try {
            const result = await api('/api/copies/batch', {
              method: 'POST',
              body: { items: keepIndices.map((i) => ({ content: lines[i], categoryIds: perItemCats[i], tags })) },
            });
            const skipped = Number(result.skipped || 0);
            toast(result.count
              ? `成功收录 ${result.count} 条文案${skipped ? `，跳过 ${skipped} 条重复` : ''}`
              : `全部为重复文案，已跳过 ${skipped} 条`);
            previewHost.innerHTML = '';
            await loadCategories();
          } catch { /* 已提示 */ } finally {
            e.target.disabled = !keepIndices.length;
            e.target.textContent = keepCount ? `确认保存 ${keepCount} 条` : '无可导入文案';
          }
        });
        previewHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  });
}

/** 按换行拆分，只丢弃完全空行，不做 trim，不改标点/空格/Unicode */
function parseLines(text) {
  return String(text || '').split(/\r\n|\n|\r/).filter((line) => line !== '');
}
