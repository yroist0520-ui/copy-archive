/* 偶遇 / SERENDIPITY：随机拆一句文案，像拆开一只盲盒 */
import {
  state, api, esc, route, toast, copyText, openAuth,
} from './core.js';
import { openDetail } from './detail.js';
import { feedback } from './feedback.js';

const SP_STYLE = `
<style>
.sp-wrap{max-width:860px}
.sp-stage{margin-top:40px}
.sp-card{position:relative;min-height:400px;display:flex;align-items:stretch;justify-content:center}
.sp-face{
  width:100%;border:1px solid var(--line);border-radius:var(--r-lg);
  background:var(--surface);box-shadow:var(--shadow-lg);
  padding:56px 48px;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;position:relative;overflow:hidden;
}
.sp-face::before{
  content:"";position:absolute;inset:14px;border:1px solid var(--line-soft);
  border-radius:calc(var(--r-lg) - 8px);pointer-events:none;
}
.sp-seal{
  font-size:34px;color:var(--accent);width:64px;height:64px;line-height:62px;
  border:1px solid var(--accent);border-radius:50%;margin-bottom:30px;
  font-family:var(--font-serif);
}
.sp-front-title{
  font-family:var(--font-serif);font-size:var(--t-hero);letter-spacing:.3em;
  text-indent:.3em;color:var(--ink);margin:0;
}
.sp-front-sub{color:var(--ink-soft);font-size:var(--t-body);margin-top:18px}
.sp-front-line{width:48px;height:1px;background:var(--accent);opacity:.55;margin:28px 0}
.sp-open{min-width:190px}
.sp-face-back{align-items:stretch;text-align:left;gap:0}
.sp-quote{
  font-family:var(--font-serif);font-size:clamp(22px,3.6vw,34px);line-height:1.7;
  color:var(--ink);white-space:pre-wrap;word-break:break-word;text-align:center;
  padding:8px 0 30px;min-height:120px;display:flex;align-items:center;justify-content:center;
}
.sp-quote::before{content:"“";color:var(--accent);opacity:.5;margin-right:4px}
.sp-quote::after{content:"”";color:var(--accent);opacity:.5;margin-left:4px}
.sp-cats{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:26px}
.sp-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;border-top:1px solid var(--line-soft);padding-top:24px}
.sp-flip{animation:spIn .55s var(--ease-out)}
@keyframes spIn{from{opacity:0;transform:translateY(14px) scale(.985)}to{opacity:1;transform:none}}
.sp-toolbar{margin-top:30px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.sp-count{font-family:var(--font-mono);font-size:var(--t-small);color:var(--muted)}
.sp-hint{margin-top:18px;font-size:var(--t-small);color:var(--muted);line-height:1.7}
@media(max-width:640px){
  .sp-face{padding:44px 26px;min-height:360px}
  .sp-actions{gap:8px}
  .sp-actions .btn{flex:1 1 auto}
}
</style>`;

