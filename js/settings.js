// 设置弹窗：API Key / 中继地址 / 主题 / 字号 / 沙箱 / 联网 / 快速 / 思考 / 识图·视频识别模型 / 清空数据 / 关于
import { APP_RELEASE, APP_VERSION, STORAGE_KEY, VISION_MODELS, VIDEO_MODELS, resolveVisionModel, resolveVideoModel } from './config.js?v=2026.10.5.32';
import { currentRelay, resetRelayProbe, RELAY_OVERRIDE_KEY } from './net.js';
import { DEFAULT_TURN_BUDGET } from './execution.js';
import { NEXUS_ARCHITECTURE_SPEC } from './nexus.js';
import { readLocal, writeLocal, removeLocal } from './legacy-keys.js';

const FONT_SIZE_KEY = 'dubhe-fontsize';
const MOTION_KEY = 'dubhe-motion'; // 'auto' | 'on' | 'off'：auto = 跟随系统 prefers-reduced-motion
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
  syncSeg('#set-motion', readMotionPreference());
  paintMotionNote();
  $('#set-sandbox').checked = store.state.settings.sandboxEnabled !== false;
  if ($('#set-cpp')) $('#set-cpp').checked = store.state.settings.remoteCppEnabled !== false;
  $('#set-web').checked = store.state.settings.webEnabled !== false;
  $('#set-fast').checked = !!store.state.settings.fastMode;
  if ($('#set-image-review')) $('#set-image-review').checked = store.state.settings.imageRemoteReview !== false;
  $('#set-thinking').checked = store.state.settings.thinking !== false;
  syncSeg('#set-reason', store.state.settings.reasoningLevel || 'medium');
  syncBudgetInputs(store);
  syncMultimodalSelects(store);
  $('#set-about-ver').textContent = APP_RELEASE;
  $('#set-about-build').textContent = APP_VERSION;
  if ($('#set-about-arch')) $('#set-about-arch').textContent = `${NEXUS_ARCHITECTURE_SPEC.name.split('（')[0]} · ${NEXUS_ARCHITECTURE_SPEC.codename.short}（${NEXUS_ARCHITECTURE_SPEC.codename.zh}）`;
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
  loadBuildInfo().then((info) => paintBuildInfo($('#set-about-commit'), info, APP_VERSION));
}

