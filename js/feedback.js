/* 触感反馈与音效：全站统一的轻反馈。
 * 音效由 Web Audio 实时合成（不加载外部文件，避免缓存/跨域问题）；
 * 触感用 navigator.vibrate（安卓等支持的设备生效，iOS Safari 不支持时静默降级）。
 * 用户可在页头按钮关闭，选择会持久化。
 */

const ENABLE_KEY = 'ca_feedback_enabled';
let enabled = true;
let ctx = null;
let lastTap = 0;

try { enabled = localStorage.getItem(ENABLE_KEY) !== 'off'; } catch { /* ignore */ }

export function feedbackEnabled() {
  return enabled;
}

export function setFeedbackEnabled(on) {
  enabled = !!on;
  try { localStorage.setItem(ENABLE_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
  if (on) { // 开启时预热一次，借随后可能的用户手势解锁音频
    try { audioContext(); } catch { /* ignore */ }
  }
}

/** 惰性创建 AudioContext；首次需用户手势，suspended 时尝试 resume */
function audioContext() {
  if (!enabled) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    try { ctx = new AC(); } catch { return null; }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** 单个柔和音符：正弦波 + 指数衰减包络，避免刺耳 */
function tone({ freq = 560, dur = 0.08, gain = 0.035, slide = 0, delay = 0, type = 'sine' }) {
  const ac = audioContext();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(amp);
  amp.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

const SOUNDS = {
  // 轻点：纸张般的短促轻响
  tap: () => tone({ freq: 520, dur: 0.055, gain: 0.028 }),
  // 成功：柔和上扬双音
  ok: () => {
    tone({ freq: 620, dur: 0.1, gain: 0.04 });
    tone({ freq: 930, dur: 0.14, gain: 0.028, delay: 0.055 });
  },
  // 失败：低沉短音
  error: () => tone({ freq: 250, dur: 0.17, gain: 0.045, slide: -90 }),
  // 盲盒揭晓：三音琶音，带一点仪式感
  reveal: () => {
    tone({ freq: 523, dur: 0.12, gain: 0.035 });
    tone({ freq: 659, dur: 0.13, gain: 0.032, delay: 0.075 });
    tone({ freq: 784, dur: 0.2, gain: 0.03, delay: 0.15 });
  },
};

export function sound(kind = 'tap') {
  if (!enabled) return;
  const fn = SOUNDS[kind] || SOUNDS.tap;
  try { fn(); } catch { /* ignore */ }
}

const HAPTICS = {
  tap: 8,
  ok: [10, 26, 14],
  error: [22, 38, 18],
  reveal: [12, 40, 20, 40, 28],
};

export function haptic(kind = 'tap') {
  if (!enabled) return;
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav || typeof nav.vibrate !== 'function') return; // iOS 等不支持时静默降级
  try { nav.vibrate(HAPTICS[kind] || 8); } catch { /* ignore */ }
}

/** 音效 + 触感一起触发 */
export function feedback(kind = 'tap') {
  sound(kind);
  haptic(kind);
}

/** 全局按钮轻反馈，带节流避免连点过吵 */
export function tapFeedback() {
  const now = Date.now();
  if (now - lastTap < 55) return;
  lastTap = now;
  feedback('tap');
}

/** 初始化：全局点击委托 + 页头音效开关 */
export function initFeedback() {
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest
      ? e.target.closest('button, .btn, .icon-btn, .action-btn, .nav-link, a[data-link], .chip, .entry-gate-card, .card-expand, [data-action]')
      : null;
    if (el) tapFeedback();
  }, true);

  const btn = document.getElementById('sound-toggle');
  if (btn) {
    const sync = () => {
      btn.classList.toggle('muted', !enabled);
      btn.setAttribute('aria-pressed', String(enabled));
      btn.title = enabled ? '关闭音效与触感' : '开启音效与触感';
      btn.setAttribute('aria-label', btn.title);
    };
    sync();
    btn.addEventListener('click', () => {
      setFeedbackEnabled(!enabled);
      sync();
      if (enabled) feedback('ok');
    });
  }
}
