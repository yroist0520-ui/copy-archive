/* 线上静态版入口选择层验收 */
const CDP = 'http://127.0.0.1:9222';
const BASE = 'https://yroist0520-ui.github.io/copy-archive';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push([name, !!ok]);
  console.log(`${ok ? '  PASS  ' : '  FAIL  '}${name}${!ok && detail ? ' — ' + detail : ''}`);
}
const targets = await fetch(`${CDP}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}
async function waitFor(expression, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(300);
  }
  return false;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.clearBrowserCookies');
await evaluate('localStorage.clear(); sessionStorage.clear();');

await send('Page.navigate', { url: BASE + '/' });
check('入口选择层出现', await waitFor(`!!document.querySelector('#entry-gate')`));
check('两个版本入口存在', await evaluate(`!!document.querySelector('#gate-full') && !!document.querySelector('#gate-local')`));
check('本地版按钮为建立档案文案', String(await evaluate(`document.querySelector('#gate-local .entry-gate-name')?.textContent`)) === '建立自己的档案');
check('完整版常量指向后端域名', await evaluate(`import('./js/core.js').then(m => String(m.FULL_VERSION_URL).startsWith('https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host'))`));

// 真实点击「去公开档案」→ 应跳转到后端版
await evaluate(`document.querySelector('#gate-full').click()`);
check('点击后跳转到后端版域名', await waitFor(`location.host === 'wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host'`, 25000), await evaluate('location.host'));

// 回到静态版：等导航真正完成再断言（后端版首页也有 .hero-title，直接等它会读到旧文档）
await send('Page.navigate', { url: BASE + '/' });
await waitFor(`location.origin === 'https://yroist0520-ui.github.io' && document.readyState === 'complete' && !!document.querySelector('.hero-title')`, 25000);
await sleep(800);
check('选择完整版后回到静态版不再弹层', await evaluate(`!document.querySelector('#entry-gate') && localStorage.getItem('ca_entry_choice') === 'full'`),
  JSON.stringify({ gate: await evaluate(`!!document.querySelector('#entry-gate')`), choice: await evaluate(`localStorage.getItem('ca_entry_choice')`), origin: await evaluate(`location.origin`), keys: await evaluate(`Object.keys(localStorage).join(',')`) }));

// 「先随便看看」路径：清存储重来
await evaluate(`localStorage.clear(); sessionStorage.clear();`);
await send('Page.navigate', { url: BASE + '/' });
await waitFor(`location.origin === 'https://yroist0520-ui.github.io' && document.readyState === 'complete'`, 25000);
await waitFor(`!!document.querySelector('#entry-gate')`);
await evaluate(`document.querySelector('#gate-skip').click()`);
check('先随便看看关闭弹层', await waitFor(`!document.querySelector('#entry-gate')`));
await send('Page.navigate', { url: BASE + '/' });
await waitFor(`location.origin === 'https://yroist0520-ui.github.io' && document.readyState === 'complete' && !!document.querySelector('.hero-title')`, 25000);
await sleep(600);
check('同会话内不再弹层', await evaluate(`!document.querySelector('#entry-gate')`));

const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} 项静态版入口验收通过`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
