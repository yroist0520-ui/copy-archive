/* OCR 链路测试：抓取演示页 → 点击识别图片 → 等待识别结果追加到行列表 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host';
const SHARE = process.env.CA_SHARE || 'HC3YZORW3G';
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
const user = 'ocr' + String(Date.now()).slice(-6);
await ev(`fetch('/api/auth/register?sharecode=${SHARE}',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},body:JSON.stringify({username:'${user}',email:'${user}@t.dev',password:'secret123',displayName:'OCR测试'})})`);
await send('Page.navigate', { url: BASE + '/upload?sharecode=' + SHARE });
for (let i = 0; i < 30; i++) { await sleep(200); if (await ev(`!!document.querySelector('[data-tab="link"]')`)) break; }
await ev(`document.querySelector('[data-tab="link"]').click()`);
await ev(`document.querySelector('#l-url').value = '${BASE}/linkdemo.html?sharecode=${SHARE}'`);
await ev(`document.querySelector('#l-fetch').click()`);
for (let i = 0; i < 80; i++) { await sleep(250); if (await ev(`!!document.querySelector('#l-lines')`)) break; }
await sleep(400);
const before = await ev(`document.querySelectorAll('#l-lines .l-line-row').length`);
// 勾选文字图（第 2 张）并点识别
await ev(`[...document.querySelectorAll('.l-img-check-box')][1].checked = true`);
await ev(`document.querySelector('[data-ocr-one="1"]').click()`);
console.log('OCR 已触发，等待引擎下载与识别（可能 1-3 分钟）…');
let status = '';
for (let i = 0; i < 100; i++) {
  await sleep(3000);
  status = await ev(`(document.querySelector('#l-img-status-1')||{textContent:''}).textContent`);
  if (status && /识别到|未识别|失败/.test(status)) break;
  if (i % 4 === 0) console.log('  …', status || '准备中');
}
console.log('OCR 状态:', status);
const after = await ev(`document.querySelectorAll('#l-lines .l-line-row').length`);
const ocrBadge = await ev(`document.querySelectorAll('.l-line-badge').length`);
console.log(`行数 ${before} → ${after}，OCR 徽标 ${ocrBadge} 个`);
const ocrLines = await ev(`[...document.querySelectorAll('.l-line-badge')].map(b=>b.closest('.l-line-row').querySelector('.l-line-input').value)`);
console.log('OCR 追加行:', JSON.stringify(ocrLines));
// OCR 中文输出常带字符间空格，去空格后比对关键词
const flat = ocrLines.map((t) => t.replace(/\s+/g, '')).join('|');
const ok = after > before && (flat.includes('大地') || flat.includes('飞鸟') || flat.includes('托举'));
console.log(ok ? 'OCR PASS（文字识别正确）' : 'OCR FAIL');
process.exit(ok ? 0 : 1);
