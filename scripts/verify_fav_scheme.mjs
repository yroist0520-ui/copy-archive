/* 验证 favicon.svg 的 prefers-color-scheme 自适应：深/浅模拟各截一张 */
import { readFileSync, writeFileSync } from 'node:fs';
const CDP = 'http://127.0.0.1:9222';
const svgPath = new URL('../public/favicon.svg', import.meta.url).pathname;
const svgData = encodeURIComponent(readFileSync(svgPath, 'utf8'));

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
await send('Page.enable');

const html = `<!DOCTYPE html><html><body style="margin:0;background:#666;display:flex">
<div style="background:#1A1A1C;padding:20px"><img src="data:image/svg+xml,${svgData}" width="80" height="80"></div>
<div style="background:#F7F7F5;padding:20px"><img src="data:image/svg+xml,${svgData}" width="80" height="80"></div>
</body></html>`;
await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
await new Promise((r) => setTimeout(r, 800));
await send('Emulation.setDeviceMetricsOverride', { width: 240, height: 120, deviceScaleFactor: 2, mobile: false });

// light 模式（默认）
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await new Promise((r) => setTimeout(r, 400));
let shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/ca_fav_light.png', Buffer.from(shot.result.data, 'base64'));

// dark 模式
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await new Promise((r) => setTimeout(r, 400));
shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/ca_fav_dark.png', Buffer.from(shot.result.data, 'base64'));
console.log('light + dark previews saved');
process.exit(0);
