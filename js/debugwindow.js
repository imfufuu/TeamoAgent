// ─── β 调试浮窗（构建 2026.9.27.13）─────────────────────────────────────────
// 打开方式（任一）：
//   · URL 带 ?debug=1（刷新/重开会话期间保持）
//   · 快捷键 Ctrl+Alt+D（Mac ⌃⌥D）
//   · ⌘K 命令面板 →「打开 / 关闭调试浮窗」
// 打开后页面右上角出现可拖动浮窗，像模型输出一样实时滚动系统日志：
//   · 审核全链路（moderation.js 的 mlog：预热/解码/推理/原始概率/判定/fail-open）
//   · console.warn / console.error（任意模块）
//   · Agent 状态切换（main.js 转发）
// 关闭浮窗即退出调试（清除 localStorage teamo.debug）。
// 实现纪律：样式自包含（<style> 注入，CSP style-src 'unsafe-inline' 已放行）；
// 与其他模块只经 globalThis.__teamo* 桥接（混版缓存安全，钩子缺失只降级不报错）；
// 删除本文件并去掉 main.js 的 import 即可整体下线。

const DEBUG_KEY = 'teamo.debug';
const POS_KEY = 'teamo.debug.pos';
const MAX_ROWS = 300;

let root = null;
let bodyEl = null;
let countEl = null;
let jumpEl = null;
let rowCount = 0;
let collapsed = false;
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
  if (s.startsWith('agent.') || s === 'moderation.fail-open') return 'sys';
  return 'info';
}

