/* 一次性诊断：打印抓取结果行内容、图片 img 状态、导入后的档案内容 */
const CDP = 'http://127.0.0.1:9222';
const BASE = 'https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host';
const SHARE = 'HC3YZORW3G';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await fetch(CDP + '/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r.result?.result?.value);

await send('Page.enable'); await send('Runtime.enable');
await send('Network.clearBrowserCookies');
await send('Page.navigate', { url: BASE + '/?sharecode=' + SHARE });
await sleep(3000);
const user = 'dbg' + String(Date.now()).slice(-6);
const reg = await ev(`fetch('/api/auth/register?sharecode=${SHARE}',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},body:JSON.stringify({username:'${user}',email:'${user}@t.dev',password:'secret123',displayName:'诊断'})}).then(r=>r.status)`);
console.log('reg:', reg);
await send('Page.navigate', { url: BASE + '/upload?sharecode=' + SHARE });
for (let i = 0; i < 30; i++) { await sleep(200); if (await ev(`!!document.querySelector('[data-tab="link"]')`)) break; }
await ev(`document.querySelector('[data-tab="link"]').click()`);
await ev(`document.querySelector('#l-url').value = '${BASE}/linkdemo.html?sharecode=${SHARE}'`);
await ev(`document.querySelector('#l-fetch').click()`);
for (let i = 0; i < 80; i++) { await sleep(250); if (await ev(`!!document.querySelector('#l-lines')`)) break; }
await sleep(500);
const lines = await ev(`[...document.querySelectorAll('#l-lines .l-line-input')].map(i=>i.value)`);
console.log('提取行:', JSON.stringify(lines, null, 1));
const imgs = await ev(`[...document.querySelectorAll('#l-imgs img')].map(im=>({src: im.src, complete: im.complete, w: im.naturalWidth, cls: im.className}))`);
console.log('图片状态:', JSON.stringify(imgs, null, 1));
// 直接看代理接口状态（带/不带 sharecode 对比）
const p1 = await ev(`fetch(document.querySelector('#l-imgs img').src).then(async r=>({status:r.status, ct:r.headers.get('content-type'), body:(await r.text()).slice(0,200)}))`).catch(e=>String(e));
console.log('代理(img src 原样):', JSON.stringify(p1));
const target = encodeURIComponent('https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host/linkimg/photo01.png');
const p2 = await ev(`fetch('/api/proxy-image?url=${target}&sharecode=${SHARE}').then(async r=>({status:r.status, ct:r.headers.get('content-type'), body:(await r.text()).slice(0,120)}))`).catch(e=>String(e));
console.log('代理(显式带sharecode):', JSON.stringify(p2));
const p3 = await ev(`fetch('/api/proxy-image?url=${target}').then(async r=>({status:r.status, ct:r.headers.get('content-type'), body:(await r.text()).slice(0,120)}))`).catch(e=>String(e));
console.log('代理(不带sharecode):', JSON.stringify(p3));
process.exit(0);