export function registerSerendipity() {
  route(/^\/serendipity$/, async ({ app }) => {
    const view = { current: null, count: 0, lastId: null };

    app.innerHTML = `${SP_STYLE}
      <div class="container section sp-wrap" style="padding-top:56px">
        <div class="section-head reveal"><span class="section-index">SERENDIPITY</span><h1 class="section-title">偶遇</h1><span class="section-note">每一次拆开，都是不期而遇</span></div>
        <div class="sp-stage reveal d1">
          <div class="sp-card">
            <div class="sp-face sp-face-front" id="sp-front">
              <div class="sp-seal">✦</div>
              <h2 class="sp-front-title">偶遇</h2>
              <div class="sp-front-sub">今天，会遇见哪一句？</div>
              <div class="sp-front-line"></div>
              <button class="btn btn-primary sp-open" id="sp-open">拆开盲盒</button>
            </div>
            <div class="sp-face sp-face-back hidden" id="sp-back">
              <div class="sp-quote" id="sp-quote"></div>
              <div class="sp-cats" id="sp-cats"></div>
              <div class="sp-actions">
                <button class="btn btn-sm btn-primary" id="sp-again">再遇一句 ↻</button>
                <button class="btn btn-sm" id="sp-copy">复制</button>
                <button class="btn btn-sm" id="sp-fav">☆ 收藏</button>
                <button class="btn btn-sm" id="sp-detail">详情 ↗</button>
              </div>
            </div>
          </div>
        </div>
        <div class="sp-toolbar reveal d2">
          <div class="toolbar-group"><span class="toolbar-label">抽取范围</span>
            <select class="select" id="sp-cat"><option value="">全部文案</option>${state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
          <div class="toolbar-group" style="margin-left:auto"><span class="sp-count" id="sp-count">已拆开 0 次</span></div>
        </div>
        <p class="sp-hint" id="sp-hint">从你的档案里随机遇见一句话；登录不同设备看到的是同一份档案。未登录时，会从公开精选里抽取。</p>
      </div>`;

    const front = app.querySelector('#sp-front');
    const back = app.querySelector('#sp-back');
    const quoteEl = app.querySelector('#sp-quote');
    const catsEl = app.querySelector('#sp-cats');
    const countEl = app.querySelector('#sp-count');
    const catSel = app.querySelector('#sp-cat');
    const favBtn = app.querySelector('#sp-fav');

    function syncFav() {
      const on = !!(view.current && view.current.isFavorite);
      favBtn.textContent = on ? '★ 已收藏' : '☆ 收藏';
      favBtn.classList.toggle('fav-on', on);
    }

    function show(item) {
      view.current = item;
      view.lastId = item.id;
      view.count += 1;
      countEl.textContent = `已拆开 ${view.count} 次`;
      quoteEl.textContent = item.content || '';
      const cats = (item.categories || []).map((c) => `<span class="chip" style="--cat-color:${esc(c.color)};min-height:22px;padding:1px 9px"><span class="cat-dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</span>`).join('');
      catsEl.innerHTML = cats || '<span class="tag" style="opacity:.55">未分类</span>';
      syncFav();
      front.classList.add('hidden');
      back.classList.remove('hidden');
      back.classList.remove('sp-flip');
      void back.offsetWidth;
      back.classList.add('sp-flip');
    }

    function empty() {
      front.classList.remove('hidden');
      back.classList.add('hidden');
      app.querySelector('#sp-hint').textContent = '这里还没有可以偶遇的句子。先去上传几条文案，再回来拆开盲盒吧。';
    }

    async function draw() {
      const openBtn = app.querySelector('#sp-open');
      if (openBtn) { openBtn.disabled = true; openBtn.textContent = '寻找中…'; }
      const againBtn = app.querySelector('#sp-again');
      if (againBtn) { againBtn.disabled = true; againBtn.textContent = '寻找中…'; }
      try {
        let pool = [];
        if (state.user) {
          const params = new URLSearchParams({ sort: 'random', page: '1', pageSize: '8', t: String(Date.now()) });
          if (catSel.value) params.set('category', catSel.value);
          const data = await api('/api/copies?' + params, { quiet: true });
          pool = data.items || [];
          // 尽量避开上一条，避免连续重复
          if (pool.length > 1) {
            const fresh = pool.filter((x) => x.id !== view.lastId);
            if (fresh.length) pool = fresh;
          }
        } else {
          const data = await api('/api/discover', { quiet: true });
          pool = data.popular || [];
          if (pool.length > 1) {
            const fresh = pool.filter((x) => x.id !== view.lastId);
            if (fresh.length) pool = fresh;
          }
          if (pool.length) pool = [pool[Math.floor(Math.random() * pool.length)]];
        }
        if (!pool.length) { empty(); return; }
        feedback('reveal');
        show(pool[Math.floor(Math.random() * pool.length)]);
      } catch (err) {
        toast(err.message || '抽取失败，请重试', 'error');
      } finally {
        if (openBtn) { openBtn.disabled = false; openBtn.textContent = '拆开盲盒'; }
        if (againBtn) { againBtn.disabled = false; againBtn.textContent = '再遇一句 ↻'; }
      }
    }

    app.querySelector('#sp-open').addEventListener('click', draw);
    app.querySelector('#sp-again').addEventListener('click', draw);
    app.querySelector('#sp-copy').addEventListener('click', async () => {
      if (!view.current) return;
      const ok = await copyText(view.current.content);
      if (ok) {
        toast('已复制这句');
        try { await api(`/api/copies/${view.current.id}/copy`, { method: 'POST', body: {}, quiet: true }); } catch { /* 忽略 */ }
      } else toast('复制失败', 'error');
    });
    favBtn.addEventListener('click', async () => {
      if (!view.current) return;
      if (!state.user) { toast('登录后才能收藏', 'error'); openAuth(); return; }
      const wanted = !view.current.isFavorite;
      try {
        const res = await api(`/api/copies/${view.current.id}/favorite`, { method: 'POST', body: { value: wanted }, quiet: true });
        view.current.isFavorite = !!(res && res.isFavorite);
        syncFav();
        toast(view.current.isFavorite ? '已收藏' : '已取消收藏');
      } catch (err) { toast(err.message || '操作失败', 'error'); }
    });
    app.querySelector('#sp-detail').addEventListener('click', () => {
      if (view.current) openDetail(view.current);
    });
    catSel.addEventListener('change', () => { view.lastId = null; });

    if (!state.user) {
      const groups = app.querySelectorAll('.sp-toolbar .toolbar-group');
      if (groups[0]) groups[0].classList.add('hidden');
    }
  });
}
