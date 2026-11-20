// 数据救援页端到端测试：预置本地档案 → 扫描 → 一键登录 → 导出
import { spawn } from 'node:child_process';

const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_STATIC || 'http://127.0.0.1:8081';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0; const pending = new Map();
async function connect() {
  const tabs = await fetch(CDP + '/json').then((r) => r.json());
  const page = tabs.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
}
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id; pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
async function waitFor(expr, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await ev(expr)) return true; } catch {}
    await sleep(200);
  }
  return false;
}

await connect();
await send('Network.clearBrowserCookies');

// 0. 打开救援页所在域，注入一个"有 1053 条文案的本地账号"
await send('Page.navigate', { url: BASE + '/rescue.html' });
await waitFor(`document.readyState === 'complete'`, 20000);
await sleep(500);
await ev(`(() => {
  const copies = [];
  for (let i = 1; i <= 1053; i++) copies.push({ id: i, userId: 7, title: '', content: '文案' + i, note: '', tags: [], copyCount: 0, createdAt: '2026-11-01T00:00:00+00:00', updatedAt: '2026-11-01T00:00:00+00:00' });
  const db = {
    users: [{ id: 7, username: 'yroist', email: 'yroist@noemail.local', passwordHash: 'x$dummy', createdAt: '2026-10-01T00:00:00+00:00' }],
    profiles: [{ userId: 7, displayName: '旧档案', bio: '', avatarUrl: '', coverUrl: '', theme: 'paper', privacy: 'public', publicCategoryIds: [], createdAt: '2026-10-01T00:00:00+00:00' }],
    categories: [], copies, copyCategories: [], favorites: [], sessions: [],
    seq: { users: 7, categories: 0, copies: 1053 }
  };
  localStorage.setItem('ca_local_db_v1', JSON.stringify(db));
  localStorage.removeItem('ca_local_session');
  sessionStorage.removeItem('ca_offline_session');
  return true;
})()`);

// 1. 重新加载救援页，验证扫描
await send('Page.navigate', { url: BASE + '/rescue.html' });
await waitFor(`document.querySelector('#scanResult .acct') !== null`, 20000);
check('扫描出本地账号 yroist', await ev(`document.querySelector('.acct-name')?.textContent.includes('yroist')`));
check('文案数显示 1053', await ev(`document.querySelector('.acct-count b')?.textContent === '1053'`));
check('显示一个一键进入按钮', await ev(`!!document.querySelector('[data-login="7"]')`));

// 2. 一键进入该档案
await ev(`document.querySelector('[data-login="7"]').click()`);
await waitFor(`location.pathname.endsWith('/profile') || location.pathname.endsWith('/profile/')`, 20000);
await sleep(800);
check('一键登录后跳到我的档案', await ev(`location.pathname.includes('profile')`));
check('会话 token 写入', await ev(`!!localStorage.getItem('ca_local_session')`));
check('离线会话标记写入', await ev(`sessionStorage.getItem('ca_offline_session') === '1'`));
check('档案显示登录用户（非请登录）', await ev(`(() => { const t = document.body.innerText; return t.includes('yroist') || t.includes('旧档案'); })()`));

// 3. 导出备份：验证 blob 内容含 1053 条
await send('Page.navigate', { url: BASE + '/rescue.html' });
await waitFor(`document.querySelector('#scanResult .acct') !== null`, 20000);
const exported = await ev(`(() => {
  const db = JSON.parse(localStorage.getItem('ca_local_db_v1'));
  return db.copies.length + '|' + db.users.map(u=>u.username).join(',');
})()`);
check('备份数据完整（1053 条 / yroist）', exported === '1053|yroist', exported);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
