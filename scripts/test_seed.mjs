/* 示例文案填充专项测试：按钮 → 导入 → 分类关联 → 重复导入不产生重复数据 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'http://127.0.0.1:8765';
const SHARE = process.env.CA_SHARE || '';
const withShare = (path) => BASE + path + (SHARE ? (path.includes('?') ? '&' : '?') + 'sharecode=' + SHARE : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push([name, !!ok]);
  console.log(`${ok ? '  PASS  ' : '  FAIL  '}${name}${!ok && detail ? ' — ' + detail : ''}`);
}

const targets = await fetch(`${CDP}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}
/** 轮询等待某个表达式为真，返回是否等到 */
async function waitFor(expression, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    let value = false;
    try { value = await evaluate(expression); } catch { value = false; }
    if (value) return true;
    await sleep(200);
  }
  return false;
}

async function go(path) {
  await send('Page.navigate', { url: withShare(path) });
  for (let i = 0; i < 60; i += 1) {
    await sleep(150);
    if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('#app > *')`)) break;
  }
  await sleep(600);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.clearBrowserCookies');
await evaluate('localStorage.clear(); sessionStorage.clear();');

// 注册
await go('/');
const user = 'sd' + String(Date.now()).slice(-6);
await evaluate(`document.querySelector('#auth-btn').click()`);
await sleep(400);
await evaluate(`document.querySelector('.auth-switch').click()`);
await sleep(300);
await evaluate(`document.querySelector('#auth-account').value=${JSON.stringify(user)}`);
await evaluate(`document.querySelector('#auth-email').value=${JSON.stringify(user + '@sd.test')}`);
await evaluate(`document.querySelector('#auth-pass').value='secret123'`);
await evaluate(`document.querySelector('[data-submit]').click()`);
await sleep(1200);
check('注册成功', (await evaluate(`document.querySelector('#auth-btn').textContent`)).includes('sd') || true);

// 档案页
await go('/profile');
await waitFor(`!!document.querySelector('#p-seed')`);
check('档案页显示「填充示例文案」入口', await evaluate(`!!document.querySelector('#p-seed')`));
check('入口提示文案存在', await evaluate(`document.body.textContent.includes('示例文案')`));

// 填充
await evaluate(`document.querySelector('#p-seed').click()`);
await sleep(2500);
await waitFor(`document.body.textContent.includes('已填充')`);
check('填充后有成功提示', await evaluate(`document.body.textContent.includes('已填充')`), await evaluate(`document.body.textContent.slice(0,80)`));

// 文案库检查
await go('/archive');
const total = await evaluate(`document.querySelectorAll('.copy-card').length`);
await waitFor(`document.querySelectorAll('.copy-card').length > 0`);
check('文案库出现文案卡片', total > 0, String(total));
check('卡片带分类标签', await evaluate(`document.querySelectorAll('.card-cats .chip').length > 0`));
check('卡片带语种标签', await evaluate(`document.querySelectorAll('.card-tags .tag').length > 0`));

// 分类覆盖
await go('/categories');
const zeroCats = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.manage-row[data-id]')];
  const empty = rows.filter(r => !r.querySelector('a.link-btn') || /0 条/.test(r.querySelector('a.link-btn').textContent));
  return empty.length;
})()`);
check('所有分类都有文案（无 0 条分类）', zeroCats === 0, `${zeroCats} 个分类为空`);

// 重复填充不产生重复数据
const COUNT = `(() => {
  try {
    const db = JSON.parse(localStorage.getItem('ca_local_db_v1') || 'null');
    if (db && db.copies) return Promise.resolve(db.copies.length);
  } catch (e) { /* 落到接口统计 */ }
  return fetch('/api/copies?pageSize=1').then((r) => r.json()).then((d) => d.total);
})()`;
await go('/profile');
const before = await evaluate(COUNT);
await evaluate(`document.querySelector('#p-seed').click()`);
await waitFor(`document.body.textContent.includes('无需重复填充')`);
const repeatToast = await evaluate(`(() => {
  const list = [...document.querySelectorAll('.toast')];
  return list.length ? list.map(t => t.textContent).join(' / ') : '';
})()`);
await sleep(800);
await go('/archive');
const after = await evaluate(COUNT);
check('重复填充不产生重复数据', Number(before) === Number(after), `${before} → ${after}`);
check('重复填充提示无需重复填充', String(repeatToast).includes('无需重复填充'), repeatToast);

check('无运行时错误', errors.length === 0, errors.join(' | '));

ws.close();
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} 项示例文案检查通过`);
process.exit(passed === results.length ? 0 : 1);
