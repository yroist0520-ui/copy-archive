/* 静态版批量去重 UI 测试：注册 → 预置文案 → 批量导入 → 只入库剩余文案 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'http://127.0.0.1:8081';
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
await ev(`localStorage.clear()`);

// 0. 通过注册弹窗建立本地档案
await send('Page.navigate', { url: BASE + '/upload' });
check('上传页要求登录', await waitFor(`!!document.querySelector('#up-login')`, 20000));
await ev(`document.querySelector('#up-login').click()`);
check('注册弹窗打开', await waitFor(`!!document.querySelector('#auth-account')`));
const user = 'sd' + String(Date.now()).slice(-6);
await ev(`document.querySelector('#auth-account').value = '${user}'; document.querySelector('#auth-pass').value = 'secret123'; document.querySelector('[data-submit]').click()`);
check('注册后进入上传页', await waitFor(`!!document.querySelector('[data-tab="batch"]')`, 20000));
check('静态模式生效', await ev(`document.documentElement.dataset.mode === 'local'`));

// 1. 预置一条已有文案，再批量导入（含内部重复）
const seeded = await ev(`import('/js/core.js').then(m=>m.api('/api/copies',{method:'POST',body:{content:'已存在的文案'}})).then(r=>!!r.id).catch(()=>false)`);
check('预置已有文案', seeded === true);
await ev(`document.querySelector('[data-tab="batch"]').click()`);
check('批量 tab 渲染', await waitFor(`!!document.querySelector('#b-text')`));
const lines = ['已存在的文案', '静态A', '静态A', '静态B'];
await ev(`(()=>{const t=document.querySelector('#b-text');t.value=${JSON.stringify(lines.join('\n'))};t.dispatchEvent(new Event('input'));})()`);
await ev(`document.querySelector('#b-preview').click()`);
check('预览出现 4 行', await waitFor(`document.querySelectorAll('#b-preview-host .preview-row').length === 4`, 15000));
const note = String(await ev(`(document.querySelector('#b-preview-host .section-note')||{textContent:''}).textContent`));
check(`预览标注跳过/导入数量（${note}）`, note.includes('跳过 2 条重复') && note.includes('导入 2 条'));
const saveText = String(await ev(`(document.querySelector('#b-save')||{textContent:''}).textContent`));
check(`保存按钮只计剩余文案（${saveText}）`, saveText.includes('2 条'));

// 2. 保存并核对数据
await ev(`document.querySelector('#b-save').click()`);
check('保存 toast 正确', await waitFor(`[...document.querySelectorAll('[class*=toast]')].some(t=>t.textContent.includes('成功收录 2 条文案'))`, 15000));
const items = await ev(`import('/js/core.js').then(m=>m.api('/api/copies')).then(d=>d.items||[])`);
const arr = typeof items === 'string' ? JSON.parse(items) : (Array.isArray(items) ? items : []);
const count = (t) => arr.filter((c) => c.content === t).length;
check('已有文案未重复新增', count('已存在的文案') === 1);
check('本次内部重复只入库 1 条', count('静态A') === 1);
check('剩余文案正常入库', count('静态B') === 1);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
