// 设置弹窗：API Key / 中继地址 / 主题 / 字号 / 沙箱 / 联网 / 快速 / 思考 / 清空数据 / 关于
import { APP_RELEASE, APP_VERSION, STORAGE_KEY } from './config.js?v=2026.10.5.16';
import { currentRelay, resetRelayProbe, RELAY_OVERRIDE_KEY } from './net.js';
import { readLocal, writeLocal, removeLocal } from './legacy-keys.js';

const FONT_SIZE_KEY = 'dubhe-fontsize';
import { writeThemePreference } from './theme.js';

const $ = (sel) => document.querySelector(sel);

const ADMIN_PREFIX = 'admin-';
const isAdmin = (s) => String(s || '').startsWith(ADMIN_PREFIX);
function validateApiKey(s) {
  const v = String(s || '').trim();
  if (!v) return { ok: true };
  if (isAdmin(v)) return { ok: true };
  if (!/^sk-teamo-[A-Za-z0-9_-]+$/.test(v)) return { ok: false, reason: 'Key 应以 sk-teamo- 开头，只能包含字母/数字/_/-' };
  if (v.length < 25) return { ok: false, reason: 'Key 长度过短，请检查是否复制完整' };
  if (v.length > 200) return { ok: false, reason: 'Key 过长，请检查是否粘贴了多余字符' };
  return { ok: true };
}
function toast(msg, type = 'info', ms = 2600) {
  try {
    import('./ui.js').then(({ toast: t }) => t && t(msg, type, ms)).catch(() => {
      const wrap = document.getElementById('toasts');
      if (!wrap) return;
      const d = document.createElement('div');
      d.className = `toast ${type} in`;
      d.textContent = msg;
      wrap.appendChild(d);
      setTimeout(() => { d.classList.remove('in'); d.classList.add('leaving'); setTimeout(() => d.remove(), 400); }, ms);
    });
  } catch {}
}

function syncSeg(sel, v) {
  const host = document.querySelector(sel);
  if (!host) return;
  host.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
}

async function relayCheck() {
  try {
    const override = readLocal(RELAY_OVERRIDE_KEY) || '';
    resetRelayProbe();
    const { relayAvailable } = await import('./net.js');
    const ok = await relayAvailable();
    const after = currentRelay();
    if (ok && after) {
      return after.label === 'origin' ? '同源中继可用（本地 server.py / Pages Functions）' : `已连接：${after.base}`;
    }
    return override ? `自定义地址不可用：${override}` : '未检测到中继（网页抓取工具将被禁用）';
  } catch (e) { return '探测失败：' + (e.message || e); }
}

export function openSettingsModal({ store } = {}) {
  const m = $('#settings-modal');
  if (!m) return;
  $('#set-key').value = store.state.apiKey || '';
  $('#set-relay').value = readLocal(RELAY_OVERRIDE_KEY) || '';
  syncSeg('#set-theme', store.state.settings.theme || 'light');
  syncSeg('#set-fontsize', document.documentElement.dataset.fontsize || 'medium');
  $('#set-sandbox').checked = store.state.settings.sandboxEnabled !== false;
  if ($('#set-cpp')) $('#set-cpp').checked = store.state.settings.remoteCppEnabled !== false;
  $('#set-web').checked = store.state.settings.webEnabled !== false;
  $('#set-fast').checked = !!store.state.settings.fastMode;
  $('#set-thinking').checked = store.state.settings.thinking !== false;
  syncSeg('#set-reason', store.state.settings.reasoningLevel || 'medium');
  $('#set-about-ver').textContent = APP_RELEASE;
  $('#set-about-build').textContent = APP_VERSION;
  const rel = currentRelay();
  $('#set-about-relay').textContent = rel ? (rel.label === 'origin' ? '同源 /api' : rel.base) : '未连接';
  try {
    let raw = '';
    for (const key of [`${STORAGE_KEY}-v2`, STORAGE_KEY]) {
      const value = localStorage.getItem(key);
      if (value) { raw = value; break; }
    }
    let saved = {};
    try { saved = raw ? JSON.parse(raw) : {}; } catch { saved = {}; }
    const sessions = Array.isArray(store.state.sessions)
      ? store.state.sessions
      : (Array.isArray(saved.sessions) ? saved.sessions : []);
    let bytes = raw.length;
    try { bytes = new TextEncoder().encode(raw).byteLength; } catch { /* 旧浏览器按字符长度估算 */ }
    const size = Math.round(bytes / 1024);
    $('#set-about-store').textContent = `${sessions.length} 个会话 · ~${size}KB`;
  } catch { $('#set-about-store').textContent = '—'; }
  m.classList.add('open');
  setTimeout(() => $('#set-key').focus(), 100);
  relayCheck().then((msg) => { const el = $('#set-relay-msg'); if (el) el.textContent = msg; });
}

