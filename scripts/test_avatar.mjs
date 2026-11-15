/* 头像 / 封面图片上传专项测试：本地选择图片 → 浏览器压缩 → 保存 → 公开页可见 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'http://127.0.0.1:8765';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push([name, !!ok]);
  console.log(`${ok ? '  PASS  ' : '  FAIL  '}${name}${!ok && detail ? ' — ' + detail : ''}`);
}

const targets = await fetch(`${CDP}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
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
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}
async function go(path) {
  await send('Page.navigate', { url: BASE + path });
  for (let i = 0; i < 50; i += 1) {
    await sleep(150);
    if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('#app > *')`)) break;
  }
  await sleep(350);
}

/** 在页面内合成一张图片并触发文件选择 */
async function pickImage(selector, { w = 900, h = 900, color = '#b23a2b' } = {}) {
  return evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = ${w}; canvas.height = ${h};
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = ${JSON.stringify(color)};
    ctx.fillRect(0, 0, ${w}, ${h});
    ctx.fillStyle = '#f5f3ee';
    ctx.fillRect(${Math.round(w / 4)}, ${Math.round(h / 4)}, ${Math.round(w / 2)}, ${Math.round(h / 2)});
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const file = new File([blob], 'upload.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return 'no-input';
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return 'dispatched';
  })()`);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.clearBrowserCookies');
await evaluate('localStorage.clear(); sessionStorage.clear();');

// 注册
await go('/');
const user = 'av' + String(Date.now()).slice(-6);
await evaluate(`document.querySelector('#auth-btn').click()`);
await sleep(400);
await evaluate(`document.querySelector('.auth-switch').click()`);
await sleep(300);
await evaluate(`document.querySelector('#auth-account').value=${JSON.stringify(user)}`);
await evaluate(`document.querySelector('#auth-email').value=${JSON.stringify(user + '@av.test')}`);
await evaluate(`document.querySelector('#auth-pass').value='secret123'`);
await evaluate(`document.querySelector('#auth-name').value='头像验收档案'`);
await evaluate(`document.querySelector('[data-submit]').click()`);
await sleep(1200);
check('注册成功', (await evaluate(`document.querySelector('#auth-btn').textContent`)).includes('头像验收'));

// 档案页
await go('/profile');
check('头像上传槽存在', await evaluate(`!!document.querySelector('#p-avatar-slot')`));
check('封面上传槽存在', await evaluate(`!!document.querySelector('#p-cover-slot')`));
check('已移除头像链接输入框', await evaluate(`!document.querySelector('#p-avatar') && !document.querySelector('#p-cover')`));

// 上传头像
const picked = await pickImage('#p-avatar-file', { w: 900, h: 900 });
check('文件选择已触发', picked === 'dispatched', String(picked));
await sleep(1200);
const avatarSrc = await evaluate(`document.querySelector('#p-avatar-slot .upload-preview').src`);
check('头像已压缩为 data URL', typeof avatarSrc === 'string' && avatarSrc.startsWith('data:image/'), String(avatarSrc).slice(0, 40));
check('压缩后体积合理（<120KB）', typeof avatarSrc === 'string' && avatarSrc.length < 120000, `${Math.round((avatarSrc || '').length / 1024)}KB`);
check('预览图可见', await evaluate(`!document.querySelector('#p-avatar-slot .upload-preview').hidden`));

// 上传封面
await pickImage('#p-cover-file', { w: 1800, h: 600, color: '#262521' });
await sleep(1200);
check('封面已压缩为 data URL', (await evaluate(`document.querySelector('#p-cover-slot .upload-preview').src`)).startsWith('data:image/'));

// 保存
await evaluate(`document.querySelector('#p-save').click()`);
await sleep(1200);
check('保存成功提示', await evaluate(`document.body.textContent.includes('档案设置已保存')`));
check('顶部头像已更新为图片', await evaluate(`!!document.querySelector('.profile-head .avatar img')`));

// 刷新后持久化
await go('/profile');
check('刷新后头像仍在', await evaluate(`!!document.querySelector('.profile-head .avatar img')`));
check('刷新后封面临时仍在', await evaluate(`!!document.querySelector('.cover-strip')`));

// 公开档案页（访客视角）
await go(`/u/${user}`);
check('公开档案页显示头像', await evaluate(`!!document.querySelector('.profile-head .avatar img')`));
const pubSrc = await evaluate(`(document.querySelector('.profile-head .avatar img')||{}).src || ''`);
check('公开页头像为 data URL', String(pubSrc).startsWith('data:image/'), String(pubSrc).slice(0, 40));

// 移除功能
await go('/profile');
await evaluate(`document.querySelector('#p-avatar-slot .upload-clear').click()`);
await sleep(300);
check('移除后预览隐藏', await evaluate(`document.querySelector('#p-avatar-slot .upload-preview').hidden`));
await evaluate(`document.querySelector('#p-save').click()`);
await sleep(1000);
check('移除后保存生效', await evaluate(`!document.querySelector('.profile-head .avatar img')`));

check('无运行时错误', errors.length === 0, errors.join(' | '));

ws.close();
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} 项头像上传检查通过`);
process.exit(passed === results.length ? 0 : 1);
