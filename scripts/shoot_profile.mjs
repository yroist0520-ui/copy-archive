/* 档案页效果图：演示头像上传槽与封面 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'https://yroist0520-ui.github.io/copy-archive';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`${CDP}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
async function go(path) {
  await send('Page.navigate', { url: BASE + path });
  for (let i = 0; i < 60; i += 1) {
    await sleep(150);
    if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('#app > *')`)) break;
  }
  await sleep(600);
}
async function shot(file, width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 });
  await sleep(700);
  const response = await send('Page.captureScreenshot', { format: 'png' });
  const data = response.result && response.result.data;
  if (!data) throw new Error('截图失败');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, Buffer.from(data, 'base64'));
  console.log('已保存', file);
}
/** 合成一张渐变方图作为头像 */
async function pickAvatar(selector) {
  return evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 600;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 600, 600);
    g.addColorStop(0, '#262521'); g.addColorStop(1, '#8c877d');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 600, 600);
    ctx.fillStyle = '#f5f3ee';
    ctx.font = '300px Georgia';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('CA', 300, 300);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const file = new File([blob], 'a.png', { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return 'no-input';
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return 'ok';
  })()`);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.clearBrowserCookies');
await evaluate('localStorage.clear(); sessionStorage.clear();');

await go('/');
const user = 'shot' + String(Date.now()).slice(-6);
await evaluate(`document.querySelector('#auth-btn').click()`);
await sleep(400);
await evaluate(`document.querySelector('.auth-switch').click()`);
await sleep(300);
await evaluate(`document.querySelector('#auth-account').value=${JSON.stringify(user)}`);
await evaluate(`document.querySelector('#auth-email').value=${JSON.stringify(user + '@shot.test')}`);
await evaluate(`document.querySelector('#auth-pass').value='secret123'`);
await evaluate(`document.querySelector('#auth-name').value='雾岛档案'`);
await evaluate(`document.querySelector('[data-submit]').click()`);
await sleep(1200);

await go('/profile');
await pickAvatar('#p-avatar-file');
await sleep(1500);
await evaluate(`document.querySelector('#p-save').click()`);
await sleep(1200);

await go('/profile');
await shot('/tmp/live-profile-desktop.png', 1440, 1180);
await shot('/tmp/live-profile-mobile.png', 390, 900);

console.log('演示账号:', user);
ws.close();
process.exit(0);
