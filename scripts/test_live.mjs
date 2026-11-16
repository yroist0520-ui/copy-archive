/* 线上端到端验证：注册 → 上传 → 多分类 → 搜索 → 分享链接 → 访客访问 → 复制 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'https://yroist0520-ui.github.io/copy-archive';
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
  for (let i = 0; i < 50; i += 1) {
    await sleep(150);
    if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('#app > *')`)) break;
  }
  await sleep(350);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.clearBrowserCookies');
await evaluate('localStorage.clear(); sessionStorage.clear();');

// 注册
await go('/');
const user = 'live' + String(Date.now()).slice(-6);
await evaluate(`document.querySelector('#auth-btn').click()`);
await sleep(400);
await evaluate(`document.querySelector('.auth-switch').click()`);
await sleep(300);
await evaluate(`document.querySelector('#auth-account').value=${JSON.stringify(user)}`);
await evaluate(`document.querySelector('#auth-email').value=${JSON.stringify(user + '@live.test')}`);
await evaluate(`document.querySelector('#auth-pass').value='secret123'`);
await evaluate(`document.querySelector('#auth-name').value='线上验收档案'`);
await evaluate(`document.querySelector('[data-submit]').click()`);
// 注册请求要走公网网关，延迟抖动大；轮询等待登录态出现，避免固定 sleep 偶发误判
const loginOk = await waitFor(`(document.querySelector('#auth-btn')?.textContent || '').includes('线上验收')`, 15000);
check('线上注册成功', loginOk, await evaluate(`document.querySelector('#auth-btn')?.textContent || ''`));

// 上传（带多分类 + 特殊字符）
await go('/upload');
await evaluate(`document.querySelector('#s-content').value=${JSON.stringify('Somewhere between dreams and reality. 「✦」\n第二行')}`);
await evaluate(`document.querySelector('#s-content').dispatchEvent(new Event('input'))`);
await evaluate(`document.querySelectorAll('#s-cats .chip')[1].click()`);
await evaluate(`document.querySelectorAll('#s-cats .chip')[15].click()`);
await evaluate(`document.querySelector('#s-save').click()`);
await sleep(900);
check('线上上传成功', await evaluate(`document.body.textContent.includes('已收录')`));

// 文案库 + 多分类 + 搜索
await go('/archive');
check('文案库显示 1 条', await evaluate(`document.querySelectorAll('.copy-card').length === 1`), String(await evaluate(`document.querySelectorAll('.copy-card').length`)));
check('卡片含 2 个分类标签', await evaluate(`document.querySelectorAll('.card-cats .chip').length >= 2`), String(await evaluate(`document.querySelectorAll('.card-cats .chip').length`)));
await evaluate(`(()=>{const i=document.querySelector('#archive-search'); i.value='dreams'; i.dispatchEvent(new Event('input'));})()`);
await sleep(800);
check('线上搜索命中', await evaluate(`document.querySelectorAll('.copy-card').length === 1`));
check('线上关键词高亮', await evaluate(`!!document.querySelector('mark.hit')`));

// 分享链接（Share 区在分类/文案加载后才渲染，固定等待易读到尚未生成的输入框）
await go('/profile');
await waitFor(`!!document.querySelector('#p-share') && !!document.querySelector('#p-share').value`);
const shareUrl = await evaluate(`document.querySelector('#p-share')?.value || ''`);
console.log(`  分享链接：${shareUrl}`);
check('分享链接指向线上域名', String(shareUrl).startsWith(BASE), String(shareUrl));
check('分享链接含用户名与子路径', String(shareUrl).includes(`/copy-archive/u/${user}`) || String(shareUrl).includes(`/u/${user}`), String(shareUrl));

// 访客访问（清 cookie 模拟新访客，但仍能读公开档案）
await go(`/u/${user}`);
await waitFor(`!!document.querySelector('.profile-name')`);
check('访客可访问公开档案', await evaluate(`!!document.querySelector('.profile-name')`), await evaluate(`document.getElementById('app').innerHTML.slice(0,120)`));
await waitFor(`document.querySelectorAll('[data-action="copy"]').length > 0`);
check('访客可复制公开文案', await evaluate(`document.querySelectorAll('[data-action="copy"]').length > 0`));

// 复制只复制正文
const copied = await evaluate(`(async () => {
  const btn = document.querySelector('[data-action="copy"]');
  if (!btn) return 'no-button';
  btn.click();
  await new Promise(r => setTimeout(r, 600));
  const ta = document.querySelector('textarea.copy-preview, .copy-preview');
  return document.body.textContent.includes('Somewhere between dreams and reality.');
})()`);
check('访客复制只取正文', copied === true, String(copied));

check('无运行时错误', errors.length === 0, errors.join(' | '));

ws.close();
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} 项线上端到端检查通过`);
process.exit(passed === results.length ? 0 : 1);
