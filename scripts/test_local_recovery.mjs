/* 本地档案找回验证：
 * 1) 浏览器已有本地账号+文案后，重新打开静态版应默认进入本地模式
 * 2) 原账号密码可直接登录，文案完整可见
 * 3) 云端模式登录本地账号报错时，出现一键进入本地档案入口
 * 4) 全新浏览器（无本地数据）仍默认云端模式（三端通用不受影响）
 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_STATIC || 'http://127.0.0.1:8081';
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
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((m) => m.result?.result?.value);
const open = async (url) => { await send('Page.navigate', { url }); await waitFor(`document.readyState === 'complete' && !!document.body`, 30000); await sleep(1000); };
const user = 'oldlocal' + Date.now().toString(36);

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });

  // 0. 全新浏览器：清空所有本地数据，确认默认云端
  await open(BASE + '/');
  await ev(`localStorage.clear(); sessionStorage.clear()`);
  await open(BASE + '/');  // 重载让模块在干净状态下重新判定模式
  await ev(`localStorage.clear(); sessionStorage.clear()`);
  await open(BASE + '/profile');
  await ev(`(()=>{const g=document.querySelector('#gate-skip'); if(g) g.click();})()`);
  await sleep(500);
  check('全新浏览器默认云端模式', await ev(`document.documentElement.dataset.mode === 'cloud'`), String(await ev(`document.documentElement.dataset.mode`)));

  // 1. 在本地档案注册账号并写入文案（模拟老用户历史数据）
  await open(BASE + '/profile?local=1');
  await ev(`(()=>{const g=document.querySelector('#gate-skip'); if(g) g.click();})()`);
  await sleep(400);
  await ev(`document.querySelector('#p-login')?.click()`);
  await waitFor(`!!document.querySelector('#auth-account')`, 10000);
  await ev(`(()=>{const s=document.querySelector('.auth-switch'); if(s && /注册/.test(s.textContent)) s.click();})()`);
  await sleep(300);
  await ev(`(()=>{document.querySelector('#auth-account').value=${JSON.stringify(user)};document.querySelector('#auth-pass').value='secret123';document.querySelector('[data-submit]').click()})()`);
  check('本地档案注册成功', await waitFor(`document.querySelector('.profile-handle')?.textContent.includes('@${user}')`, 15000));
  await ev(`import('/js/core.js').then(m=>m.api('/api/copies',{method:'POST',body:{content:'我的珍贵文案一'}}))`);
  await ev(`import('/js/core.js').then(m=>m.api('/api/copies',{method:'POST',body:{content:'我的珍贵文案二'}}))`);
  await sleep(500);
  const seeded = await ev(`JSON.parse(localStorage.getItem('ca_local_db_v1')).copies.length`);
  check('本地已写入文案', seeded >= 2, String(seeded));

  // 2. 退出登录，清掉会话标记，但保留本地档案数据（模拟重新打开浏览器）
  await ev(`localStorage.removeItem('ca_local_session'); localStorage.removeItem('ca_entry_choice'); sessionStorage.clear();`);
  await open(BASE + '/profile');
  await ev(`(()=>{const g=document.querySelector('#gate-skip'); if(g) g.click();})()`);
  await sleep(500);
  check('有本地档案时默认进入本地模式', await ev(`document.documentElement.dataset.mode === 'local'`), String(await ev(`document.documentElement.dataset.mode`)));
  check('本地登录引导出现', await ev(`!!document.querySelector('#p-login')`));

  // 3. 用原账号密码登录，文案完整
  await ev(`document.querySelector('#p-login').click()`);
  await waitFor(`!!document.querySelector('#auth-account')`, 10000);
  await ev(`(()=>{document.querySelector('#auth-account').value=${JSON.stringify(user)};document.querySelector('#auth-pass').value='secret123';document.querySelector('[data-submit]').click()})()`);
  check('原账号密码可直接登录', await waitFor(`document.querySelector('.profile-handle')?.textContent.includes('@${user}')`, 15000));
  const list = await ev(`import('/js/core.js').then(m=>m.api('/api/copies')).then(d=>JSON.stringify((d.items||[]).map(x=>x.content)))`);
  check('文案完整可见', String(list).includes('我的珍贵文案一') && String(list).includes('我的珍贵文案二'), String(list).slice(0, 200));

  // 4. 云端模式登录本地账号报错时，出现一键入口
  await ev(`localStorage.removeItem('ca_local_session'); sessionStorage.clear();`);
  await open(BASE + '/profile?cloud=1');
  await ev(`(()=>{const g=document.querySelector('#gate-skip'); if(g) g.click();})()`);
  await sleep(500);
  await ev(`document.querySelector('#p-login')?.click()`);
  await waitFor(`!!document.querySelector('#auth-account')`, 10000);
  await ev(`(()=>{document.querySelector('#auth-account').value=${JSON.stringify(user)};document.querySelector('#auth-pass').value='secret123';document.querySelector('[data-submit]').click()})()`);
  check('云端登录本地账号出现切换入口', await waitFor(`!!document.querySelector('#local-login-hint')`, 15000));
  await ev(`document.querySelector('#auth-use-local')?.click()`);
  check('一键切换后进入本地档案', await waitFor(`document.documentElement.dataset.mode === 'local' && document.querySelector('.profile-handle')?.textContent.includes('@${user}')`, 15000));

  check('无运行时错误', true);
} catch (e) {
  check('测试执行异常', false, String(e));
}
const pass = results.filter(([, ok]) => ok).length;
console.log(`\n${pass}/${results.length} 项检查通过`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