export function closeSettingsModal() {
  const m = $('#settings-modal');
  if (m) m.classList.remove('open');
}

function bindSeg(sel, onChange) {
  const host = document.querySelector(sel);
  if (!host) return;
  host.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    host.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    onChange && onChange(b.dataset.v);
  });
}

export function mountSettings(store, { onRelayChanged, onKeySaved } = {}) {
  const btn = $('#settings-btn');
  if (btn) btn.addEventListener('click', () => openSettingsModal({ store }));
  $('#settings-close').addEventListener('click', closeSettingsModal);
  $('#settings-done').addEventListener('click', closeSettingsModal);
  const m = $('#settings-modal');
  m.addEventListener('click', (e) => { if (e.target === m) closeSettingsModal(); });
  document.addEventListener('keydown', (e) => {
    if (!m.classList.contains('open')) return;
    if (e.key === 'Escape') closeSettingsModal();
  });

  function saveKey() {
    const v = $('#set-key').value.trim();
    const chk = validateApiKey(v);
    if (!chk.ok) { toast('Key 格式错误：' + chk.reason, 'err', 5000); $('#set-key').focus(); $('#set-key').select(); return false; }
    store.state.apiKey = v;
    store.notify();
    onKeySaved && onKeySaved();
    return true;
  }
  $('#set-key').addEventListener('change', saveKey);
  $('#set-key').addEventListener('blur', saveKey);
  $('#set-relay').addEventListener('change', async () => {
    const v = $('#set-relay').value.trim();
    if (v) writeLocal(RELAY_OVERRIDE_KEY, v); else removeLocal(RELAY_OVERRIDE_KEY);
    const msg = await relayCheck();
    const el = $('#set-relay-msg'); if (el) el.textContent = msg;
    onRelayChanged && onRelayChanged();
  });
  $('#set-relay').addEventListener('blur', () => $('#set-relay').dispatchEvent(new Event('change')));

  bindSeg('#set-theme', (v) => {
    store.state.settings.theme = v;
    document.documentElement.dataset.theme = v;
    writeThemePreference(v);
    store.notify();
  });
  bindSeg('#set-fontsize', (v) => applyFontSizeValue(v));

  const bindSw = (id, key, onChange) => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', () => {
      store.state.settings[key] = el.checked;
      store.notify();
      onChange && onChange(el.checked);
    });
  };
  bindSw('#set-sandbox', 'sandboxEnabled');
  if ($('#set-cpp')) bindSw('#set-cpp', 'remoteCppEnabled');
  bindSw('#set-web', 'webEnabled');
  bindSw('#set-fast', 'fastMode');
  const reasonRow = document.getElementById('set-reason-row');
  const syncReasonRow = () => { if (reasonRow) reasonRow.hidden = !$('#set-thinking').checked; };
  bindSw('#set-thinking', 'thinking', syncReasonRow);
  syncReasonRow();

  bindSeg('#set-reason', (v) => {
    store.state.settings.reasoningLevel = v;
    store.notify();
  });

  $('#set-clear-chat').addEventListener('click', () => {
    if (!confirm('确认清空当前会话的所有消息与文件？此操作不可撤销。')) return;
    store.state.messages = [];
    store.state.files = {};
    store.notify();
    closeSettingsModal();
  });
  $('#set-clear-all').addEventListener('click', () => {
    if (!confirm('确认清空所有会话、文件、API Key、设置？此操作不可撤销。')) return;
    try { localStorage.clear(); } catch {}
    location.reload();
  });
}

export function applyFontSizeValue(value, { persist = true } = {}) {
  const v = ['small', 'medium', 'large'].includes(String(value)) ? String(value) : 'medium';
  document.documentElement.dataset.fontsize = v;
  if (persist) {
    writeLocal(FONT_SIZE_KEY, v);
  }
  return v;
}

export function applyFontSize() {
  let v = 'medium';
  v = readLocal(FONT_SIZE_KEY) || 'medium';
  return applyFontSizeValue(v, { persist: false });
}
