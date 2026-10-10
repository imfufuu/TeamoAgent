import { $, el, esc } from './ui-markdown.js?v=2026.10.10.1';
// ── Toast（底部最多堆叠 3 条，超出自动隐藏并移除最旧消息）──────────────────
export const MAX_TOAST_STACK = 3;
export function toast(msg, type = 'info', ms = 2600) {
  const wrap = $('#toasts');
  if (!wrap) return;
  const active = [...wrap.querySelectorAll('.toast:not(.leaving)')];
  while (active.length >= MAX_TOAST_STACK) {
    const oldest = active.shift();
    if (oldest) {
      oldest.classList.remove('in');
      oldest.classList.add('leaving');
      setTimeout(() => oldest.remove(), 220);
    }
  }
  const t = el('div', `toast ${type}`, `<span>${esc(msg)}</span>`);
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  const dismiss = () => { if (!t.isConnected) return; t.classList.remove('in'); t.classList.add('leaving'); setTimeout(() => t.remove(), 350); };
  setTimeout(dismiss, ms);
  t.dismiss = dismiss; // 调用方可提前收掉（例如「正在处理视频…」在处理完成时）
  return t;
}

export function fmtClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s}s`;
}
export function fmtAgo(ts) {
  const sec = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
  if (sec < 45) return 'just now';
  if (sec < 90) return '1 minute ago';
  if (sec < 3600) {
    const n = Math.round(sec / 60);
    return n === 1 ? '1 minute ago' : `${n} minutes ago`;
  }
  if (sec < 5400) return '1 hour ago';
  if (sec < 86400) {
    const n = Math.round(sec / 3600);
    return n === 1 ? '1 hour ago' : `${n} hours ago`;
  }
  const d = Math.round(sec / 86400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

