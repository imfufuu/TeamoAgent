// 设置弹窗：API Key / 中继地址 / 主题 / 字号 / 沙箱 / 联网 / 快速 / 思考 / 识图·视频识别模型 / 清空数据 / 关于
import { APP_RELEASE, APP_VERSION, STORAGE_KEY, VISION_MODELS, VIDEO_MODELS, resolveVisionModel, resolveVideoModel } from './config.js?v=2026.10.5.21';
import { currentRelay, resetRelayProbe, RELAY_OVERRIDE_KEY } from './net.js';
import { DEFAULT_TURN_BUDGET } from './execution.js';
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

function fillModelSelect(el, list, current) {
  if (!el) return;
  if (el.options.length !== list.length) {
    el.innerHTML = '';
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.label} · ${m.tag}`;
      opt.title = `${m.id} · ${m.note}`;
      el.appendChild(opt);
    }
  }
  el.value = current;
}

function syncMultimodalSelects(store) {
  const settings = (store && store.state && store.state.settings) || {};
  const vision = resolveVisionModel(settings.visionModel);
  const video = resolveVideoModel(settings.videoModel);
  fillModelSelect($('#set-vision-model'), VISION_MODELS, vision);
  fillModelSelect($('#set-video-model'), VIDEO_MODELS, video);
  const note = $('#set-mm-note');
  if (note) {
    const vi = VISION_MODELS.find((m) => m.id === vision) || {};
    const vd = VIDEO_MODELS.find((m) => m.id === video) || {};
    note.textContent = `识图 ${vision}：${vi.note || ''}｜视频 ${video}：${vd.note || ''}。按实际 token 计费，换模型立即生效。`;
  }
}

function syncBudgetInputs(store) {
  const eb = (store.state.settings && store.state.settings.executionBudget) || {};
  const ext = Number.isFinite(Number(eb.maxExternalSideEffects)) ? Number(eb.maxExternalSideEffects) : DEFAULT_TURN_BUDGET.maxExternalSideEffects;
  const tc = Number.isFinite(Number(eb.maxToolCalls)) ? Number(eb.maxToolCalls) : DEFAULT_TURN_BUDGET.maxToolCalls;
  if ($('#set-budget-ext')) $('#set-budget-ext').value = String(ext);
  if ($('#set-budget-tools')) $('#set-budget-tools').value = String(tc);
  const note = $('#set-budget-note');
  if (note) {
    const custom = ext !== DEFAULT_TURN_BUDGET.maxExternalSideEffects || tc !== DEFAULT_TURN_BUDGET.maxToolCalls;
    note.textContent = custom
      ? `当前为自定义值（默认：外部副作用 ${DEFAULT_TURN_BUDGET.maxExternalSideEffects} · 工具调用 ${DEFAULT_TURN_BUDGET.maxToolCalls}）。模型每轮都能看到余额，剩余 ≤ 2 时会收到预警`
      : `默认值。模型每轮都能看到余额与预警；撞上上限时工具结果里会给出这条设置的入口`;
  }
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
  syncBudgetInputs(store);
  syncMultimodalSelects(store);
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

  // 执行预算（P1 修正：预算拦截要有用户可操作的恢复路径）：两路最常撞墙的通道可调，其余沿用内核默认
  const bindBudget = (id, key, min, max) => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', () => {
      const def = DEFAULT_TURN_BUDGET[key];
      let n = Math.round(Number(el.value));
      if (!Number.isFinite(n)) n = def;
      n = Math.max(min, Math.min(max, n));
      const cur = { ...(store.state.settings.executionBudget || {}) };
      if (n === def) delete cur[key]; else cur[key] = n;
      store.state.settings.executionBudget = Object.keys(cur).length ? cur : undefined;
      store.notify();
      syncBudgetInputs(store);
      toast(n === def ? `${key === 'maxExternalSideEffects' ? '外部副作用' : '工具调用'}上限已恢复默认 ${def}（下一轮生效）` : `${key === 'maxExternalSideEffects' ? '外部副作用' : '工具调用'}上限已设为 ${n}（下一轮生效）`, 'ok', 2600);
    });
  };
  bindBudget('#set-budget-ext', 'maxExternalSideEffects', 1, 60);
  bindBudget('#set-budget-tools', 'maxToolCalls', 4, 128);
  const budgetReset = $('#set-budget-reset');
  if (budgetReset) budgetReset.addEventListener('click', () => {
    store.state.settings.executionBudget = undefined;
    store.notify();
    syncBudgetInputs(store);
    toast(`执行预算已恢复默认（外部副作用 ${DEFAULT_TURN_BUDGET.maxExternalSideEffects} · 工具调用 ${DEFAULT_TURN_BUDGET.maxToolCalls}）`, 'ok', 2600);
  });

  bindSeg('#set-reason', (v) => {
    store.state.settings.reasoningLevel = v;
    store.notify();
  });

  // 识图 / 视频识别模型：全局设置（不随会话），analyze_image / analyze_pdf / analyze_video 读取
  const bindModelSelect = (id, key, resolve) => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', () => {
      store.state.settings[key] = resolve(el.value);
      store.notify();
      syncMultimodalSelects(store);
    });
  };
  bindModelSelect('#set-vision-model', 'visionModel', resolveVisionModel);
  bindModelSelect('#set-video-model', 'videoModel', resolveVideoModel);

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
