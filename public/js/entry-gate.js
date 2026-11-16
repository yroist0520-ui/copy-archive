/* 入口选择层：静态托管版首次打开时，引导用户选择去完整版（真实多人后端）
 * 还是留在本地版（数据只保存在当前浏览器）。
 *
 * 显示条件：
 *  · 处于本地模式（/api 不可用，说明是纯静态托管）
 *  · 本次会话没有因为「先随便看看」跳过
 *  · 用户没有明确选择过「建立自己的档案」（记在 localStorage，永久生效）
 * 完整版（有真实后端）不显示——那里本来就是完整体验。
 */
import { state, FULL_VERSION_URL, toast } from './core.js';

const CHOICE_KEY = 'ca_entry_choice';
const SEEN_KEY = 'ca_gate_seen';

function hasLocalArchive() {
  try {
    const db = JSON.parse(localStorage.getItem('ca_local_db_v1') || 'null');
    return !!(db && Array.isArray(db.copies) && db.copies.length);
  } catch {
    return false;
  }
}

function close(gate) {
  gate.remove();
}

export function maybeShowEntryGate() {
  if (!state.localMode) return;
  if (localStorage.getItem(CHOICE_KEY) === 'local') return;
  if (sessionStorage.getItem(SEEN_KEY) === '1') return;
  if (document.getElementById('entry-gate')) return;

  const localLabel = hasLocalArchive() ? '继续我的本地档案' : '建立自己的档案';
  const gate = document.createElement('div');
  gate.id = 'entry-gate';
  gate.className = 'entry-gate';
  gate.innerHTML = `
    <div class="entry-gate-panel">
      <div class="entry-gate-eyebrow">WELCOME · CHOOSE YOUR WAY</div>
      <h1 class="entry-gate-title">Copy<span class="title-outline">Archive</span></h1>
      <p class="entry-gate-sub">这里有两个版本。完整版的文案存在云端、可以分享给任何人；本地版不用注册，但数据只保存在这台设备的浏览器里。</p>
      <div class="entry-gate-options">
        <button class="entry-gate-card" id="gate-full">
          <span class="entry-gate-badge">FULL</span>
          <span class="entry-gate-name">去公开档案</span>
          <span class="entry-gate-desc">真实多人共享 · 云端保存 · 档案可分享给任何人打开浏览</span>
          <span class="entry-gate-go">前往完整版 ↗</span>
        </button>
        <button class="entry-gate-card entry-gate-card-local" id="gate-local">
          <span class="entry-gate-badge">LOCAL</span>
          <span class="entry-gate-name">${localLabel}</span>
          <span class="entry-gate-desc">无需注册 · 就地体验全部功能 · 分享链接无法让别人看到文案</span>
          <span class="entry-gate-go">留在这里 →</span>
        </button>
      </div>
      <button class="entry-gate-skip" id="gate-skip">先随便看看</button>
    </div>`;

  gate.querySelector('#gate-full').addEventListener('click', () => {
    localStorage.setItem(CHOICE_KEY, 'full');
    location.href = FULL_VERSION_URL;
  });
  gate.querySelector('#gate-local').addEventListener('click', () => {
    localStorage.setItem(CHOICE_KEY, 'local');
    close(gate);
    toast('已进入本地版 · 文案数据保存在当前浏览器');
  });
  gate.querySelector('#gate-skip').addEventListener('click', () => {
    sessionStorage.setItem(SEEN_KEY, '1');
    close(gate);
  });

  document.body.appendChild(gate);
}