function addLine(stage, data, stamp) {
  if (!bodyEl) return;
  const kind = kindOf(stage, data);
  const text = fmtData(data);
  // 连续重复行折叠成 ×N（如 tfjs 注册噪音、重试风暴），只保留最新一条并累加计数
  const last = bodyEl.lastElementChild;
  if (last && last.dataset.stage === stage && last.dataset.kind === kind && last.dataset.data === text) {
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
.tdw{position:fixed;z-index:100000;width:min(460px,calc(100vw - 20px));background:var(--bg,#fff);color:var(--fg,#111);
  border:1.5px solid var(--fg,#111);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.28);font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden}
.tdw-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--fg,#111);color:var(--bg,#fff);cursor:grab;user-select:none;touch-action:none}
.tdw-head:active{cursor:grabbing}
.tdw-title{font-weight:700;letter-spacing:.4px}
.tdw-count{opacity:.65;font-size:11px}
.tdw-head .sp{flex:1}
.tdw-btn{border:1px solid rgba(255,255,255,.45);background:transparent;color:inherit;border-radius:6px;padding:1px 8px;font:inherit;font-size:11px;cursor:pointer}
.tdw-btn:hover{background:rgba(255,255,255,.16)}
.tdw-body{max-height:min(52vh,420px);overflow-y:auto;padding:6px 8px;scrollbar-width:thin}
.tdw.collapsed .tdw-body,.tdw.collapsed .tdw-jump{display:none}
.tdw-row{display:flex;gap:7px;padding:2.5px 4px;border-bottom:1px dashed rgba(128,128,128,.22);align-items:baseline;word-break:break-all}
.tdw-t{color:#888;flex:none;font-size:10.5px}
.tdw-s{flex:none;font-weight:700;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tdw-d{white-space:pre-wrap}
.tdw-block .tdw-s,.tdw-err .tdw-s{color:#c62828}
.tdw-block .tdw-d,.tdw-err .tdw-d{color:#c62828;font-weight:700}
.tdw-pass .tdw-s,.tdw-ok .tdw-s{color:#1b7f3a}
.tdw-warn .tdw-s{color:#a66300}
.tdw-sys .tdw-s{color:#0058b0}
.tdw-jump{position:absolute;right:12px;bottom:12px;border:1px solid var(--fg,#111);background:var(--bg,#fff);color:var(--fg,#111);
  border-radius:999px;padding:3px 12px;font:inherit;font-size:11px;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.2)}
.tdw-hint{padding:4px 10px 7px;color:#888;font-size:10.5px;border-top:1px dashed rgba(128,128,128,.25)}
@media (prefers-color-scheme: dark){.tdw{--bg:#141414;--fg:#f2f2f2}}
`;

function buildWindow() {
  root = document.createElement('div');
  root.id = 'teamo-debug-win';
  root.className = 'tdw';
  root.innerHTML = `
    <style>${STYLE}</style>
    <div class="tdw-head" title="拖动移动 · 双击复位">
      <span class="tdw-title">DEBUG · β</span>
      <span class="tdw-count">0</span>
      <span class="sp"></span>
      <button type="button" class="tdw-btn" data-act="clear">清空</button>
      <button type="button" class="tdw-btn" data-act="collapse">收起</button>
      <button type="button" class="tdw-btn" data-act="close">关闭</button>
    </div>
    <div class="tdw-body" aria-live="polite"></div>
    <button type="button" class="tdw-jump" hidden>↓ 回到底部</button>
    <div class="tdw-hint">审核全链路 / console.warn·error / Agent 状态 · Ctrl+Alt+D 开关 · __teamoModDump() 复制全文</div>`;
  document.body.appendChild(root);
  bodyEl = root.querySelector('.tdw-body');
  countEl = root.querySelector('.tdw-count');
  jumpEl = root.querySelector('.tdw-jump');

  // ── 位置：恢复 / 默认右上 ──
  let pos = { x: Math.max(10, (window.innerWidth || 800) - 480), y: 14 };
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) pos = saved;
  } catch { /* 忽略 */ }
  const applyPos = () => {
    const w = root.offsetWidth || 460, h = root.offsetHeight || 300;
    pos.x = Math.min(Math.max(4, pos.x), Math.max(4, (window.innerWidth || 800) - w - 4));
    pos.y = Math.min(Math.max(4, pos.y), Math.max(4, (window.innerHeight || 600) - h - 4));
    root.style.left = `${Math.round(pos.x)}px`;
    root.style.top = `${Math.round(pos.y)}px`;
  };
  applyPos();
  window.addEventListener('resize', applyPos);

  // ── 拖动（Pointer Events：鼠标/触屏通吃）──
  const head = root.querySelector('.tdw-head');
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    drag = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    try { head.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    pos.x = e.clientX - drag.dx;
    pos.y = e.clientY - drag.dy;
    applyPos();
  });
  const endDrag = () => { if (drag) { drag = null; try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* 忽略 */ } } };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);
  head.addEventListener('dblclick', () => { pos = { x: Math.max(10, (window.innerWidth || 800) - 480), y: 14 }; applyPos(); try { localStorage.removeItem(POS_KEY); } catch { /* 忽略 */ } });

  // ── 按钮 ──
  root.addEventListener('click', (e) => {
    const act = e.target && e.target.dataset && e.target.dataset.act;
    if (act === 'clear') { bodyEl.innerHTML = ''; rowCount = 0; if (countEl) countEl.textContent = '0'; }
    if (act === 'collapse') { collapsed = !collapsed; root.classList.toggle('collapsed', collapsed); e.target.textContent = collapsed ? '展开' : '收起'; applyPos(); }
    if (act === 'close') destroyDebug();
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
  addLine('debug:attached', '调试浮窗已开启（Ctrl+Alt+D 或关闭按钮退出）');
}

export function mountDebugWindow() {
  if (!debugActive() || root) return root;
  if (typeof document === 'undefined') return null;
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

export function destroyDebug() {
  if (unsubscribe) { try { unsubscribe(); } catch { /* 忽略 */ } unsubscribe = null; }
  if (root && root.parentNode) root.parentNode.removeChild(root);
  root = bodyEl = countEl = jumpEl = null;
  rowCount = 0;
  collapsed = false;
  setDebug(false);
}

export function toggleDebug() {
  if (debugActive()) { destroyDebug(); return false; }
  setDebug(true);
  mountDebugWindow();
  return true;
}

// ── globalThis 桥（main.js / ui.js 经此调用，混版安全）──
if (typeof globalThis !== 'undefined') {
  globalThis.__teamoDebugToggle = toggleDebug;
  globalThis.__teamoDebugActive = debugActive;
  globalThis.__teamoDebugLog = (stage, data) => addLine(String(stage || 'debug'), data);
}
