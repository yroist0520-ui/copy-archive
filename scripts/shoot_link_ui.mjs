/* 截取链接导入界面效果图（抓取完成后整页截图） */
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
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1500, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: BASE + '/?sharecode=' + SHARE });
await sleep(3000);
const user = 'shot' + String(Date.now()).slice(-6);
await ev(`fetch('/api/auth/register?sharecode=${SHARE}',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},body:JSON.stringify({username:'${user}',email:'${user}@t.dev',password:'secret123',displayName:'截图'})})`);
await send('Page.navigate', { url: BASE + '/upload?sharecode=' + SHARE });
for (let i = 0; i < 30; i++) { await sleep(200); if (await ev(`!!document.querySelector('[data-tab="link"]')`)) break; }
await ev(`document.querySelector('[data-tab="link"]').click()`);
await sleep(400);
await ev(`document.querySelector('#l-url').value = '${BASE}/linkdemo.html?sharecode=${SHARE}'`);
await ev(`document.querySelector('#l-fetch').click()`);
for (let i = 0; i < 80; i++) { await sleep(250); if (await ev(`!!document.querySelector('#l-lines')`)) break; }
await sleep(1200);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
const { writeFileSync } = await import('node:fs');
writeFileSync('/tmp/ca_link_ui.png', Buffer.from(shot.result.data, 'base64'));
console.log('UI 截图完成');
process.exit(0);
