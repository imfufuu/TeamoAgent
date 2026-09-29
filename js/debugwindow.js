// ─── β 调试浮窗（构建 2026.9.27.14）─────────────────────────────────────────
// 打开方式（任一）：
//   · URL 带 ?debug=1（刷新/重开会话期间保持）
//   · 快捷键 Ctrl+Alt+D（Mac ⌃⌥D）
//   · ⌘K 命令面板 →「打开 / 关闭调试浮窗」
//   · 右下角「调试」悬浮入口（关闭动画也最小化到这里）
// 浮窗：可拖动 + 四角缩放（320×220 ～ 视口-16）；日志像模型输出一样实时滚动：
//   审核全链路 / console.warn·error / Agent 状态。行点击多选，全选/复制一键导出。
// 实现纪律：样式自包含；与其他模块只经 globalThis.__teamo* 桥接（混版安全）；
// 删除本文件并去掉 main.js 的 import 即可整体下线。

const DEBUG_KEY = 'teamo.debug';
const POS_KEY = 'teamo.debug.pos';
const MAX_ROWS = 300;
const MIN_W = 320, MIN_H = 220;

let root = null;
let entryEl = null;
let bodyEl = null;
let countEl = null;
let jumpEl = null;
let rowCount = 0;
let collapsed = false;
let closing = false;
let unsubscribe = null;

export function debugActive() {
  try { return localStorage.getItem(DEBUG_KEY) === '1'; } catch { return false; }
}

export function setDebug(on) {
  try {
    if (on) localStorage.setItem(DEBUG_KEY, '1');
    else localStorage.removeItem(DEBUG_KEY);
  } catch { /* 无痕/沙箱环境忽略 */ }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function nowStamp() {
  return new Date().toISOString().slice(11, 23);
}

function fmtData(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  try { return JSON.stringify(data).slice(0, 700); }
  catch { return String(data).slice(0, 700); }
}

function kindOf(stage, data) {
  const s = String(stage || '');
  if (/error|fail|skip/.test(s)) return 'err';
  if (/verdict|final|done|ready/.test(s)) return data && data.blocked === true ? 'block' : data && data.blocked === false ? 'pass' : 'ok';
  if (s === 'console.warn') return 'warn';
  if (s === 'console.error') return 'err';
  if (s.startsWith('agent.') || s.startsWith('moderation.')) return 'sys';
  return 'info';
}

function selectedRows() {
  if (!bodyEl) return [];
  const rows = [...bodyEl.querySelectorAll('.tdw-row')];
  const sel = rows.filter((r) => r.classList.contains('tdw-sel'));
  return (sel.length ? sel : rows).map((r) => {
    const n = r.dataset.n && r.dataset.n !== '1' ? `(×${r.dataset.n}) ` : '';
    return `${r.querySelector('.tdw-t').textContent} ${r.querySelector('.tdw-s').textContent} ${n}${r.querySelector('.tdw-d').textContent}`;
  });
}

async function copySelected() {
  const lines = selectedRows();
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 忽略 */ }
    ta.remove();
  }
}

function clearSelection() {
  if (bodyEl) bodyEl.querySelectorAll('.tdw-row.tdw-sel').forEach((r) => r.classList.remove('tdw-sel'));
}

function addLine(stage, data, stamp) {
  if (!bodyEl) return;
  const kind = kindOf(stage, data);
  const text = fmtData(data);
  // 连续重复行折叠成 ×N（如重试风暴），只保留最新一条并累加计数
  const last = bodyEl.lastElementChild;
  if (last && last.classList.contains('tdw-row') && last.dataset.stage === stage && last.dataset.kind === kind && last.dataset.data === text) {
    const n = (parseInt(last.dataset.n || '1', 10) || 1) + 1;
    last.dataset.n = String(n);
    const cnt = last.querySelector('.tdw-n');
    if (cnt) cnt.textContent = ` ×${n}`;
    rowCount = Math.min(rowCount + 1, MAX_ROWS);
    if (countEl) countEl.textContent = String(rowCount);
    return;
  }
  const row = document.createElement('div');
  row.className = `tdw-row tdw-${kind}`;
  row.dataset.stage = stage;
  row.dataset.kind = kind;
  row.dataset.data = text;
  row.dataset.n = '1';
  row.innerHTML = `<span class="tdw-t">${esc(stamp || nowStamp())}</span><span class="tdw-s">${esc(stage)}</span><span class="tdw-n"></span><span class="tdw-d">${esc(text)}</span>`;
  const stick = bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 48;
  bodyEl.appendChild(row);
  rowCount++;
  while (rowCount > MAX_ROWS && bodyEl.firstChild) { bodyEl.removeChild(bodyEl.firstChild); rowCount--; }
  if (countEl) countEl.textContent = String(rowCount);
  if (stick && !collapsed) bodyEl.scrollTop = bodyEl.scrollHeight;
  if (jumpEl) jumpEl.hidden = stick;
}

