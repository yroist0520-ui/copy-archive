/* 线上投稿端到端：静态版 payload → /contribute 注册导入 → 公开 → 陌生访客可搜索 */
const CDP = 'http://127.0.0.1:9222';
const BASE = 'https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host';
const SC = 'HC3YZORW3G';
const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, !!ok]);
  console.log(`${ok ? '  PASS  ' : '  FAIL  '}${name}${!ok && detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 与 contribute.js 相同的编码 */
function encodeContribution(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const TOKEN = 'CT' + Math.random().toString(36).slice(2, 8).toUpperCase();
const payload = {
  v: 1,
  from: '静态版测试档案',
  entries: [
    { content: `投稿测试一 ${TOKEN} 晚风把云揉成橘子味的软糖。`, title: '', tags: ['中文'], categories: ['旅行手记'] },
    { content: `投稿测试二 ${TOKEN} Collect moments, not things.`, title: '', tags: ['英文'], categories: ['旅行手记'] },
    { content: `投稿测试三 ${TOKEN} 无分类的一句话。`, title: '', tags: ['中文'], categories: [] },
  ],
  categories: ['旅行手记'],
};
const url = `${BASE}/contribute?sharecode=${SC}#ct=${encodeContribution(payload)}`;

/* CDP 会话 */
const targets = await fetch(CDP + '/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
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

// 1. 打开投稿页（未登录）
await send('Page.navigate', { url });
await waitFor(`!!document.querySelector('.section-title')`);
check('投稿页渲染', await ev(`document.body.textContent.includes('投稿到公开档案')`));
check('识别投稿内容（3 条）', await ev(`document.body.textContent.includes('3 条')`));
check('未登录显示注册引导', await ev(`!!document.querySelector('#ct-auth')`));

// 2. 注册（openAuth 注册页签）
await ev(`document.querySelector('#ct-auth').click()`);
await waitFor(`!!document.querySelector('#auth-account')`);
const user = 'ctr' + Math.random().toString(36).slice(2, 8);
await ev(`
  document.querySelector('#auth-account').value = '${user}';
  document.querySelector('#auth-email').value = '${user}@t.dev';
  document.querySelector('#auth-pass').value = 'secret123';
  document.querySelector('#auth-name').value = '投稿验收员';
  true
`);
await ev(`document.querySelector('.modal [data-submit], [data-submit]').click()`);
check('注册成功回到投稿预览', await waitFor(`!!document.querySelector('#ct-go') && document.body.textContent.includes('确认投稿')`, 20000));
check('预览显示来源昵称', await ev(`document.body.textContent.includes('静态版测试档案')`));
check('预览显示分类「旅行手记」', await ev(`document.body.textContent.includes('旅行手记')`));
check('查重计数已返回', await waitFor(`document.querySelector('#ct-dup')?.textContent !== '…'`, 15000));

// 3. 确认投稿 → 新注册用户默认完全公开 → 显示"现在就能搜到"
await ev(`document.querySelector('#ct-go').click()`);
check('投稿完成提示', await waitFor(`document.body.textContent.includes('投稿完成')`, 30000));
check('完全公开提示出现', await waitFor(`document.body.textContent.includes('现在任何人都能在公开档案搜索到')`, 15000));

// 4. 陌生访客（新会话 cookie 已清）可搜索投稿文案
await send('Network.clearBrowserCookies');
const found = await fetch(`${BASE}/api/discover?q=${encodeURIComponent(TOKEN)}&sharecode=${SC}`, {
  headers: { 'X-Requested-With': 'XMLHttpRequest' },
}).then((r) => r.json());
check('访客搜索命中投稿文案 ×2', found.popular.filter((p) => p.content.includes(TOKEN)).length === 2, JSON.stringify(found.popular.length));
const prof = await fetch(`${BASE}/api/public/u/${user}?sharecode=${SC}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }).then((r) => r.json());
check('公开档案统计 3 条 / 1 分类', prof.copyCount === 3 && prof.categoryCount === 1, JSON.stringify({ c: prof.copyCount, cat: prof.categoryCount }));

// 5. 清场：设为私密
await fetch(`${BASE}/api/profile?sharecode=${SC}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  body: JSON.stringify({ privacy: 'private' }),
});

const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} 项投稿检查通过`);
process.exit(passed === results.length ? 0 : 1);
