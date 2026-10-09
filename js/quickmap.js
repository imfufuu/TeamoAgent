// ─── 快捷地图交互（2026.10.9.1 · 第 2 条）──────────────────────────────────────
// 「:::chart map」在原有只读 choropleth 之上增加：
//   · 滚轮（Ctrl/⌘ + 滚轮，或已放大时）与触控板捏合缩放，以指针为中心；
//   · 拖动平移（超过 4px 视为拖动，拖动结束不触发区域点击）；双击 / ⟲ 复位；
//   · 右下角 ＋ / − / ⟲ 按钮与缩放比例显示；
//   · 键盘：地图获得焦点时 + / − 缩放、0 复位、方向键平移；
//   · 底部「前五名」排行条（按数值降序，带相对占比条）。
// 视图状态只存在 DOM 节点的 _mapView 上，不写回消息；重新渲染地图即回到 100%。
// 纯函数（视图夹取 / 缩放 / 排行）与事件委托分开：前者可单测，后者挂在消息列表上（一次性）。
import { esc } from './ui-markdown.js?v=2026.10.9.1';

export const MAP_VIEW_W = 720;
export const MAP_VIEW_H = 392;
export const MAP_MIN_ZOOM = 1;
export const MAP_MAX_ZOOM = 8;
const DRAG_THRESHOLD_PX = 4;
const PAN_STEP_PX = 40;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 平移夹取：内容不许拖出视口（k=1 时只能居中不动）。 */
export function clampMapView({ k, x, y }) {
  const kk = clamp(Number(k) || 1, MAP_MIN_ZOOM, MAP_MAX_ZOOM);
  return {
    k: kk,
    x: clamp(Number(x) || 0, MAP_VIEW_W - MAP_VIEW_W * kk, 0),
    y: clamp(Number(y) || 0, MAP_VIEW_H - MAP_VIEW_H * kk, 0),
  };
}

/** 以视口坐标 (px, py) 为中心缩放到 k2：该点在内容中的位置保持不动。 */
export function zoomMapAt(view, k2, px, py) {
  const k = clamp(k2, MAP_MIN_ZOOM, MAP_MAX_ZOOM);
  const f = k / view.k;
  return clampMapView({ k, x: px - (px - view.x) * f, y: py - (py - view.y) * f });
}

export function panMapBy(view, dx, dy) {
  return clampMapView({ k: view.k, x: view.x + dx, y: view.y + dy });
}

export function mapTransform(view) {
  const r = (n) => Math.round(n * 1000) / 1000;
  return `translate(${r(view.x)} ${r(view.y)}) scale(${r(view.k)})`;
}

/** 按地区汇总（同名相加，与 renderGeoMapSvg 的口径一致），降序取前 N；返回 { items, rest, total } */
export function rankMapRows(rows, limit = 5) {
  const sums = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row)) continue;
    const name = String(row[0] == null ? '' : row[0]).trim();
    const val = Number(row[1]);
    if (!name || !Number.isFinite(val)) continue;
    sums.set(name, (sums.get(name) || 0) + val);
  }
  const sorted = [...sums.entries()].sort((a, b) => b[1] - a[1]);
  const items = sorted.slice(0, limit).map(([name, value]) => ({ name, value }));
  const max = items.length ? Math.max(...items.map((x) => x.value), 0) : 0;
  return {
    items: items.map((x) => ({ ...x, ratio: max > 0 && x.value > 0 ? x.value / max : 0 })),
    rest: Math.max(0, sorted.length - items.length),
    total: sorted.length,
  };
}

const fmtNum = (v) => (Math.abs(v) >= 1000 ? Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : String(Math.round(v * 100) / 100));

/** 前五名排行条 HTML（rows 为 [地区, 数值] 数组；没有可用数据时返回空串） */
export function mapRankingHtml(rows, limit = 5) {
  const { items, rest, total } = rankMapRows(rows, limit);
  if (!items.length) return '';
  const lis = items.map((x, i) => `<li><span class="rk-n">${i + 1}</span><span class="rk-name">${esc(x.name)}</span>`
    + `<span class="rk-bar" aria-hidden="true"><i style="width:${Math.max(2, Math.round(x.ratio * 100))}%"></i></span>`
    + `<span class="rk-val">${esc(fmtNum(x.value))}</span></li>`).join('');
  const more = rest > 0 ? `<p class="md-map-rank-more">另有 ${rest} 个地区未列出（共 ${total} 个）</p>` : '';
  return `<div class="md-map-rank-wrap"><div class="md-map-rank-h">前 ${items.length} 名</div><ol class="md-map-rank">${lis}</ol>${more}</div>`;
}

