/* 入口选择层：静态托管版首次打开时，说明默认使用云端账号（三端通用），
 * 同时保留「本地离线体验」入口（数据只保存在当前浏览器）。
 *
 * 显示条件：
 *  · 处于静态托管（同源 /api 不可用）
 *  · 本次会话没有因为「先随便看看」跳过
 *  · 用户没有做过选择（云端 / 本地离线 都记录在 localStorage）
 * 完整版（有真实后端）不显示——那里本来就是完整体验。
 */
import { state, toast } from './core.js';

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
  // 用户已经表达过选择（无论去完整版还是留本地版）就不再打扰
  if (localStorage.getItem(CHOICE_KEY)) return;
  if (sessionStorage.getItem(SEEN_KEY) === '1') return;
  if (document.getElementById('entry-gate')) return;

  const hasArchive = hasLocalArchive();
  const localLabel = hasArchive ? '继续我的本地档案（推荐）' : '本地离线体验';
  const gate = document.createElement('div');
  gate.id = 'entry-gate';
  gate.className = 'entry-gate';
  gate.innerHTML = `
    <div class="entry-gate-panel">
      <div class="entry-gate-eyebrow">WELCOME · CHOOSE YOUR WAY</div>
      <h1 class="entry-gate-title">Copy<span class="title-outline">Archive</span></h1>
      <p class="entry-gate-sub">${hasArchive
        ? '检测到这台浏览器里已有你的本地档案和文案。默认进入本地模式，你之前的账号密码可以直接登录、文案都在。想要电脑手机通用，可切换到云端账号。'
        : '现在默认使用云端账号：电脑、平板、手机登录同一个账号就能看到同一份档案。只有主动选择离线体验时，数据才只留在这台设备。'}</p>
      <div class="entry-gate-options">
        ${hasArchive ? `
        <button class="entry-gate-card entry-gate-card-local" id="gate-local">
          <span class="entry-gate-badge">LOCAL · 推荐</span>
          <span class="entry-gate-name">${localLabel}</span>
          <span class="entry-gate-desc">你之前的账号和文案都在这里 · 无需重新注册</span>
          <span class="entry-gate-go">进入本地档案 →</span>
        </button>
        <button class="entry-gate-card" id="gate-cloud">
          <span class="entry-gate-badge">CLOUD</span>
          <span class="entry-gate-name">云端档案</span>
          <span class="entry-gate-desc">与完整版共用账号 · 三端通用 · 需要另用云端账号登录</span>
          <span class="entry-gate-go">切到云端 →</span>
        </button>` : `
        <button class="entry-gate-card" id="gate-cloud">
          <span class="entry-gate-badge">CLOUD</span>
          <span class="entry-gate-name">云端档案（推荐）</span>
          <span class="entry-gate-desc">与完整版共用账号 · 三端通用 · 档案可分享给任何人</span>
          <span class="entry-gate-go">留在这里 →</span>
        </button>
        <button class="entry-gate-card entry-gate-card-local" id="gate-local">
          <span class="entry-gate-badge">LOCAL</span>
          <span class="entry-gate-name">${localLabel}</span>
          <span class="entry-gate-desc">无需注册 · 数据只保存在当前浏览器 · 换设备看不到</span>
          <span class="entry-gate-go">离线体验 →</span>
        </button>`}
      </div>
      <button class="entry-gate-skip" id="gate-skip">先随便看看</button>
    </div>`;

  gate.querySelector('#gate-cloud').addEventListener('click', () => {
    localStorage.setItem(CHOICE_KEY, 'cloud');
    close(gate);
    toast('已进入云端档案 · 账号三端通用');
  });
  gate.querySelector('#gate-local').addEventListener('click', () => {
    // 离线只在当前会话有效，避免旧版那样永久把设备锁在与云端隔离的本地账号里
    sessionStorage.setItem('ca_offline_session', '1');
    sessionStorage.setItem(SEEN_KEY, '1');
    localStorage.removeItem(CHOICE_KEY);
    // 重新加载让会话模式切换为本地离线档案
    location.reload();
  });
  gate.querySelector('#gate-skip').addEventListener('click', () => {
    sessionStorage.setItem(SEEN_KEY, '1');
    close(gate);
  });

  document.body.appendChild(gate);
}
