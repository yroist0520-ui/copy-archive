/* 用 CDP 把 favicon.svg 渲染成 PNG：apple-touch-icon 180 / 32 / 16 */
import { readFileSync, writeFileSync } from 'node:fs';
const CDP = 'http://127.0.0.1:9222';
const SVG = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');

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

async function shoot(size, bg, transparent) {
  const html = `<!DOCTYPE html><html style="background:${bg}"><body style="margin:0;background:${bg}">
<style>#s path{stroke:#FFFFFF}</style>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" id="s">
  ${SVG.replace(/<\/?svg[^>]*>/g, '').replace(/<title>[\s\S]*?<\/title>/, '').replace(/<style>[\s\S]*?<\/style>/, '')}
</svg></body></html>`;
  await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
  await new Promise((r) => setTimeout(r, 800));
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 300));
  const shot = await send('Page.captureScreenshot', { format: 'png', omitBackground: transparent });
  if (!shot.result?.data) {
    console.error(`capture failed at ${size}:`, JSON.stringify(shot).slice(0, 300));
    throw new Error('no screenshot data');
  }
  writeFileSync(new URL(`../public/icons/icon-${size}.png`, import.meta.url), Buffer.from(shot.result.data, 'base64'));
  console.log(`icon-${size}.png ✓`);
}

// 180：iOS 主屏不支持透明，用墨色底白书形；32/16：透明底白线条
await shoot(180, '#1A1A1C', false);
await shoot(32, 'transparent', true);
await shoot(16, 'transparent', true);
process.exit(0);