/** 地图盒子的控件与排行（渲染完 SVG 后调用一次；重复调用安全） */
export function decorateGeoMap(box, rows) {
  if (!box || box.querySelector('.md-map-ctrl')) return;
  box.tabIndex = 0;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', '地图：滚轮或 + / − 缩放，拖动平移，0 复位');
  box._mapView = { k: 1, x: 0, y: 0 };
  // 地图 SVG 包进 .md-map-stage（相对定位），控件只锚定地图本身，不随排行条一起跑到卡片底部
  const svg = svgOf(box);
  if (svg && svg.parentNode === box) {
    const stage = document.createElement('div');
    stage.className = 'md-map-stage';
    box.insertBefore(stage, svg);
    stage.appendChild(svg);
  }
  const stage = box.querySelector('.md-map-stage') || box;
  stage.insertAdjacentHTML('beforeend',
    '<div class="md-map-ctrl" role="toolbar" aria-label="地图缩放">'
    + '<button type="button" data-map-act="out" aria-label="缩小" title="缩小（−）">−</button>'
    + '<span class="md-map-scale" aria-live="polite">100%</span>'
    + '<button type="button" data-map-act="in" aria-label="放大" title="放大（+）">+</button>'
    + '<button type="button" data-map-act="reset" aria-label="复位" title="复位（0 / 双击）">⟲</button>'
    + '</div>');
  box.insertAdjacentHTML('beforeend', mapRankingHtml(rows));
  paintMapView(box);
}

const viewOf = (box) => box._mapView || { k: 1, x: 0, y: 0 };
const svgOf = (box) => box && box.querySelector('.md-chart-svg');

function paintMapView(box) {
  const view = viewOf(box);
  const g = box.querySelector('.md-map-vp');
  if (g) g.setAttribute('transform', mapTransform(view));
  const scale = box.querySelector('.md-map-scale');
  if (scale) scale.textContent = `${Math.round(view.k * 100)}%`;
  box.dataset.mapZoomed = view.k > MAP_MIN_ZOOM + 1e-6 ? '1' : '0';
  const out = box.querySelector('[data-map-act="out"]');
  const inn = box.querySelector('[data-map-act="in"]');
  if (out) out.disabled = view.k <= MAP_MIN_ZOOM + 1e-6;
  if (inn) inn.disabled = view.k >= MAP_MAX_ZOOM - 1e-6;
}

function setView(box, next) {
  box._mapView = clampMapView(next);
  paintMapView(box);
}

// 视口坐标：指针位置换算到 720×392 的 viewBox（SVG 可能被 CSS 缩小）
function toViewPoint(svg, clientX, clientY) {
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return { x: MAP_VIEW_W / 2, y: MAP_VIEW_H / 2 };
  return { x: (clientX - r.left) * (MAP_VIEW_W / r.width), y: (clientY - r.top) * (MAP_VIEW_H / r.height) };
}

const mapBoxOf = (node) => (node && node.closest ? node.closest('.md-chart-map') : null);

