/* 生成线上站点效果图：建立演示档案并批量收录多语言文案后截图 */
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
  await sleep(500);
}
async function shot(file, width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: width < 600,
  });
  await sleep(700);
  const response = await send('Page.captureScreenshot', { format: 'png' });
  const data = response.result && response.result.data;
  if (!data) throw new Error('截图数据为空：' + JSON.stringify(response).slice(0, 200));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, Buffer.from(data, 'base64'));
  console.log('已保存', file);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.clearBrowserCookies');
await evaluate('localStorage.clear(); sessionStorage.clear();');

const user = 'demo' + String(Date.now()).slice(-6);
await go('/');
await evaluate(`document.querySelector('#auth-btn').click()`);
await sleep(400);
await evaluate(`document.querySelector('.auth-switch').click()`);
await sleep(300);
await evaluate(`document.querySelector('#auth-account').value=${JSON.stringify(user)}`);
await evaluate(`document.querySelector('#auth-email').value=${JSON.stringify(user + '@demo.test')}`);
await evaluate(`document.querySelector('#auth-pass').value='secret123'`);
await evaluate(`document.querySelector('#auth-name').value='林间档案'`);
await evaluate(`document.querySelector('[data-submit]').click()`);
await sleep(1200);

// 批量导入代表性文案
const lines = [
  'Somewhere between dreams and reality.',
  'Stay strange.',
  'Lost in another world.',
  'A little piece of heaven.',
  '在光落下来的地方，我等一场雨。',
  '把心事折成纸飞机，扔进人间。',
  'chanical rain on the window.',
  '彼女は笑った。',
  '꿈처럼 흘러가는 시간.',
  'Stay strange. Stay soft. Stay yours.',
];
await go('/upload');
await evaluate(`document.querySelector('[data-tab="batch"]').click()`);
await sleep(250);
await evaluate(`document.querySelector('#b-text').value=${JSON.stringify(lines.join('\n'))}`);
await evaluate(`document.querySelector('#b-text').dispatchEvent(new Event('input'))`);
await sleep(200);
await evaluate(`document.querySelectorAll('#b-cats .chip')[0].click()`);
await evaluate(`document.querySelector('#b-preview').click()`);
await sleep(700);
await evaluate(`document.querySelector('#b-save').click()`);
await sleep(1200);

// 给前几条加上多分类与收藏
await go('/archive');
await sleep(400);

await go('/');
await shot('/tmp/live-home-desktop.png', 1440, 1000);
await go('/archive');
await shot('/tmp/live-archive-desktop.png', 1440, 1100);
await go('/');
await shot('/tmp/live-home-mobile.png', 390, 844);

console.log('演示账号:', user);
ws.close();
process.exit(0);
