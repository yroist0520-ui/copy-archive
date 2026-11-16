/* 场景 B：已注册私密用户投稿 → 公开引导按钮（验证 refreshSession bug 修复）
 * 场景 C：公开用户再次投稿 → 直接显示可搜索提示 */
const CDP = 'http://127.0.0.1:9222';
const BASE = 'https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host';
const SC = 'HC3YZORW3G';
const HDR = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, !!ok]);
  console.log(`${ok ? '  PASS  ' : '  FAIL  '}${name}${!ok && detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function encodeContribution(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* 1. API 注册一个私密用户 */
const user = 'ctb' + Math.random().toString(36).slice(2, 8);
const reg = await fetch(`${BASE}/api/auth/register?sharecode=${SC}`, { method: 'POST', headers: HDR, body: JSON.stringify({ username: user, email: `${user}@t.dev`, password: 'secret123', displayName: '私密投稿员' }) });
const regData = await reg.json().catch(() => ({}));
const setCookie = reg.headers.get('set-cookie') || '';
const mck = /ca_session=([^;]+)/.exec(setCookie);
const regCookie = mck ? `ca_session=${mck[1]}` : (regData.token ? `ca_session=${regData.token}` : '');
check('API 注册测试用户', reg.status === 200 && !!regCookie, `status=${reg.status}`);
if (!regCookie) { console.log('注册失败，中止'); process.exit(1); }
await fetch(`${BASE}/api/profile?sharecode=${SC}`, { method: 'PUT', headers: { ...HDR, Cookie: regCookie }, body: JSON.stringify({ privacy: 'private' }) });
const me = await fetch(`${BASE}/api/auth/me?sharecode=${SC}`, { headers: { Cookie: regCookie, 'X-Requested-With': 'XMLHttpRequest' } }).then((r) => r.json());
check('用户已设为 private', me.user?.privacy === 'private', JSON.stringify(me.user?.privacy));

const TOKEN = 'CTB' + Math.random().toString(36).slice(2, 8).toUpperCase();
const payload = {
  v: 1,
  from: '私密档案投稿',
  entries: [
    { content: `私密投稿甲 ${TOKEN} 山野的风带着松脂的清凉。`, title: '', tags: ['中文'], categories: ['城市漫游'] },
    { content: `私密投稿乙 ${TOKEN} Stay hungry, stay foolish.`, title: '', tags: ['英文'], categories: ['城市漫游'] },
  ],
  categories: ['城市漫游'],
};
const url = `${BASE}/contribute?sharecode=${SC}#ct=${encodeContribution(payload)}`;

/* 2. CDP 会话 */
const targets = await fetch(CDP + '/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0;
const pending = new Map();
const runtimeErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    runtimeErrors.push((d.exception?.description || d.text).slice(0, 200));
    console.log('RUNTIME ERROR:', (d.exception?.description || d.text).slice(0, 160));
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((r) => r.result?.result?.value);
const waitFor = async (expr, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await ev(expr)) return true;
    await sleep(300);
  }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.clearBrowserCookies');
await send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'all' });
await send('Page.navigate', { url: 'about:blank' });
await sleep(600);

/* 3. 打开投稿链接：SPA 兜底（404.html）→ 应用根 → 恢复 /contribute 路由 */
await send('Page.navigate', { url });
for (let i = 0; i < 5; i++) {
  if (await ev(`location.pathname === '/contribute' && location.hash.length > 50`)) break;
  await sleep(800);
  await ev(`location.href = ${JSON.stringify(url)}`);
}
check('深链兜底后路由恢复为 /contribute', await waitFor(`location.pathname === '/contribute'`, 20000));
check('未登录显示注册引导', await waitFor(`!!document.querySelector('#ct-auth')`, 20000));