/** 挂到消息列表上的一次性委托（mountUI 调用一次）。 */
export function installMapInteractions(root) {
  if (!root || root._mapInstalled) return;
  root._mapInstalled = true;

  root.addEventListener('wheel', (e) => {
    const box = mapBoxOf(e.target);
    const svg = svgOf(box);
    if (!box || !svg) return;
    const view = viewOf(box);
    // 普通滚轮照常滚动聊天；Ctrl/⌘（含触控板捏合）或已放大时才缩放，避免误伤页面滚动
    if (!(e.ctrlKey || e.metaKey || view.k > MAP_MIN_ZOOM + 1e-6)) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0022);
    const p = toViewPoint(svg, e.clientX, e.clientY);
    setView(box, zoomMapAt(view, view.k * factor, p.x, p.y));
  }, { passive: false });

  root.addEventListener('pointerdown', (e) => {
    const box = mapBoxOf(e.target);
    const svg = svgOf(box);
    if (!box || !svg || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (!box._ptrs) box._ptrs = new Map();
    box._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (box._ptrs.size === 1) box._drag = { x0: e.clientX, y0: e.clientY, view0: viewOf(box), moved: false };
    if (box._ptrs.size === 2) {
      const [a, b] = [...box._ptrs.values()];
      box._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      box._drag = null;
    }
  });

  root.addEventListener('pointermove', (e) => {
    const box = mapBoxOf(e.target);
    const svg = svgOf(box);
    if (!box || !svg || !box._ptrs || !box._ptrs.has(e.pointerId)) return;
    box._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (box._ptrs.size >= 2 && box._pinch) {
      const [a, b] = [...box._ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = toViewPoint(svg, (a.x + b.x) / 2, (a.y + b.y) / 2);
      const view = viewOf(box);
      setView(box, zoomMapAt(view, view.k * (d / box._pinch.d), mid.x, mid.y));
      box._pinch.d = d;
      box._suppressClickUntil = Date.now() + 350;
      return;
    }
    const drag = box._drag;
    if (!drag || box._ptrs.size !== 1) return;
    const dxPx = e.clientX - drag.x0;
    const dyPx = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) return;
    if (!drag.moved) { drag.moved = true; try { svg.setPointerCapture(e.pointerId); } catch { /* 老浏览器忽略 */ } }
    const r = svg.getBoundingClientRect();
    const sx = r.width ? MAP_VIEW_W / r.width : 1;
    const sy = r.height ? MAP_VIEW_H / r.height : 1;
    setView(box, panMapBy(drag.view0, dxPx * sx, dyPx * sy));
    box._suppressClickUntil = Date.now() + 350;
  });

  const endPointer = (e) => {
    const box = mapBoxOf(e.target);
    if (!box || !box._ptrs || !box._ptrs.has(e.pointerId)) return;
    box._ptrs.delete(e.pointerId);
    if (box._ptrs.size < 2) box._pinch = null;
    if (box._ptrs.size === 0) box._drag = null;
  };
  root.addEventListener('pointerup', endPointer);
  root.addEventListener('pointercancel', endPointer);

  // 捕获阶段：拖动 / 捏合之后紧跟的 click 不应当成区域点击（否则会误钉住浮层）；按钮点击在这里处理
  root.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-map-act]');
    if (btn) {
      const box = mapBoxOf(btn);
      if (!box) return;
      e.preventDefault(); e.stopPropagation();
      const act = btn.getAttribute('data-map-act');
      const view = viewOf(box);
      const cx = MAP_VIEW_W / 2; const cy = MAP_VIEW_H / 2;
      if (act === 'in') setView(box, zoomMapAt(view, view.k * 1.5, cx, cy));
      else if (act === 'out') setView(box, zoomMapAt(view, view.k / 1.5, cx, cy));
      else if (act === 'reset') setView(box, { k: 1, x: 0, y: 0 });
      return;
    }
    const box = mapBoxOf(e.target);
    if (box && box._suppressClickUntil && Date.now() < box._suppressClickUntil) {
      e.preventDefault(); e.stopPropagation();
    }
  }, true);

  root.addEventListener('dblclick', (e) => {
    const box = mapBoxOf(e.target);
    if (!box || !svgOf(box) || e.target.closest('[data-map-act]')) return;
    setView(box, { k: 1, x: 0, y: 0 });
  });

  root.addEventListener('keydown', (e) => {
    const box = mapBoxOf(e.target);
    if (!box || !svgOf(box)) return;
    const view = viewOf(box);
    const cx = MAP_VIEW_W / 2; const cy = MAP_VIEW_H / 2;
    let handled = true;
    if (e.key === '+' || e.key === '=') setView(box, zoomMapAt(view, view.k * 1.25, cx, cy));
    else if (e.key === '-' || e.key === '_') setView(box, zoomMapAt(view, view.k / 1.25, cx, cy));
    else if (e.key === '0') setView(box, { k: 1, x: 0, y: 0 });
    else if (e.key === 'ArrowLeft') setView(box, panMapBy(view, PAN_STEP_PX, 0));
    else if (e.key === 'ArrowRight') setView(box, panMapBy(view, -PAN_STEP_PX, 0));
    else if (e.key === 'ArrowUp') setView(box, panMapBy(view, 0, PAN_STEP_PX));
    else if (e.key === 'ArrowDown') setView(box, panMapBy(view, 0, -PAN_STEP_PX));
    else handled = false;
    if (handled && e.target === box) e.preventDefault();
  });
}