// ── console.warn/error 转发（只包一层，保留原实现）──
function wrapConsole() {
  if (console.__teamoDebugWrapped) return;
  console.__teamoDebugWrapped = true;
  const ow = console.warn.bind(console);
  const oe = console.error.bind(console);
  console.warn = (...a) => { addLine('console.warn', a.map((x) => (typeof x === 'string' ? x : x && x.message ? x.message : fmtData(x))).join(' ')); ow(...a); };
  console.error = (...a) => { addLine('console.error', a.map((x) => (typeof x === 'string' ? x : x && x.message ? x.message : fmtData(x))).join(' ')); oe(...a); };
}

const STYLE = `
.tdw-entry{position:fixed;right:14px;bottom:14px;z-index:99998;border:1.5px solid var(--tdw-fg,#111);background:var(--tdw-bg,#fff);
  color:var(--tdw-fg,#111);border-radius:999px;padding:5px 13px;font:700 12px/1.4 ui-monospace,Menlo,Consolas,monospace;cursor:pointer;
  box-shadow:0 3px 12px rgba(0,0,0,.22);opacity:.82}
.tdw-entry:hover{opacity:1}
.tdw-entry.on{background:var(--tdw-fg,#111);color:var(--tdw-bg,#fff)}
.tdw{position:fixed;z-index:100000;display:flex;flex-direction:column;width:460px;height:360px;background:var(--tdw-bg,#fff);color:var(--tdw-fg,#111);
  border:1.5px solid var(--tdw-fg,#111);border-radius:18px;box-shadow:0 10px 34px rgba(0,0,0,.28);
  font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:visible}
.tdw.tdw-pop{animation:tdwPop .2s ease-out}
@keyframes tdwPop{from{transform:scale(.72);opacity:0}to{transform:scale(1);opacity:1}}
.tdw-head{display:flex;align-items:center;gap:7px;padding:7px 10px;background:var(--tdw-fg,#111);color:var(--tdw-bg,#fff);
  cursor:grab;user-select:none;touch-action:none;border-radius:16.5px 16.5px 0 0;flex:none}
.tdw-head:active{cursor:grabbing}
.tdw-title{font-weight:700;letter-spacing:.4px}
.tdw-count{opacity:.65;font-size:11px}
.tdw-head .sp{flex:1}
.tdw-btn{border:1px solid rgba(255,255,255,.45);background:transparent;color:inherit;border-radius:6px;padding:1px 7px;font:inherit;font-size:11px;cursor:pointer}
.tdw-btn:hover{background:rgba(255,255,255,.16)}
.tdw-body{flex:1;min-height:0;max-height:100%;overflow-y:auto;padding:6px 8px;scrollbar-width:thin}
.tdw.collapsed .tdw-body,.tdw.collapsed .tdw-jump,.tdw.collapsed .tdw-rz{display:none}
.tdw.collapsed{height:auto !important}
.tdw-row{display:flex;gap:7px;padding:2.5px 4px;border-bottom:1px dashed rgba(128,128,128,.22);align-items:baseline;word-break:break-all;cursor:pointer}
.tdw-row:hover{background:rgba(128,128,128,.09)}
.tdw-row.tdw-sel{background:rgba(0,88,176,.14);box-shadow:inset 2px 0 0 #0058b0}
.tdw-t{color:#888;flex:none;font-size:10.5px}
.tdw-s{flex:none;font-weight:700;max-width:32%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tdw-n{color:#a66300;font-weight:700}
.tdw-d{white-space:pre-wrap}
.tdw-block .tdw-s,.tdw-err .tdw-s{color:#c62828}
.tdw-block .tdw-d,.tdw-err .tdw-d{color:#c62828;font-weight:700}
.tdw-pass .tdw-s,.tdw-ok .tdw-s{color:#1b7f3a}
.tdw-warn .tdw-s{color:#a66300}
.tdw-sys .tdw-s{color:#0058b0}
.tdw-jump{position:absolute;right:12px;bottom:34px;border:1px solid var(--tdw-fg,#111);background:var(--tdw-bg,#fff);color:var(--tdw-fg,#111);
  border-radius:999px;padding:3px 12px;font:inherit;font-size:11px;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.2)}
.tdw-hint{padding:3px 10px 6px;color:#888;font-size:10.5px;border-top:1px dashed rgba(128,128,128,.25);flex:none;user-select:none}
/* 缩放手柄：仅右下角顶点，弧线与面板圆角同心（视觉参考 iOS 圆角指示） */
.tdw-rz{position:absolute;right:-6px;bottom:-6px;width:26px;height:26px;z-index:2;touch-action:none;cursor:nwse-resize}
.tdw-rz::after{content:'';position:absolute;right:7px;bottom:7px;width:11px;height:11px;
  border-right:2.5px solid var(--tdw-fg,#111);border-bottom:2.5px solid var(--tdw-fg,#111);
  border-bottom-right-radius:100%;opacity:.9}
.tdw-rz:hover::after{opacity:1;right:5px;bottom:5px}
@media (prefers-color-scheme: dark){.tdw,.tdw-entry{--tdw-bg:#141414;--tdw-fg:#f2f2f2}}
@media (prefers-reduced-motion: reduce){.tdw.tdw-pop{animation:none}}
`;