// ── 部署提交（P7 供应链可验证性）：读同源 build.json（Pages 部署时由 tools/build-manifest.mjs 生成）──
// 显示 commit 短 sha + 文件数 + 清单摘要；若清单里的版本号与当前运行的 APP_VERSION 不一致，说明浏览器缓存
// 与线上部署不是同一份（或有人改了文件却没走 Pages 流程），要明说。本地 file:// / 开发服务器没有 build.json 时显示「非 Pages 部署」。
let buildInfoCache = null;
export async function loadBuildInfo({ fetchImpl = (typeof fetch === 'function' ? fetch : null), url = 'build.json' } = {}) {
  if (buildInfoCache) return buildInfoCache;
  if (!fetchImpl) return { ok: false, reason: 'no-fetch' };
  try {
    const res = await fetchImpl(`${url}?x=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const j = await res.json();
    if (!j || j.schema !== 'dubhe-build-manifest/1' || !j.commit) return { ok: false, reason: 'bad-schema' };
    buildInfoCache = { ok: true, commit: String(j.commit), version: String(j.version || ''), fileCount: Number(j.file_count) || 0, manifestSha: String(j.manifest_sha256 || ''), builtAt: String(j.built_at || ''), repository: String(j.repository || 'imfufuu/dubhe-agent') };
    return buildInfoCache;
  } catch { return { ok: false, reason: 'network' }; }
}
export function formatBuildInfo(info, appVersion) {
  if (!info || !info.ok) return { text: info && info.reason === 'http-404' ? '非 Pages 部署（无 build.json）' : '未知（拉不到 build.json）', mismatch: false, href: '' };
  const short = info.commit.slice(0, 12);
  const mismatch = !!(info.version && appVersion && info.version !== appVersion);
  const text = `${short} · ${info.fileCount} 个文件 · 清单 ${info.manifestSha.slice(0, 10)}…${mismatch ? ` ⚠ 线上为 ${info.version}，本页运行的是 ${appVersion}（浏览器缓存与部署不一致，请强刷）` : ''}`;
  return { text, mismatch, href: `https://github.com/${info.repository}/commit/${info.commit}` };
}
function paintBuildInfo(el, info, appVersion) {
  if (!el) return;
  const f = formatBuildInfo(info, appVersion);
  el.textContent = '';
  if (f.href) {
    const a = document.createElement('a');
    a.href = f.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = f.text;
    el.appendChild(a);
  } else el.textContent = f.text;
  el.classList.toggle('warn', f.mismatch);
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

export function mountSettings(store, { onRelayChanged, onKeySaved, onSettingChanged } = {}) {
  // 设置页改了开关 / 档位 / 主题后通知外部（main.js → ui.syncToolbar）：顶栏 pill、能力行、主题按钮要跟着变，
  // 不然「设置里开了快速模式，会话区那颗 ⚡ 还是灰的」（.27 修）
  const changed = (key, value) => { try { onSettingChanged && onSettingChanged(key, value); } catch { /* 不影响设置本身 */ } };
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
    changed('theme', v);
  });
  bindSeg('#set-fontsize', (v) => applyFontSizeValue(v));
  bindSeg('#set-motion', (v) => { applyMotionValue(v); paintMotionNote(); changed('motion', v); });

  const bindSw = (id, key, onChange) => {
    const el = $(id); if (!el) return;
    el.addEventListener('change', () => {
      store.state.settings[key] = el.checked;
      store.notify();
      onChange && onChange(el.checked);
      changed(key, el.checked);
    });
  };
  bindSw('#set-sandbox', 'sandboxEnabled');
  if ($('#set-cpp')) bindSw('#set-cpp', 'remoteCppEnabled');
  bindSw('#set-web', 'webEnabled');
  bindSw('#set-fast', 'fastMode');
  bindSw('#set-image-review', 'imageRemoteReview');
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
    changed('reasoningLevel', v);
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

  // 清除临时缓存：只动「丢了也能重建」的东西——Cache Storage（SW 离线资源：模型 / 审核资产 / 静态文件）、sessionStorage、
  // 中继探测缓存；会话 / 密钥 / 设置 / 长效记忆（localStorage + IndexedDB）一律不碰。不刷新页面，下次用到的资源按需重新下载。
  const cacheBtn = $('#set-clear-cache');
  if (cacheBtn) cacheBtn.addEventListener('click', async () => {
    cacheBtn.disabled = true;
    const label = cacheBtn.textContent;
    cacheBtn.textContent = '清除中…';
    try {
      const r = await clearTransientCaches();
      const note = $('#set-cache-note');
      if (note) note.textContent = `已清除：${r.cacheStores} 个离线缓存（${r.cacheEntries} 条资源）· ${r.sessionKeys} 条页面临时状态 · 中继探测已重置。会话 / 密钥 / 设置 / 长效记忆未动；模型与审核资产下次用到时重新下载`;
      toast(`✓ 临时缓存已清除（${r.cacheStores} 个离线缓存 · ${r.cacheEntries} 条资源）`, 'ok', 4200);
      onRelayChanged && onRelayChanged();
    } catch (err) {
      toast(`清除失败：${err && err.message ? err.message : String(err)}`, 'err', 5000);
    } finally { cacheBtn.disabled = false; cacheBtn.textContent = label; }
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

// 临时缓存清理（纯函数化，便于单测）：返回清掉了什么。任何一项不可用（非 https / 旧浏览器）都跳过而不是报错。
export async function clearTransientCaches() {
  const out = { cacheStores: 0, cacheEntries: 0, sessionKeys: 0, relayProbeReset: false };
  if (typeof caches !== 'undefined' && caches && typeof caches.keys === 'function') {
    const names = await caches.keys();
    for (const n of names) {
      try { out.cacheEntries += (await (await caches.open(n)).keys()).length; } catch { /* 数不出来就不数 */ }
      try { if (await caches.delete(n)) out.cacheStores += 1; } catch { /* 单个失败不影响其它 */ }
    }
  }
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage) { out.sessionKeys = sessionStorage.length; sessionStorage.clear(); }
  } catch { /* 隐私模式可能抛 */ }
  try { resetRelayProbe(); out.relayProbeReset = true; } catch { /* noop */ }
  return out;
}

// ── 界面动效偏好（.32）──
// Windows「设置 → 辅助功能 → 视觉效果 → 动画效果」关掉后，浏览器会报 prefers-reduced-motion: reduce，
// 我们的 CSS 据此关掉所有动画——用户只看到「别人有动画我没有」。这里把原因摆出来，并允许覆盖：
//   auto（默认）跟随系统；on 强制开（CSS 的 reduce 块带 html:not([data-motion="on"]) 门控）；off 强制关（html[data-motion="off"] 规则）。
export function systemPrefersReducedMotion() {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
export function readMotionPreference() {
  const v = String(readLocal(MOTION_KEY) || 'auto');
  return ['auto', 'on', 'off'].includes(v) ? v : 'auto';
}
export function applyMotionValue(value, { persist = true } = {}) {
  const v = ['auto', 'on', 'off'].includes(String(value)) ? String(value) : 'auto';
  if (typeof document !== 'undefined') {
    if (v === 'auto') delete document.documentElement.dataset.motion;
    else document.documentElement.dataset.motion = v;
  }
  if (persist) { if (v === 'auto') removeLocal(MOTION_KEY); else writeLocal(MOTION_KEY, v); }
  return v;
}
export function applyMotion() { return applyMotionValue(readMotionPreference(), { persist: false }); }
export function motionNoteText(pref = readMotionPreference(), systemReduce = systemPrefersReducedMotion()) {
  if (pref === 'on') return systemReduce ? '已强制开启：忽略系统的「减少动效」请求' : '已强制开启';
  if (pref === 'off') return '已关闭全部界面动画';
  return systemReduce
    ? '跟随系统：系统当前要求减少动效，所以动画都没有播放（Windows：设置 → 辅助功能 → 视觉效果 → 动画效果；macOS：辅助功能 → 显示 → 减弱动态效果）。选「开」可忽略系统设置'
    : '跟随系统：系统允许动画。菜单弹入、芯片滑入、加载屏等动画正常播放';
}
function paintMotionNote() {
  const n = $('#set-motion-note');
  if (n) n.textContent = motionNoteText();
}

// ── 旧浏览器能力提示（.32）：界面依赖 color-mix() / :has()，缺一个就会「样式有、细节丢」──
export function browserFeatureReport() {
  const sup = (prop, val) => { try { return typeof CSS !== 'undefined' && CSS.supports && CSS.supports(prop, val); } catch { return false; } };
  const supSel = (sel) => { try { return typeof CSS !== 'undefined' && CSS.supports && CSS.supports(`selector(${sel})`); } catch { return false; } };
  const missing = [];
  if (!sup('color', 'color-mix(in srgb, red 50%, blue)')) missing.push('color-mix()');
  if (!supSel(':has(a)')) missing.push(':has()');
  if (!sup('backdrop-filter', 'blur(2px)') && !sup('-webkit-backdrop-filter', 'blur(2px)')) missing.push('backdrop-filter');
  return { ok: missing.length === 0, missing, advice: missing.length ? `浏览器缺少 ${missing.join(' / ')}，部分视觉效果与动画会缺失；建议 Chrome / Edge ≥ 111、Firefox ≥ 121、Safari ≥ 16.4` : '' };
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
