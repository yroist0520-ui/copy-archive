/* 线上截图：header 印章 logo（浅色/深色主题）+ favicon 探测 */
import { writeFileSync } from 'node:fs';
const CDP = 'http://127.0.0.1:9222';
const BASE = 'https://wbapp-kvp8vfjqdet5wf5ww0viai.app.workbuddy.host';
const SC = 'HC3YZORW3G';

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
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((r) => r.result?.result?.value);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });

await send('Page.navigate', { url: `${BASE}/?sharecode=${SC}` });
await sleep(3500);

// favicon 是否可达
const fav = await ev(`fetch('/favicon.svg').then(r=>r.status).catch(e=>'ERR')`);
console.log('favicon.svg HTTP:', fav);
const fav32 = await ev(`fetch('/icons/icon-32.png').then(r=>r.status).catch(e=>'ERR')`);
console.log('icon-32.png HTTP:', fav32);
const brandSvg = await ev(`!!document.querySelector('.brand-mark svg')`);
console.log('header 内联印章 SVG:', brandSvg);

// 浅色主题 header 截图
const shot1 = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 140, scale: 2 } });
writeFileSync('/tmp/ca_header_light.png', Buffer.from(shot1.result.data, 'base64'));
console.log('浅色 header ✓');

// 深色主题
await ev(`document.documentElement.setAttribute('data-theme','ink')`);
await sleep(600);
const shot2 = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 140, scale: 2 } });
writeFileSync('/tmp/ca_header_dark.png', Buffer.from(shot2.result.data, 'base64'));
console.log('深色 header ✓');
process.exit(0);
