/* 三端统一账号端到端测试：静态版“设备 A”注册并写文案 → 清空本地数据模拟“设备 B” → 同账号登录看到同一份档案 */
const CDP = 'http://127.0.0.1:9222';
const STATIC = process.env.CA_STATIC || 'http://127.0.0.1:8081';
const CLOUD = process.env.CA_CLOUD || 'http://127.0.0.1:8765/?sharecode=test';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
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
// 测试环境把静态版默认云端地址指向本地完整版服务
const injected = await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.CA_CLOUD_URL = ${JSON.stringify(CLOUD)};`,
});
await ev(`localStorage.clear(); sessionStorage.clear()`);

async function openStaticUpload() {
  await send('Page.navigate', { url: STATIC + '/upload' });
  await waitFor(`!!document.querySelector('#up-login') || !!document.querySelector('#upload-pane')`, 20000);
  // 首次打开可能出现入口选择层，跳过它（不改变默认云端模式）
  if (await ev(`!!document.querySelector('#gate-skip')`)) {
    await ev(`document.querySelector('#gate-skip').click()`);
    await waitFor(`!document.querySelector('#entry-gate')`, 10000);
  }
}

async function fillAuth(username, register) {
  await ev(`import('/js/core.js').then(m=>m.openAuth(${register ? "'register'" : "'login'"}))`);
  await waitFor(`!!document.querySelector('#auth-account')`, 10000);
  await ev(`(()=>{document.querySelector('#auth-account').value=${JSON.stringify(username)};document.querySelector('#auth-pass').value='secret123';document.querySelector('[data-submit]').click()})()`);
}

// 0. 设备 A：静态版注册云端账号
await openStaticUpload();
check('静态版识别为云端模式', await ev(`document.documentElement.dataset.mode === 'cloud'`));
const user = 'cloud' + String(Date.now()).slice(-6);
await fillAuth(user, true);
check('设备 A 注册后进入上传页', await waitFor(`!!document.querySelector('[data-tab="single"]')`, 20000));
check('令牌已保存在浏览器', await ev(`!!localStorage.getItem('ca_cloud_token')`));

// 1. 写入一条文案，确认走的是云端（而不是浏览器本地库）
const content = '三端通用测试文案 ' + user;
await ev(`(()=>{document.querySelector('#s-content').value=${JSON.stringify(content)};document.querySelector('#s-save').click()})()`);
check('文案保存成功', await waitFor(`[...document.querySelectorAll('[class*=toast]')].some(t=>t.textContent.includes('已收录'))`, 15000));
check('未写入浏览器本地库', await ev(`!localStorage.getItem('ca_local_db_v1')`));

// 2. 设备 B：清空全部本地状态（模拟换手机/换电脑），用同一账号登录
await send('Network.clearBrowserCookies');
await ev(`localStorage.clear(); sessionStorage.clear()`);
await openStaticUpload();
await fillAuth(user, false);
check('设备 B 登录成功', await waitFor(`!!document.querySelector('[data-tab="single"]')`, 20000));

const items = await ev(`import('/js/core.js').then(m=>m.api('/api/copies')).then(d=>d.items||[])`);
const arr = typeof items === 'string' ? JSON.parse(items) : (Array.isArray(items) ? items : []);
check('设备 B 看到设备 A 创建的文案', arr.some((c) => c.content === content), JSON.stringify(arr.slice(0, 2)));
const me = await ev(`import('/js/core.js').then(m=>m.api('/api/auth/me')).then(d=>d.user||{})`);
check('两台设备是同一账号', me && me.username === user, JSON.stringify(me));

const injectedId = injected?.result?.result?.identifier;
if (injectedId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injectedId });

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