function entryRect() {
  if (entryEl && document.body.contains(entryEl)) return entryEl.getBoundingClientRect();
  return { left: window.innerWidth - 60, right: window.innerWidth - 20, top: window.innerHeight - 50, bottom: window.innerHeight - 14, width: 40, height: 28 };
}

function buildEntry() {
  if (entryEl) return;
  entryEl = document.createElement('button');
  entryEl.type = 'button';
  entryEl.className = 'tdw-entry' + (debugActive() ? ' on' : '');
  entryEl.textContent = debugActive() ? '● 调试' : '调试';
  entryEl.title = '调试浮窗（β）：审核全链路 / 系统日志 · Ctrl+Alt+D 开关';
  // 内联样式（不依赖浮窗的 <style>：浮窗销毁后入口仍保持外观与位置）
  entryEl.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:99998;border:1.5px solid #111;background:#111;color:#fff;'
    + 'border-radius:999px;padding:6px 14px;font:700 12px/1.4 ui-monospace,Menlo,Consolas,monospace;cursor:pointer;'
    + 'box-shadow:0 3px 12px rgba(0,0,0,.25);opacity:.85';
  entryEl.addEventListener('mouseenter', () => { entryEl.style.opacity = '1'; });
  entryEl.addEventListener('mouseleave', () => { entryEl.style.opacity = '.85'; });
  entryEl.addEventListener('click', () => toggleDebug());
  document.body.appendChild(entryEl);
}

function clampPos(pos) {
  const vw = window.innerWidth || 800, vh = window.innerHeight || 600;
  const w = root ? root.offsetWidth : 460, h = root ? root.offsetHeight : 360;
  pos.x = Math.min(Math.max(4, pos.x), Math.max(4, vw - w - 4));
  pos.y = Math.min(Math.max(4, pos.y), Math.max(4, vh - Math.min(h, vh) - 4));
}

