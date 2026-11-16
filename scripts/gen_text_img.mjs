/* 生成含中文文案的测试图片：CDP 渲染文字截图 */
import { writeFileSync } from 'node:fs';
const CDP = 'http://127.0.0.1:9222';
const targets = await fetch(CDP + '/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
await send('Page.enable');
const html = `<!DOCTYPE html><html><body style="margin:0;background:#fdfcf8;width:640px;height:360px">
<div style="padding:50px 60px;font-family:'Songti SC','Noto Serif SC',serif;font-size:30px;line-height:2.1;color:#222">
  <p>你被大地稳稳地托举着，你怕什么呢。</p>
  <p>我见一万只飞鸟向你的眼睛迁徙。</p>
</div></body></html>`;
await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
await new Promise((r) => setTimeout(r, 1000));
await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 360, deviceScaleFactor: 2, mobile: false });
await new Promise((r) => setTimeout(r, 400));
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(new URL('../public/linkimg/text01.png', import.meta.url), Buffer.from(shot.result.data, 'base64'));
console.log('text01.png 生成完成');
process.exit(0);
