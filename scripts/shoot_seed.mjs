/* 示例文案填充后的档案馆效果图：档案页 / 文案库 / 公开档案页 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'http://127.0.0.1:8081/copy-archive';
const OUT = process.env.SHOT_DIR || '/tmp/ca-seed';
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

// 注册
await go('/');
const user = 'arch' + String(Date.now()).slice(-6);
await evaluate(`document.querySelector('#auth-btn').click()`);
await sleep(400);
await evaluate(`document.querySelector('.auth-switch').click()`);
await sleep(300);
await evaluate(`document.querySelector('#auth-account').value=${JSON.stringify(user)}`);
await evaluate(`document.querySelector('#auth-email').value=${JSON.stringify(user + '@arch.test')}`);
await evaluate(`document.querySelector('#auth-pass').value='secret123'`);
await evaluate(`document.querySelector('#auth-name').value='雾岛档案'`);
await evaluate(`document.querySelector('[data-submit]').click()`);
await sleep(1300);

// 填充示例文案
await go('/profile');
await evaluate(`document.querySelector('#p-seed').click()`);
await sleep(3000);
await shot('01-profile-seeded', 1440, 1200);

// 完善档案资料
await evaluate(`(()=>{const n=document.querySelector('#p-name'); n.value='雾岛档案'; n.dispatchEvent(new Event('input'));})()`);
await evaluate(`(()=>{const b=document.querySelector('#p-bio'); b.value='收藏一切让我停顿的句子。英文、韩文、中文，安静的、锋利的、温柔的都留着。'; b.dispatchEvent(new Event('input'));})()`);
await evaluate(`document.querySelector('#p-save').click()`);
await sleep(1500);

// 文案库
await go('/archive');
await shot('02-archive-seeded', 1440, 1050);

// 公开档案（访客视角）
await go(`/u/${user}`);
await shot('03-public-archive', 1440, 1050);

// 分类页
await go('/categories');
await shot('04-categories-seeded', 1440, 1000);

// 发现页
await go('/discover');
await shot('05-discover-seeded', 1440, 900);

// 移动端公开档案
await go(`/u/${user}`);
await shot('06-public-mobile', 390, 844);

console.log('演示账号:', user);
console.log('运行时错误:', errors.length ? errors.slice(0, 3) : '无');
ws.close();
process.exit(0);