function buildWindow() {
  root = document.createElement('div');
  root.id = 'teamo-debug-win';
  root.className = 'tdw tdw-pop';
  root.innerHTML = `
    <style>${STYLE}</style>
    <div class="tdw-head" title="拖动移动 · 双击复位">
      <span class="tdw-title">DEBUG · β</span>
      <span class="tdw-count">0</span>
      <span class="sp"></span>
      <button type="button" class="tdw-btn" data-act="all">全选</button>
      <button type="button" class="tdw-btn" data-act="copy">复制</button>
      <button type="button" class="tdw-btn" data-act="clear">清空</button>
      <button type="button" class="tdw-btn" data-act="collapse">收起</button>
      <button type="button" class="tdw-btn" data-act="close">关闭</button>
    </div>
    <div class="tdw-body" aria-live="polite"></div>
    <button type="button" class="tdw-jump" hidden>↓ 回到底部</button>
    <div class="tdw-hint">点击行多选 · 全选/复制导出 · Ctrl+Alt+D 开关 · __teamoModDump() 控制台全文</div>
    <div class="tdw-rz" data-rz="se" title="拖拽调整大小"></div>`;
  document.body.appendChild(root);
  bodyEl = root.querySelector('.tdw-body');
  countEl = root.querySelector('.tdw-count');
  jumpEl = root.querySelector('.tdw-jump');

  // ── 位置/尺寸：恢复 / 默认右上 ──
  let state = { x: Math.max(10, (window.innerWidth || 800) - 476), y: 14, w: 460, h: Math.min(360, (window.innerHeight || 600) - 28) };
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      state = { x: saved.x, y: saved.y, w: Number(saved.w) || state.w, h: Number(saved.h) || state.h };
    }
  } catch { /* 忽略 */ }
  const vw = () => window.innerWidth || 800, vh = () => window.innerHeight || 600;
  const applyState = () => {
    state.w = Math.min(Math.max(MIN_W, state.w), vw() - 16);
    state.h = Math.min(Math.max(MIN_H, state.h), vh() - 24);
    root.style.width = `${Math.round(state.w)}px`;
    root.style.height = collapsed ? 'auto' : `${Math.round(state.h)}px`;
    clampPos(state);
    root.style.left = `${Math.round(state.x)}px`;
    root.style.top = `${Math.round(state.y)}px`;
  };
  applyState();
  window.addEventListener('resize', applyState);

  // ── 拖动（标题栏）──
  const head = root.querySelector('.tdw-head');
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    drag = { dx: e.clientX - state.x, dy: e.clientY - state.y };
    try { head.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    state.x = e.clientX - drag.dx;
    state.y = e.clientY - drag.dy;
    clampPos(state);
    root.style.left = `${Math.round(state.x)}px`;
    root.style.top = `${Math.round(state.y)}px`;
  });
  const endDrag = () => { if (drag) { drag = null; try { localStorage.setItem(POS_KEY, JSON.stringify(state)); } catch { /* 忽略 */ } } };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);
  head.addEventListener('dblclick', () => {
    state = { x: Math.max(10, vw() - state.w - 10), y: 14, w: state.w, h: state.h };
    applyState();
    try { localStorage.setItem(POS_KEY, JSON.stringify(state)); } catch { /* 忽略 */ }
  });

  // ── 四角缩放 ──
  root.querySelectorAll('.tdw-rz').forEach((h) => {
    h.addEventListener('pointerdown', (e) => {
      h.setPointerCapture && h.setPointerCapture(e.pointerId);
      const start = { px: e.clientX, py: e.clientY, w: state.w, h: state.h };
      const move = (ev) => {
        state.w = start.w + (ev.clientX - start.px);
        state.h = start.h + (ev.clientY - start.py);
        applyState();
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        try { localStorage.setItem(POS_KEY, JSON.stringify(state)); } catch { /* 忽略 */ }
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
      e.preventDefault();
      e.stopPropagation();
    });
  });

  // ── 按钮 / 行选择 ──
  root.addEventListener('click', (e) => {
    const act = e.target && e.target.dataset && e.target.dataset.act;
    if (act === 'clear') { bodyEl.innerHTML = ''; rowCount = 0; if (countEl) countEl.textContent = '0'; if (globalThis.__teamoModLog) globalThis.__teamoModLog.length = 0; }
    if (act === 'collapse') { collapsed = !collapsed; root.classList.toggle('collapsed', collapsed); e.target.textContent = collapsed ? '展开' : '收起'; applyState(); }
    if (act === 'all') {
      const rows = [...bodyEl.querySelectorAll('.tdw-row')];
      const allSel = rows.length && rows.every((r) => r.classList.contains('tdw-sel'));
      rows.forEach((r) => r.classList.toggle('tdw-sel', !allSel));
    }
    if (act === 'copy') copySelected();
    if (act === 'close') destroyDebug(true);
  });
  bodyEl.addEventListener('click', (e) => {
    const row = e.target.closest('.tdw-row');
    if (row && !window.getSelection().toString()) row.classList.toggle('tdw-sel');
  });
  jumpEl.addEventListener('click', () => { bodyEl.scrollTop = bodyEl.scrollHeight; jumpEl.hidden = true; });
  bodyEl.addEventListener('scroll', () => { if (jumpEl) jumpEl.hidden = bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 48; });

  // ── 日志源 ──
  if (typeof globalThis.__teamoModSubscribe === 'function') {
    unsubscribe = globalThis.__teamoModSubscribe((entry) => {
      const { t, stage, ...data } = entry || {};
      addLine(String(stage || 'moderation'), data, t);
    });
  }
  wrapConsole();
  addLine('debug:attached', '调试浮窗已开启 · 点击行多选，全选/复制导出 · Ctrl+Alt+D 关闭');
}