/* 4. 弹层登录这个 private 用户（弹层默认登录模式：有 #auth-account 无 #auth-email） */
await ev(`document.querySelector('#ct-auth').click()`);
await waitFor(`!!document.querySelector('#auth-account')`);
const isRegisterMode = await ev(`!!document.querySelector('#auth-email')`);
if (isRegisterMode) { await ev(`document.querySelector('.auth-switch')?.click()`); await sleep(300); }
await ev(`
  document.querySelector('#auth-account').value = '${user}';
  document.querySelector('#auth-pass').value = 'secret123';
  true
`);
await ev(`document.querySelector('.modal [data-submit], [data-submit]').click()`);
check('登录成功回到投稿预览', await waitFor(`!!document.querySelector('#ct-go') && document.body.textContent.includes('确认投稿')`, 20000));
check('预览识别 2 条文案', await waitFor(`document.querySelector('.stat-num')?.textContent === '2'`, 15000));

/* 5. 确认投稿 → private 用户应看到公开引导（完全公开 / 部分公开） */
await ev(`document.querySelector('#ct-go').click()`);
check('投稿完成提示', await waitFor(`document.body.textContent.includes('投稿完成')`, 30000));
check('出现公开引导（完全公开按钮）', await waitFor(`!!document.querySelector('#pub-all')`, 15000));

/* 6. 点击「完全公开」——修复前这里会 ReferenceError: refreshSession is not defined */
runtimeErrors.length = 0;
await ev(`document.querySelector('#pub-all').click()`);
check('完全公开成功提示', await waitFor(`document.body.textContent.includes('现在任何人都能在公开档案搜索到')`, 15000));
check('无 refreshSession 报错', !runtimeErrors.some((e) => e.includes('refreshSession')), runtimeErrors.join(' | '));

/* 7. 会话确实变成 public 且访客可搜索 */
const me2 = await fetch(`${BASE}/api/auth/me?sharecode=${SC}`, { headers: { Cookie: regCookie, 'X-Requested-With': 'XMLHttpRequest' } }).then((r) => r.json());
check('会话 privacy 已更新为 public', me2.user?.privacy === 'public', JSON.stringify(me2.user?.privacy));
const found = await fetch(`${BASE}/api/discover?q=${encodeURIComponent(TOKEN)}&sharecode=${SC}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }).then((r) => r.json());
check('访客搜索命中投稿文案 ×2', found.popular.filter((p) => p.content.includes(TOKEN)).length === 2, JSON.stringify(found.popular.length));

/* 8. 场景 C：公开用户再次投稿，直接显示可搜索提示（无需引导） */
const TOKEN2 = 'CTP' + Math.random().toString(36).slice(2, 8).toUpperCase();
const payload2 = {
  v: 1,
  from: '部分公开测试',
  entries: [{ content: `部分公开投稿 ${TOKEN2} 海边的落日把浪染成金色。`, title: '', tags: ['中文'], categories: ['城市漫游'] }],
  categories: ['城市漫游'],
};
const url2 = `${BASE}/contribute?sharecode=${SC}#ct=${encodeContribution(payload2)}`;
await send('Page.navigate', { url: 'about:blank' });
await sleep(500);
await send('Page.navigate', { url: url2 });
for (let i = 0; i < 5; i++) {
  if (await ev(`location.pathname === '/contribute' && location.hash.length > 40`)) break;
  await sleep(800);
  await ev(`location.href = ${JSON.stringify(url2)}`);
}
check('场景C 投稿页打开（已登录直接预览）', await waitFor(`!!document.querySelector('#ct-go')`, 20000));
await ev(`document.querySelector('#ct-go').click()`);
check('场景C 投稿完成', await waitFor(`document.body.textContent.includes('投稿完成')`, 30000));
check('场景C 公开用户直接显示可搜索提示', await waitFor(`document.body.textContent.includes('完全公开')`, 15000));

/* 9. 清场：恢复 private */
await fetch(`${BASE}/api/profile?sharecode=${SC}`, { method: 'PUT', headers: { ...HDR, Cookie: regCookie }, body: JSON.stringify({ privacy: 'private' }) });

const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} 项场景B/C 检查通过`);
process.exit(passed === results.length ? 0 : 1);
