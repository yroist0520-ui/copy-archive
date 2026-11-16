/* 真实浏览器 UI 冒烟测试：通过 CDP 驱动无头 Chromium，验证主要页面与交互。 */
const CDP = 'http://127.0.0.1:9222';
const BASE = process.env.CA_BASE || 'http://127.0.0.1:8765';
const SHARE = process.env.CA_SHARE || '';
const withShare = (path) => BASE + path + (SHARE ? (path.includes('?') ? '&' : '?') + 'sharecode=' + SHARE : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push([name, !!ok]);
  console.log(`${ok ? '  PASS  ' : '  FAIL  '}${name}${!ok && detail ? ' — ' + detail : ''}`);
}

const targets = await fetch(`${CDP}/json`).then((r) => r.json());
const target = targets.find((t) => t.type === 'page');
if (!target) throw new Error('没有可用的浏览器页面');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    // 带上来源文件与行号，否则像 "Unexpected token '*'" 这类错误无法定位
    const d = msg.params.exceptionDetails;
    const where = d.url ? ` @ ${d.url}:${(d.lineNumber ?? 0) + 1}` : '';
    consoleErrors.push(`${d.exception?.description || d.text}${where}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
  }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}
/** 轮询等待某个表达式为真，返回是否等到 */
async function waitFor(expression, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    let value = false;
    try { value = await evaluate(expression); } catch { value = false; }
    if (value) return true;
    await sleep(200);
  }
  return false;
}

async function go(path) {
  await send('Page.navigate', { url: withShare(path) });
  // 等待应用完成首屏渲染：模块加载（含远端字体）可能较慢，固定等待易误判
  for (let i = 0; i < 50; i += 1) {
    await sleep(150);
    const ready = await evaluate(`document.readyState === 'complete' && !!document.querySelector('#app > *')`);
    if (ready) break;
  }
  await sleep(350);
}
await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.clearBrowserCookies');
await send('Runtime.evaluate', { expression: 'localStorage.clear(); sessionStorage.clear();' });

// 1. 首页
await go('/');
check('首页渲染 Hero', await evaluate(`!!document.querySelector('.hero-title')`));
check('首页渲染搜索区', await evaluate(`!!document.querySelector('#home-q')`));
check('首页渲染分类网格', await evaluate(`document.querySelectorAll('.category-tile').length >= 10`));
check('首页渲染推荐/热门区块', await evaluate(`document.querySelectorAll('.section').length >= 5`));
if (process.env.CA_EXPECT_LOCAL === '1') {
  check('静态托管时页脚显示本地模式说明', await evaluate(`!!document.querySelector('.mode-foot')`));
  check('顶部不再出现本地模式横幅', await evaluate(`!document.querySelector('#mode-badge')`));
  check('本地模式数据确实落在浏览器', await evaluate(`!!localStorage.getItem('ca_local_db_v1')`));
}

// 2. 注册
const stamp = String(Date.now()).slice(-6);
const user = 'ui' + stamp;
await evaluate(`document.querySelector('#auth-btn').click()`);
await sleep(300);
await evaluate(`document.querySelector('.auth-switch').click()`);
await sleep(200);
await evaluate(`document.querySelector('#auth-account').value=${JSON.stringify(user)}`);
await evaluate(`document.querySelector('#auth-email').value=${JSON.stringify(user + '@ui.test')}`);
await evaluate(`document.querySelector('#auth-pass').value='secret123'`);
await evaluate(`document.querySelector('#auth-name').value='UI 测试档案'`);
await evaluate(`document.querySelector('[data-submit]').click()`);
await sleep(900);
await waitFor(`document.querySelector('#auth-btn').textContent.includes('UI 测试')`);
check('注册后进入登录态', (await evaluate(`document.querySelector('#auth-btn').textContent`)).includes('UI 测试'), await evaluate(`document.querySelector('#auth-btn').textContent`));

// 3. 上传
await evaluate(`document.querySelector('a[href="/upload"]').click()`);
await sleep(700);
await waitFor(`!!document.querySelector('#s-content')`);
check('上传页渲染', await evaluate(`!!document.querySelector('#s-content')`));
const special = 'Stay  strange. 「✦」 你好，世界！\n第二行\n' + '这是一段用于验证长文案折叠与展开能力的测试文本。'.repeat(14);
await evaluate(`document.querySelector('#s-content').value=${JSON.stringify(special)}`);
await evaluate(`document.querySelector('#s-content').dispatchEvent(new Event('input'))`);
await evaluate(`document.querySelectorAll('#s-cats .chip')[1].click()`);
await evaluate(`document.querySelectorAll('#s-cats .chip')[14].click()`);
await evaluate(`document.querySelector('#s-save').click()`);
await sleep(700);
await waitFor(`document.body.textContent.includes('已收录')`);
check('单条上传反馈', await evaluate(`document.body.textContent.includes('已收录')`));
check('文案正文原文保留', await evaluate(`document.querySelector('#s-content').value === ''`));

// 4. 批量导入
await evaluate(`document.querySelector('[data-tab="batch"]').click()`);
await sleep(200);
await evaluate(`document.querySelector('#b-text').value='Line one.\\nLine  two.\\n第三行 ✦'`);
await evaluate(`document.querySelector('#b-text').dispatchEvent(new Event('input'))`);
await evaluate(`document.querySelector('#b-preview').click()`);
await sleep(600);
await waitFor(`document.querySelectorAll('.preview-row').length === 3`);
check('批量导入预览生成', await evaluate(`document.querySelectorAll('.preview-row').length === 3`));
await evaluate(`document.querySelector('#b-save').click()`);
await sleep(700);
await waitFor(`document.body.textContent.includes('成功收录 3 条')`);
check('批量导入保存', await evaluate(`document.body.textContent.includes('成功收录 3 条')`));

// 5. 文案库
await go('/archive');
await waitFor(`document.querySelectorAll('.copy-card').length >= 1`);
check('文案库显示 4 条', await evaluate(`document.querySelectorAll('.copy-card').length === 4`), String(await evaluate(`document.querySelectorAll('.copy-card').length`)));
await waitFor(`document.querySelectorAll('.card-cats .chip').length >= 2`);
check('卡片显示分类标签', await evaluate(`document.querySelectorAll('.card-cats .chip').length >= 2`));
await waitFor(`!!document.querySelector('[data-expand]')`);
check('长文案折叠按钮存在', await evaluate(`!!document.querySelector('[data-expand]')`));
await evaluate(`(() => { const i=document.querySelector('#archive-search'); i.value='strange'; i.dispatchEvent(new Event('input')); })()`);
await sleep(700);
await waitFor(`document.querySelectorAll('.copy-card').length === 1`);
check('搜索命中 1 条', await evaluate(`document.querySelectorAll('.copy-card').length === 1`), String(await evaluate(`document.querySelectorAll('.copy-card').length`)));
await waitFor(`!!document.querySelector('mark.hit')`);
check('关键词高亮', await evaluate(`!!document.querySelector('mark.hit')`));
await evaluate(`document.querySelector('#archive-clear').click()`);
await sleep(600);
await evaluate(`document.querySelector('[data-select]').click()`);
await sleep(200);
await waitFor(`!document.querySelector('#batch-bar').classList.contains('hidden')`);
check('批量工具栏出现', await evaluate(`!document.querySelector('#batch-bar').classList.contains('hidden')`));
await evaluate(`document.querySelector('[data-batch="copy"]').click()`);
await sleep(300);
await waitFor(`!!document.querySelector('#with-number')`);
check('批量复制弹层', await evaluate(`!!document.querySelector('#with-number')`));
await evaluate(`document.querySelector('.modal-close').click()`);

// 6. 分类管理
await go('/categories');
await waitFor(`document.querySelectorAll('.manage-row[data-id]').length >= 30`);
check('分类管理显示 30+ 行', await evaluate(`document.querySelectorAll('.manage-row[data-id]').length >= 30`));
await evaluate(`document.querySelector('#cat-new').value='UI 新建分类'`);
await evaluate(`document.querySelector('#cat-create').click()`);
await sleep(500);
check('新建分类生效', await evaluate(`document.body.textContent.includes('UI 新建分类')`));

// 7. 档案与分享
await go('/profile');
await waitFor(`!!document.querySelector('#p-share')`);
check('个人档案渲染', await evaluate(`!!document.querySelector('#p-share')`));
check('分享链接包含用户名', await evaluate(`document.querySelector('#p-share').value.includes(${JSON.stringify(user)})`));
await evaluate(`document.querySelector('input[name="privacy"][value="partial"]').click()`);
await evaluate(`document.querySelector('#p-save-privacy').click()`);
await sleep(600);
await waitFor(`document.body.textContent.includes('隐私设置已保存')`);
check('隐私设置保存', await evaluate(`document.body.textContent.includes('隐私设置已保存')`));

await go('/u/' + user);
await waitFor(`!!document.querySelector('.profile-name')`);
check('公开档案可访问', await evaluate(`!!document.querySelector('.profile-name')`));
check('访客搜索框存在', await evaluate(`!!document.querySelector('#pub-q')`));
await waitFor(`document.querySelectorAll('[data-action="copy"]').length > 0`);
check('公开文案可复制', await evaluate(`document.querySelectorAll('[data-action="copy"]').length > 0`));

// 8. 控制台错误
check('无浏览器运行时错误', consoleErrors.length === 0, consoleErrors.join(' | '));

ws.close();
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} 项 UI 检查通过`);
process.exit(passed === results.length ? 0 : 1);