export function mountDebugWindow() {
  if (!debugActive() || root || closing) return root;
  if (typeof document === 'undefined') return null;
  buildEntry();
  buildWindow();
  // 回放环形缓冲里最近的日志（浮窗打开前发生的审核也有记录）
  try {
    for (const e of (globalThis.__teamoModLog || []).slice(-120)) {
      const { t, stage, ...data } = e || {};
      addLine(String(stage || 'moderation'), data, t);
    }
  } catch { /* 忽略回放失败 */ }
  return root;
}

function teardown() {
  if (unsubscribe) { try { unsubscribe(); } catch { /* 忽略 */ } unsubscribe = null; }
  if (root && root.parentNode) root.parentNode.removeChild(root);
  root = bodyEl = countEl = jumpEl = null;
  rowCount = 0;
  collapsed = false;
  closing = false;
  setDebug(false);
  if (entryEl) { entryEl.classList.remove('on'); entryEl.textContent = '调试'; }
}

export function destroyDebug(animate = false) {
  if (!root || closing) return;
  if (!animate) { teardown(); return; }
  closing = true;
  const wr = root.getBoundingClientRect();
  const er = entryRect();
  const dx = (er.left + er.width / 2) - wr.right; // transformOrigin 右上角
  const dy = (er.top + er.height / 2) - wr.top;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { teardown(); return; }
  root.style.transformOrigin = '100% 0%';
  root.style.transition = 'transform .3s cubic-bezier(.4,0,.2,1), opacity .3s ease-in';
  root.style.pointerEvents = 'none';
  requestAnimationFrame(() => {
    root.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px) scale(.04)`;
    root.style.opacity = '0';
  });
  setTimeout(teardown, 330);
}

export function toggleDebug() {
  if (debugActive() && root) { destroyDebug(true); return false; }
  setDebug(true);
  if (entryEl) { entryEl.classList.add('on'); entryEl.textContent = '● 调试'; }
  mountDebugWindow();
  return true;
}

// ── globalThis 桥（main.js / ui.js 经此调用，混版安全）──
if (typeof globalThis !== 'undefined') {
  globalThis.__teamoDebugToggle = toggleDebug;
  globalThis.__teamoDebugActive = debugActive;
  globalThis.__teamoDebugSet = (on) => {
    const cur = !!(debugActive() && document.getElementById('teamo-debug-win'));
    if (on && !cur) { setDebug(true); if (entryEl) entryEl.classList.add('on'); mountDebugWindow(); return true; }
    if (!on && cur) { destroyDebug(true); return false; }
    return cur;
  };
  globalThis.__teamoDebugLog = (stage, data) => addLine(String(stage || 'debug'), data);
}
