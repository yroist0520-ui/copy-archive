/* 我的档案 Account 区验证：切换账号（免退出直接登录）+ 退出登录 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host';
const SHARE = process.env.CA_SHARE || 'HC3YZORW3G';
const withShare = (path) => BASE + path + (SHARE ? (path.includes('?') ? '&' : '?') + 'sharecode=' + SHARE : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push([name, !!ok]);
  console.log(`${ok ? '  PASS  ' : '  FAIL  '}${name}${!ok && detail ? ' — ' + detail : ''}`);
}
async function waitFor(expr, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev(expr)) return true;
    await sleep(200);
  }
  return false;
}

const targets = await fetch(`${CDP}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0; const pending = new Map(); const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return m.result?.result?.value; };
const stamp = Date.now().toString().slice(-6);
const userA = `acct_a${stamp}`;
const userB = `acct_b${stamp}`;

try {
  // 0. 清理登录态
  await send('Page.navigate', { url: withShare('/') });
  await sleep(3500);
  await ev(`fetch('/api/auth/logout${SHARE ? '?sharecode=' + SHARE : ''}',{method:'POST',headers:{'X-Requested-With':'XMLHttpRequest'}}); localStorage.removeItem('ca_cloud_token');`);
  await send('Page.navigate', { url: withShare('/profile') });
  await sleep(3000);

  // 1. 未登录访问 /profile 只有登录引导，无 Account 区
  check('未登录显示登录引导', await ev(`!!document.querySelector('#p-login')`));
  check('未登录无 Account 区', await ev(`!document.querySelector('#p-switch')`));

  // 2. 打开注册弹层（先点 auth-btn → 切注册）
  await ev(`document.querySelector('#auth-btn')?.click()`);
  await sleep(500);
  await ev(`(()=>{const s=document.querySelector('.auth-switch'); if(s && /注册/.test(s.textContent)) s.click();})()`);
  await sleep(500);
  await ev(`(()=>{document.querySelector('#auth-account').value='${userA}'; document.querySelector('#auth-pass').value='secret123';})()`);
  await ev(`document.querySelector('[data-submit]')?.click()`);
  await sleep(3000);
  check('账号A 注册并进入档案', await waitFor(`document.querySelector('.profile-handle')?.textContent.includes('@${userA}')`, 15000));
  check('档案页出现 Account 区', await ev(`!!document.querySelector('#p-switch') && !!document.querySelector('#p-logout')`));
  check('Account 区显示当前用户名', await ev(`[...document.querySelectorAll('.section')].some(s=>s.textContent.includes('Account') && s.textContent.includes('@${userA}'))`));

  // 3. 切换账号：直接开登录框（不退出），登录账号 B
  await ev(`document.querySelector('#p-switch').click()`);
  await sleep(600);
  check('切换账号弹出登录框', await ev(`!!document.querySelector('#auth-account') && !!document.querySelector('[data-submit]')`));
  // 账号 B 需要先注册：切到注册模式
  await ev(`(()=>{const s=document.querySelector('.auth-switch'); if(s && /注册/.test(s.textContent)) s.click();})()`);
  await sleep(500);
  await ev(`(()=>{document.querySelector('#auth-account').value='${userB}'; document.querySelector('#auth-pass').value='secret123';})()`);
  await ev(`document.querySelector('[data-submit]')?.click()`);
  await sleep(3500);
  check('切换到账号B 自动进入其档案', await waitFor(`document.querySelector('.profile-handle')?.textContent.includes('@${userB}')`, 15000));
  check('切换后 Account 区显示账号B', await ev(`[...document.querySelectorAll('.section')].some(s=>s.textContent.includes('Account') && s.textContent.includes('@${userB}'))`));

  // 4. 退出登录
  await ev(`document.querySelector('#p-logout').click()`);
  check('退出后回到首页', await waitFor(`location.pathname === '/' || location.pathname.endsWith('/')`, 10000));
  check('退出后 auth 按钮变登录', await waitFor(`document.querySelector('#auth-btn')?.textContent.trim() === '登录'`, 10000));
  await send('Page.navigate', { url: withShare('/profile') });
  check('退出后 /profile 回到登录引导', await waitFor(`!!document.querySelector('#p-login')`, 12000));

  // 5. 账号B 数据仍在（重新登录）
  await ev(`document.querySelector('#p-login')?.click()`);
  check('重新登录弹层出现', await waitFor(`!!document.querySelector('#auth-account')`, 8000));
  await ev(`(()=>{document.querySelector('#auth-account').value='${userB}'; document.querySelector('#auth-pass').value='secret123';})()`);
  await ev(`document.querySelector('[data-submit]')?.click()`);
  check('重新登录账号B 文案不丢失', await waitFor(`document.querySelector('.profile-handle')?.textContent.includes('@${userB}')`, 15000));

  check('无运行时错误', errors.length === 0, errors.join('; '));
} catch (e) {
  check('测试执行异常', false, String(e));
}

const pass = results.filter(([, ok]) => ok).length;
console.log(`\n${pass}/${results.length} 项账号功能检查通过`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
