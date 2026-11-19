/* 批量上传去重 UI 测试（本地服务）：已有重复 + 本次内部重复 → 只导入剩余文案 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'http://127.0.0.1:8765';
let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(expr, timeout = 15000, interval = 200) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await ev(expr)) return true;
    await sleep(interval);
  }
  return false;
}

const targets = await fetch(CDP + '/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  .then((r) => r.result?.result?.value);

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.clearBrowserCookies');

// 0. 注册并预置一条已有文案
await send('Page.navigate', { url: BASE + '/' });
await waitFor(`!!document.body`, 20000);
const user = 'ded' + String(Date.now()).slice(-6);
const reg = await ev(`fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},body:JSON.stringify({username:'${user}',password:'secret123',displayName:'去重测试'})}).then(r=>r.status).catch(e=>'ERR:'+e.message)`);
check('注册测试账号（200）', reg === 200);
const seeded = await ev(`fetch('/api/copies',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},body:JSON.stringify({content:'已存在的文案'})}).then(r=>r.status)`);
check('预置已有文案（201）', seeded === 201);

// 1. 批量换行 tab：已有重复 1 条 + 本次内部重复 1 条
await send('Page.navigate', { url: BASE + '/upload' });
check('上传页打开', await waitFor(`!!document.querySelector('[data-tab="batch"]')`, 20000));
await ev(`document.querySelector('[data-tab="batch"]').click()`);
check('批量 tab 渲染', await waitFor(`!!document.querySelector('#b-text')`));

const lines = ['已存在的文案', '全新A', '全新A', '全新B'];
await ev(`(()=>{const t=document.querySelector('#b-text');t.value=${JSON.stringify(lines.join('\n'))};t.dispatchEvent(new Event('input'));})()`);
await ev(`document.querySelector('#b-preview').click()`);
check('预览出现 4 行', await waitFor(`document.querySelectorAll('#b-preview-host .preview-row').length === 4`, 15000));

const note = String(await ev(`(document.querySelector('#b-preview-host .section-note')||{textContent:''}).textContent`));
check(`预览标注跳过/导入数量（${note}）`, note.includes('跳过 2 条重复') && note.includes('导入 2 条'));
const dupRows = await ev(`document.querySelectorAll('#b-preview-host .preview-row.dup').length`);
check('2 行被标记为重复', dupRows === 2);
const dupText = String(await ev(`[...document.querySelectorAll('#b-preview-host .preview-flag')].map(e=>e.textContent).join('|')`));
check('重复行提示“跳过 · 重复”', dupText.includes('跳过'));
const saveText = String(await ev(`(document.querySelector('#b-save')||{textContent:''}).textContent`));
check(`保存按钮只计剩余文案（${saveText}）`, saveText.includes('2 条'));

// 2. 保存并核对数据
await ev(`document.querySelector('#b-save').click()`);
check('保存 toast 正确', await waitFor(`[...document.querySelectorAll('[class*=toast]')].some(t=>t.textContent.includes('成功收录 2 条文案'))`, 15000));
const items = await ev(`fetch('/api/copies',{headers:{'X-Requested-With':'XMLHttpRequest'}}).then(r=>r.json()).then(d=>d.items||[])`);
const arr = typeof items === 'string' ? JSON.parse(items) : (Array.isArray(items) ? items : []);
const count = (t) => arr.filter((c) => c.content === t).length;
check('已有文案未重复新增', count('已存在的文案') === 1);
check('本次内部重复只入库 1 条', count('全新A') === 1);
check('剩余文案正常入库', count('全新B') === 1);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
