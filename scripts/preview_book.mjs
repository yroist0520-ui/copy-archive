/* 深浅两色底预览：验证白色书形在两种背景下都清晰 */
import { readFileSync, writeFileSync } from 'node:fs';
const CDP = 'http://127.0.0.1:9222';
const SVG = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
const inner = SVG.replace(/<\/?svg[^>]*>/g, '').replace(/<title>[\s\S]*?<\/title>/, '');

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

const cell = (bg, label) => `
<div style="background:${bg};width:200px;height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;border-radius:14px">
  <svg viewBox="0 0 64 64" width="96" height="96" xmlns="http://www.w3.org/2000/svg">${inner}</svg>
  <div style="display:flex;gap:14px;align-items:flex-end">
    <svg viewBox="0 0 64 64" width="32" height="32" xmlns="http://www.w3.org/2000/svg">${inner}</svg>
    <svg viewBox="0 0 64 64" width="16" height="16" xmlns="http://www.w3.org/2000/svg">${inner}</svg>
  </div>
  <div style="color:${label};font:12px sans-serif;letter-spacing:1px">${bg === '#1A1A1C' ? 'DARK TAB' : 'LIGHT TAB'}</div>
</div>`;

const html = `<!DOCTYPE html><html><body style="margin:0;background:#888;display:flex;gap:16px;padding:16px">
${cell('#1A1A1C', '#999')}${cell('#F7F7F5', '#555')}
</body></html>`;
await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
await new Promise((r) => setTimeout(r, 800));
await send('Emulation.setDeviceMetricsOverride', { width: 448, height: 252, deviceScaleFactor: 2, mobile: false });
await new Promise((r) => setTimeout(r, 300));
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/ca_book_preview.png', Buffer.from(shot.result.data, 'base64'));
console.log('preview saved');
process.exit(0);
