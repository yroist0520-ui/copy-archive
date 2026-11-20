/* 修改密码 + 登录态一致性端到端验证
 * 覆盖：完整版登录后进入我的档案、改密换发令牌、旧密码失效；
 *       静态版离线账号改密、旧版永久本地选择迁移为会话级、切回云端。
 */
const CDP = 'http://127.0.0.1:9222';
const FULL = process.env.CA_BASE || 'http://127.0.0.1:8765';
const SHARE = process.env.CA_SHARE || '';
const STATIC = process.env.CA_STATIC || 'http://127.0.0.1:8081';
const withShare = (base, path) => base + path + (SHARE ? (path.includes('?') ? '&' : '?') + 'sharecode=' + SHARE : '');
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
let seq = 0; const pending = new Map(); const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return m.result?.result?.value; };
async function waitFor(expr, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev(expr)) return true;
    await sleep(200);
  }
  return false;
}
const open = async (url) => {
  await send('Page.navigate', { url });
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#auth-btn')`, 30000);
  await sleep(800);
};
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const user = `pwa_${stamp}`;

async function fillAuth(account, password, mode = 'login') {
  await ev(`document.querySelectorAll('.modal-backdrop').forEach(m=>m.remove())`);
  await ev(`document.querySelector('#auth-btn')?.click()`);
  await waitFor(`!!document.querySelector('#auth-account')`, 10000);
  if (mode === 'register') {
    await ev(`(()=>{const s=document.querySelector('.auth-switch'); if(s && /注册/.test(s.textContent)) s.click();})()`);
    await waitFor(`!!document.querySelector('#auth-name')`, 10000);
  }
  await ev(`(()=>{const a=document.querySelector('#auth-account'),p=document.querySelector('#auth-pass'); if(a)a.value=${JSON.stringify(account)}; if(p)p.value=${JSON.stringify(password)};})()`);
  await ev(`document.querySelector('.modal [data-submit]')?.click()`);
}

async function changePassword(oldPassword, newPassword) {
  await ev(`document.querySelector('#p-change-pw')?.click()`);
  await sleep(400);
  const opened = await ev(`!!document.querySelector('#pw-old')`);
  if (!opened) return false;
  await ev(`(()=>{document.querySelector('#pw-old').value=${JSON.stringify(oldPassword)};document.querySelector('#pw-new').value=${JSON.stringify(newPassword)};document.querySelector('#pw-confirm').value=${JSON.stringify(newPassword)};})()`);
  await ev(`document.querySelector('.modal [data-submit]')?.click()`);
  return waitFor(`!document.querySelector('#pw-old')`, 10000);
}

try {
  // ===== A. 完整版：登录后进入我的档案 + 改密 =====
  await open(withShare(FULL, '/'));
  await ev(`fetch(${JSON.stringify(withShare(FULL, '/api/auth/logout'))},{method:'POST',headers:{'X-Requested-With':'XMLHttpRequest'}})`);
  await ev(`localStorage.removeItem('ca_cloud_token'); document.querySelectorAll('.modal-backdrop').forEach(m=>m.remove())`);
  await open(withShare(FULL, '/'));
  await fillAuth(user, 'oldpass1', 'register');
  check('注册后自动进入我的档案', await waitFor(`location.pathname.endsWith('/profile') && !!document.querySelector('#p-change-pw')`, 15000));
  check('Account 区显示修改密码按钮', await ev(`!!document.querySelector('#p-change-pw')`));
  const tokenBefore = await ev(`localStorage.getItem('ca_cloud_token')`);

  check('修改密码提交成功', await changePassword('oldpass1', 'newpass2'));
  const tokenAfter = await ev(`localStorage.getItem('ca_cloud_token')`);
  check('改密后当前设备令牌已更新', !!tokenAfter && tokenAfter !== tokenBefore);

  await ev(`document.querySelector('#p-logout')?.click()`);
  await waitFor(`document.querySelector('#auth-btn')?.textContent.trim() === '登录'`, 10000);
  await fillAuth(user, 'oldpass1', 'login');
  check('旧密码登录被拒绝', await waitFor(`[...document.querySelectorAll('.toast')].some(t=>/不正确/.test(t.textContent))`, 10000));
  await ev(`(()=>{document.querySelectorAll('.modal-backdrop').forEach(m=>m.remove());})()`);
  await sleep(300);
  await fillAuth(user, 'newpass2', 'login');
  check('新密码登录成功并进入档案', await waitFor(`location.pathname.endsWith('/profile') && document.querySelector('.profile-handle')?.textContent.includes('@${user}')`, 15000));

  // ===== B. 静态版：离线账号改密 + 旧标记迁移 =====
  await open(STATIC + '/');
  await ev(`localStorage.removeItem('ca_local_session'); document.querySelectorAll('.modal-backdrop').forEach(m=>m.remove());`);
  await ev(`localStorage.setItem('ca_entry_choice','local'); localStorage.removeItem('ca_cloud_token'); sessionStorage.removeItem('ca_offline_session');`);
  await open(STATIC + '/profile?local=1');
  await ev(`(()=>{const g=document.querySelector('#gate-skip'); if(g) g.click();})()`);
  await sleep(500);
  check('有本地档案时默认进入本地模式', await ev(`document.documentElement.dataset.mode === 'local'`), String(await ev(`document.documentElement.dataset.mode`)));
  check('离线档案显示本地登录引导', await waitFor(`!!document.querySelector('#p-login')`, 15000));

  const localUser = `local${stamp}`;
  await ev(`document.querySelector('#p-login')?.click()`);
  await sleep(400);
  await ev(`(()=>{const s=document.querySelector('.auth-switch'); if(s && /注册/.test(s.textContent)) s.click();})()`);
  await sleep(400);
  await ev(`(()=>{document.querySelector('#auth-account').value=${JSON.stringify(localUser)};document.querySelector('#auth-pass').value='oldpass1';})()`);
  await ev(`document.querySelector('.modal [data-submit]')?.click()`);
  check('离线账号注册成功', await waitFor(`document.querySelector('.profile-handle')?.textContent.includes('@${localUser}')`, 15000));
  check('离线档案提示切回云端入口', await ev(`!!document.querySelector('#p-cloud')`));
  check('修改密码后仍保持登录', await changePassword('oldpass1', 'newpass2') && await waitFor(`!!document.querySelector('#p-change-pw')`, 8000));

  // 切回云端：带 ?cloud=1 显式切换（有新逻辑：有本地档案时默认本地，需显式选云端）
  await ev(`sessionStorage.clear(); localStorage.removeItem('ca_cloud_token');`);
  await open(STATIC + '/profile?cloud=1');
  await ev(`(()=>{const g=document.querySelector('#gate-skip'); if(g) g.click();})()`);
  await sleep(600);
  check('切回云端后不再显示离线切回入口', await waitFor(`document.querySelector('#p-login') && !document.querySelector('#p-cloud')`, 15000));
  check('切回云端后需重新登录', await ev(`!!document.querySelector('#p-login')`));

  check('无运行时错误', errors.length === 0, errors.join('; '));
} catch (e) {
  check('测试执行异常', false, String(e));
}

const pass = results.filter(([, ok]) => ok).length;
console.log(`\n${pass}/${results.length} 项检查通过`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
