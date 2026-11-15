/* 全站视觉巡检：注册演示档案并逐页截图（浅色 + 深色 + 移动端） */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'http://127.0.0.1:8081/copy-archive';
const OUT = process.env.SHOT_DIR || '/tmp/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { writeFile, mkdir } = await import('node:fs/promises');
await mkdir(OUT, { recursive: true }).catch(() => {});

const targets = await fetch(`${CDP}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => { ws.onopen = resolve; });
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
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
  await sleep(700);
}
async function shot(name, width = 1440, height = 1000) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 });
  await sleep(800);
  const response = await send('Page.captureScreenshot', { format: 'png' });
  const data = response.result && response.result.data;
  if (!data) { console.log('  截图失败:', name); return; }
  await writeFile(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  console.log('  已保存', name);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.clearBrowserCookies');
await evaluate('localStorage.clear(); sessionStorage.clear();');

/* ---- 注册演示档案 ---- */
await go('/');
const user = 'demo' + String(Date.now()).slice(-6);
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

/* ---- 批量导入文案 ---- */
const lines = [
  'Somewhere between dreams and reality.',
  'Stay strange.',
  'Lost in another world.',
  'A little piece of heaven.',
  '在光落下来的地方，我等一场雨。',
  '把心事折成纸飞机，扔进人间。',
  'Rain on the window, quiet all night.',
  '彼女は笑った。',
  '꿈처럼 흘러가는 시간.',
  'Stay strange. Stay soft. Stay yours.',
  '万物皆有裂痕，那是光照进来的地方。',
  'The best things in life are free.',
];
await go('/upload');
await evaluate(`document.querySelector('[data-tab="batch"]').click()`);
await sleep(250);
await evaluate(`document.querySelector('#b-text').value=${JSON.stringify(lines.join('\n'))}`);
await evaluate(`document.querySelector('#b-text').dispatchEvent(new Event('input'))`);
await sleep(250);
await evaluate(`document.querySelectorAll('#b-cats .chip')[0].click()`);
await evaluate(`document.querySelectorAll('#b-cats .chip')[14].click()`);
await evaluate(`document.querySelector('#b-preview').click()`);
await sleep(800);
await evaluate(`document.querySelector('#b-save').click()`);
await sleep(1300);

/* ---- 逐页截图 ---- */
console.log('浅色主题：');
await go('/');
await shot('01-home', 1440, 1050);
await go('/archive');
await shot('02-archive', 1440, 1050);
await go('/archive');
await evaluate(`document.querySelector('[data-mode="list"]').click()`);
await sleep(700);
await shot('03-archive-list', 1440, 900);
await go('/categories');
await shot('04-categories', 1440, 1000);
await go('/upload');
await shot('05-upload', 1440, 1000);
await go('/favorites');
await shot('06-favorites', 1440, 800);
await go('/profile');
await shot('07-profile', 1440, 1150);
await go('/discover');
await shot('08-discover', 1440, 900);

/* ---- 深色主题 ---- */
console.log('深色主题：');
await evaluate(`document.documentElement.dataset.theme='ink'; localStorage.setItem('ca_theme','ink')`);
await go('/');
await shot('09-home-dark', 1440, 1050);
await go('/archive');
await shot('10-archive-dark', 1440, 1050);
await go('/profile');
await shot('11-profile-dark', 1440, 1100);

/* ---- 移动端 ---- */
console.log('移动端：');
await evaluate(`document.documentElement.dataset.theme='paper'; localStorage.setItem('ca_theme','paper')`);
await go('/');
await shot('12-home-mobile', 390, 844);
await go('/archive');
await shot('13-archive-mobile', 390, 844);
await go('/profile');
await shot('14-profile-mobile', 390, 900);
await go('/categories');
await shot('15-categories-mobile', 390, 844);

/* ---- 平板 ---- */
await go('/archive');
await shot('16-archive-tablet', 768, 1024);

console.log('运行时错误：', errors.length ? errors.slice(0, 3) : '无');
ws.close();
process.exit(0);
