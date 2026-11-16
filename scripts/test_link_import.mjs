/* 链接导入端到端 UI 测试（线上）：登录 → 上传页链接 tab → 抓取演示页 → 勾选 → 预览 → 批量导入 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host';
const SHARE = process.env.CA_SHARE || 'HC3YZORW3G';
const withShare = (path) => BASE + path + (SHARE ? (path.includes('?') ? '&' : '?') + 'sharecode=' + SHARE : '');
const DEMO = BASE + '/linkdemo.html' + (SHARE ? '?sharecode=' + SHARE : '');
let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(expr, timeout = 15000, interval = 250) {
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
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

// 0. 登录（fetch 同源自动带 Set-Cookie）
await send('Page.navigate', { url: withShare('/') });
await sleep(3000);
const user = 'lnk' + String(Date.now()).slice(-6);
const reg = await ev(`fetch('/api/auth/register?sharecode=${SHARE}',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},body:JSON.stringify({username:'${user}',email:'${user}@t.dev',password:'secret123',displayName:'链接测试'})}).then(r=>r.status).catch(e=>'ERR:'+e.message)`);
check('注册测试账号（200）', reg === 200);

// 1. 上传页 → 链接导入 tab
await send('Page.navigate', { url: withShare('/upload') });
check('上传页打开（含链接导入 tab）', await waitFor(`!!document.querySelector('[data-tab="link"]')`, 20000));
await ev(`document.querySelector('[data-tab="link"]').click()`);
check('链接导入 tab 渲染', await waitFor(`!!document.querySelector('#l-url')`));

// 2. 抓取演示页
await ev(`document.querySelector('#l-url').value = '${DEMO}'`);
await ev(`document.querySelector('#l-fetch').click()`);
check('抓取完成，行列表出现', await waitFor(`document.querySelectorAll('#l-lines .l-line-row').length > 0`, 40000));
const lineCount = await ev(`document.querySelectorAll('#l-lines .l-line-row').length`);
const imgCount = await ev(`document.querySelectorAll('#l-imgs .l-img-cell').length`);
check(`提取到 ${lineCount} 行文字（≥8）`, lineCount >= 8);
check(`提取到 ${imgCount} 张图片（≥1）`, imgCount >= 1);
const hasDup = await ev(`[...document.querySelectorAll('#l-lines .l-line-input')].filter(i=>i.value==='心有山海，静而无争。').length === 1`);
check('重复行自动去重', hasDup === true);
const noToolbar = await ev(`![...document.querySelectorAll('#l-lines .l-line-input')].some(i=>i.value.includes('扫码关注'))`);
check('正文区外的噪音已过滤', noToolbar === true);

// 3. 图片走代理加载
const imgLoaded = await ev(`new Promise(res=>{const im=document.querySelector('#l-imgs img'); if(im.complete) return res(im.naturalWidth>0); im.onload=()=>res(im.naturalWidth>0); im.onerror=()=>res(false); setTimeout(()=>res(false),10000)})`);
check('图片经代理正常加载', imgLoaded === true);

// 4. 只保留前 3 行 → 生成预览
await ev(`[...document.querySelectorAll('.l-line-check')].forEach((cb,i)=>{cb.checked=i<3;cb.dispatchEvent(new Event('change'))})`);
const keepCount = await ev(`(document.querySelector('#l-keep-count')||{textContent:''}).textContent`);
check(`勾选计数更新（${String(keepCount).trim()}）`, String(keepCount).includes('3 /'));
await ev(`document.querySelector('#l-preview').click()`);
check('导入预览出现（3 行）', await waitFor(`document.querySelectorAll('#l-preview-host .preview-row').length === 3`, 15000));

// 5. 确认保存
await ev(`document.querySelector('#l-save').click()`);
check('批量导入成功（toast）', await waitFor(`[...document.querySelectorAll('[class*=toast]')].some(t=>t.textContent.includes('成功收录 3 条'))`, 15000));

// 6. 数据验证
const mine = await ev(`fetch('/api/copies?sharecode=${SHARE}',{headers:{'X-Requested-With':'XMLHttpRequest'}}).then(r=>r.json()).then(d=>d.items||d.copies||[])`);
const arr = typeof mine === 'string' ? JSON.parse(mine) : (Array.isArray(mine) ? mine : []);
const contents = arr.map((c) => c.content);
const EXPECT = [
  '测试：十句治愈系文案',
  '若人生是一场旅行，那么无论繁华与落寂，都是过眼烟云，留下的是看风景的心情。',
  '你被大地稳稳地托举着，你怕什么呢。',
];
check('档案中出现 3 条新文案', arr.length >= 3);
check('内容原文保留', EXPECT.every((t) => contents.includes(t)));

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
