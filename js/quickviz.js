// Dubhe Agent · 快捷可视化（从 ui.js 拆出，V1.7.1）
// Markdown 围栏里的 :::chart（柱状 / 折线 / 散点 / 物理 s-t / 饼图）与 :::diagram（流程 / 思维导图）
// 直接渲染为内联 SVG，不依赖 DOM 以外的任何运行时；纯函数、可单测。
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const CHART_ALIAS = {
  bar: 'bar', bars: 'bar', 柱状图: 'bar', 柱状: 'bar', 条形图: 'bar',
  line: 'line', 折线图: 'line', 折线: 'line', 趋势图: 'line',
  scatter: 'scatter', scat: 'scatter', 散点图: 'scatter', 散点: 'scatter',
  st: 'st', 's-t': 'st', 's_t': 'st', 's–t': 'st', 's—t': 'st',
  '位移时间图': 'st', '位移-时间图': 'st', '路程时间图': 'st', '路程-时间图': 'st',
  pie: 'pie', 饼图: 'pie', 饼: 'pie', 环形图: 'pie',
};
const CHART_KIND_LABEL = { bar: '柱状图', line: '折线图', scatter: '散点图', st: 's-t 图（位移/路程-时间）', pie: '饼图' };
const CHART_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#f97316'];
const chartNum = (s) => {
  const txt = String(s ?? '').replace(/[％%,，]/g, '').trim();
  if (!txt) return null;
  const m = txt.match(/[-+]?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
};
const chartFmt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return Number(n.toFixed(1)).toString();
  return Number(n.toFixed(2)).toString();
};
const splitChartLine = (line) => String(line || '').split(/[,\t|，、]+|\s{2,}|\s*[:：]\s*/).map((x) => x.trim()).filter(Boolean);
export function parseChartInfo(info, directKind = '') {
  const raw = String(info || '').trim();
  if (directKind) return { kind: CHART_ALIAS[directKind] || CHART_ALIAS[directKind.toLowerCase()] || 'bar', title: raw };
  const parts = raw.split(/\s+/).filter(Boolean);
  const first = parts.shift() || 'bar';
  const kind = CHART_ALIAS[first.toLowerCase()] || CHART_ALIAS[first] || 'bar';
  return { kind, title: parts.join(' ') };
}
function parseSeriesRows(body, kind) {
  const rows = [];
  for (const raw of String(body || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^[-|\s]+$/.test(line)) continue;
    if (/^(label|name|x|t|time|时间)\s*[,|\t:：]/i.test(line)) continue;
    if (kind === 'scatter' || kind === 'st') {
      const cells = splitChartLine(line);
      const nums = cells.map(chartNum);
      if (nums.length >= 2 && nums[0] != null && nums[1] != null) {
        rows.push({ label: String(rows.length + 1), x: nums[0], value: nums[1] });
        continue;
      }
      if (cells.length >= 3 && nums[1] != null && nums[2] != null) {
        rows.push({ label: cells[0], x: nums[1], value: nums[2] });
        continue;
      }
    }
    let label = '', val = null;
    const cells = splitChartLine(line);
    if (cells.length >= 2) { label = cells[0]; val = chartNum(cells[1]); }
    if (val == null) {
      const m = /^(.*?)[\s,，|:：]+([-+]?\d+(?:\.\d+)?%?)\s*$/.exec(line);
      if (m) { label = m[1].trim(); val = chartNum(m[2]); }
    }
    if (label && val != null) rows.push({ label, value: val });
  }
  return rows.slice(0, 36);
}
function chartScales(rows, w, h, m, opts = {}) {
  const vals = rows.map((r) => r.value);
  let min = Math.min(opts.includeZero === false ? Infinity : 0, ...vals);
  let max = Math.max(opts.includeZero === false ? -Infinity : 0, ...vals);
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.08;
  if (opts.includeZero === false) { min -= pad; max += pad; }
  const plotW = w - m.l - m.r, plotH = h - m.t - m.b;
  const y = (v) => m.t + (max - v) / (max - min) * plotH;
  return { min, max, plotW, plotH, y };
}
function chartTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min || 0];
  const out = [];
  for (let i = 0; i < count; i++) out.push(min + (max - min) * i / (count - 1));
  return out;
}
function axisSvg(rows, w, h, m, sc, opts = {}) {
  const bits = [];
  const plotBottom = h - m.b;
  const plotRight = w - m.r;
  for (const v of chartTicks(sc.min, sc.max, 5)) {
    const y = sc.y(v);
    bits.push(`<line x1="${m.l}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(1)}" class="md-chart-grid"/>`);
    bits.push(`<text x="${m.l - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" stroke="none" class="md-chart-tick">${esc(chartFmt(v))}</text>`);
  }
  bits.push(`<line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${plotBottom}" class="md-chart-axis"/>`);
  bits.push(`<line x1="${m.l}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" class="md-chart-axis"/>`);
  if (opts.xTicks && opts.xScale) {
    for (const v of opts.xTicks) {
      const x = opts.xScale(v);
      bits.push(`<line x1="${x.toFixed(1)}" y1="${plotBottom}" x2="${x.toFixed(1)}" y2="${plotBottom + 5}" class="md-chart-axis"/>`);
      bits.push(`<text x="${x.toFixed(1)}" y="${plotBottom + 20}" text-anchor="middle" stroke="none" class="md-chart-tick">${esc(chartFmt(v))}</text>`);
    }
  } else {
    const step = Math.max(1, Math.ceil(rows.length / 8));
    rows.forEach((r, i) => {
      if (i % step) return;
      const x = opts.xForIndex ? opts.xForIndex(i) : m.l + (i + .5) * sc.plotW / Math.max(1, rows.length);
      const text = truncateDiagramLabel(r.label, 12);
      const rot = rows.length > 6 || diagramTextUnits(text) > 4.5;
      bits.push(`<text x="${x.toFixed(1)}" y="${plotBottom + 20}" text-anchor="${rot ? 'end' : 'middle'}" stroke="none" class="md-chart-tick"${rot ? ` transform="rotate(-25 ${x.toFixed(1)} ${plotBottom + 20})"` : ''}>${esc(text)}</text>`);
    });
  }
  if (opts.xLabel) bits.push(`<text x="${((m.l + plotRight) / 2).toFixed(1)}" y="${h - 14}" text-anchor="middle" stroke="none" class="md-chart-axis-label">${esc(opts.xLabel)}</text>`);
  if (opts.yLabel) bits.push(`<text x="18" y="${((m.t + plotBottom) / 2).toFixed(1)}" text-anchor="middle" stroke="none" transform="rotate(-90 18 ${((m.t + plotBottom) / 2).toFixed(1)})" class="md-chart-axis-label">${esc(opts.yLabel)}</text>`);
  return bits.join('');
}
export function renderQuickChart(kind, body, title = '') {
  const sourceRows = parseSeriesRows(body, kind);
  const rows = kind === 'st' ? [...sourceRows].sort((a, b) => a.x - b.x) : sourceRows;
  const label = title || CHART_KIND_LABEL[kind] || '图表';
  if (!rows.length) {
    const sample = kind === 'st' ? '<code>0, 0</code><br><code>1, 4</code>' : '<code>一月, 12</code>';
    return `<div class="md-chart-error">图表数据为空。示例：${sample}</div>`;
  }
  const firstText = truncateDiagramLabel(rows[0] && rows[0].label, 12);
  const firstRot = rows.length > 6 || diagramTextUnits(firstText) > 4.5;
  const leftMargin = (kind === 'line' || kind === 'bar') && firstRot
    ? Math.max(76, Math.ceil(diagramTextUnits(firstText) * 10.5 * 0.9 + 18))
    : 76;
  const w = 720, h = 392, m = { l: leftMargin, r: 44, t: 58, b: 86 };
  let inner = `<text x="${m.l}" y="34" stroke="none" class="md-chart-title">${esc(label)}</text>`;
  if (kind === 'pie') {
    const vals = rows.map((r) => Math.max(0, r.value));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = w / 2, cy = h / 2 + 14, r = 102;
    let a0 = -Math.PI / 2;
    const pieLabels = [];
    rows.forEach((row, i) => {
      const a1 = a0 + (Math.max(0, row.value) / total) * Math.PI * 2;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const color = CHART_COLORS[i % CHART_COLORS.length];
      const pct = `${Math.round(row.value / total * 100)}%`;
      const dataAttrs = `data-chart-label="${esc(row.label)}" data-chart-val="${esc(chartFmt(row.value))}" data-chart-pct="${pct}" data-chart-color="${color}" tabindex="0"`;
      if (a1 - a0 >= Math.PI * 1.999) {
        inner += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" ${dataAttrs} class="md-chart-slice"><title>${esc(row.label)}: ${esc(row.value)} (${pct})</title></circle>`;
      } else {
        inner += `<path d="M ${cx} ${cy} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${color}" ${dataAttrs} class="md-chart-slice"><title>${esc(row.label)}: ${esc(row.value)} (${pct})</title></path>`;
      }
      const mid = (a0 + a1) / 2;
      const rightSide = Math.cos(mid) >= 0;
      const lx = cx + (r + 36) * Math.cos(mid);
      const ly = cy + (r + 32) * Math.sin(mid);
      pieLabels.push({
        rightSide,
        lx: Math.max(24, Math.min(w - 24, lx)),
        ly: Math.max(54, Math.min(h - 18, ly)),
        text: `${truncateDiagramLabel(row.label, 12)} ${pct}`,
      });
      a0 = a1;
    });
    for (const side of [true, false]) {
      const group = pieLabels.filter((p) => p.rightSide === side).sort((a, b) => a.ly - b.ly);
      for (let i = 1; i < group.length; i++) {
        if (group[i].ly - group[i - 1].ly < 18) group[i].ly = Math.min(h - 16, group[i - 1].ly + 18);
      }
    }
    for (const pl of pieLabels) {
      inner += `<text x="${pl.lx.toFixed(1)}" y="${pl.ly.toFixed(1)}" text-anchor="${pl.rightSide ? 'start' : 'end'}" class="md-chart-label">${esc(pl.text)}</text>`;
    }
  } else if (kind === 'scatter' || kind === 'st') {
    const xs = rows.map((r) => r.x);
    let minX = Math.min(kind === 'st' ? 0 : Infinity, ...xs), maxX = Math.max(kind === 'st' ? 0 : -Infinity, ...xs);
    if (minX === maxX) { minX -= 1; maxX += 1; }
    const xPad = kind === 'st' ? 0 : (maxX - minX) * 0.08;
    minX -= xPad; maxX += xPad;
    const sc = chartScales(rows, w, h, m, { includeZero: kind === 'st' });
    const x = (v) => m.l + (v - minX) / (maxX - minX) * sc.plotW;
    inner += axisSvg(rows, w, h, m, sc, {
      xScale: x,
      xTicks: chartTicks(minX, maxX, 6),
      xLabel: kind === 'st' ? 't / s（时间）' : 'x',
      yLabel: kind === 'st' ? 's / m（位移或路程）' : 'y',
    });
    if (kind === 'st') {
      const pts = rows.map((row) => `${x(row.x).toFixed(1)},${sc.y(row.value).toFixed(1)}`);
      const baseY = sc.y(0).toFixed(1);
      if (rows.length >= 2) {
        const areaPts = [`${x(rows[0].x).toFixed(1)},${baseY}`, ...pts, `${x(rows[rows.length - 1].x).toFixed(1)},${baseY}`];
        inner += `<polygon points="${areaPts.join(' ')}" class="md-chart-area md-chart-st-area"/>`;
      }
      inner += `<polyline points="${pts.join(' ')}" class="md-chart-line md-chart-st-line"/>`;
    }
    rows.forEach((row, i) => {
      const color = kind === 'st' ? '#0ea5e9' : CHART_COLORS[i % CHART_COLORS.length];
      const fill = kind === 'scatter' ? ` fill="${color}"` : '';
      const px = x(row.x).toFixed(1);
      const py = sc.y(row.value).toFixed(1);
      const pointValue = `(${chartFmt(row.x)}, ${chartFmt(row.value)})`;
      const pointTitle = `${row.label}: ${chartFmt(row.x)}, ${chartFmt(row.value)}`;
      const dataAttrs = `data-chart-label="${esc(row.label)}" data-chart-val="${esc(pointValue)}" data-chart-color="${color}" tabindex="0" role="button" aria-label="${esc(pointTitle)}"`;
      // The clear, non-scaling SVG stroke creates a forgiving ~30px pointer target while
      // the visible dot remains compact. The hit target owns tooltip, click and keyboard focus.
      inner += `<circle cx="${px}" cy="${py}" r="7" fill="transparent" stroke="transparent" stroke-width="28" vector-effect="non-scaling-stroke" pointer-events="stroke" ${dataAttrs} class="md-chart-hit-area"><title>${esc(pointTitle)}</title></circle>`;
      inner += `<circle cx="${px}" cy="${py}" r="${kind === 'st' ? 4.5 : 5.5}"${fill} class="${kind === 'st' ? 'md-chart-dot' : 'md-chart-point'}" pointer-events="none" aria-hidden="true"/>`;
    });
  } else {
    const sc = chartScales(rows, w, h, m, { includeZero: true });
    const xAt = (i) => m.l + (rows.length === 1 ? .5 : i / (rows.length - 1)) * sc.plotW;
    inner += axisSvg(rows, w, h, m, sc, { yLabel: '值', xForIndex: kind === 'line' ? xAt : null });
    if (kind === 'bar') {
      const bw = Math.max(8, sc.plotW / rows.length * .58);
      const zero = sc.y(0);
      rows.forEach((row, i) => {
        const x = m.l + (i + .5) * sc.plotW / rows.length - bw / 2;
        const y = row.value >= 0 ? sc.y(row.value) : zero;
        const hh = Math.max(1, Math.abs(sc.y(row.value) - zero));
        const color = CHART_COLORS[i % CHART_COLORS.length];
        const dataAttrs = `data-chart-label="${esc(row.label)}" data-chart-val="${esc(chartFmt(row.value))}" data-chart-color="${color}" tabindex="0"`;
        inner += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="6" fill="${color}" ${dataAttrs} class="md-chart-bar"><title>${esc(row.label)}: ${esc(row.value)}</title></rect>`;
      });
    } else {
      const pts = rows.map((row, i) => `${xAt(i).toFixed(1)},${sc.y(row.value).toFixed(1)}`);
      const baseY = sc.y(0).toFixed(1);
      if (rows.length >= 2) {
        const areaPts = [`${xAt(0).toFixed(1)},${baseY}`, ...pts, `${xAt(rows.length - 1).toFixed(1)},${baseY}`];
        inner += `<polygon points="${areaPts.join(' ')}" class="md-chart-area"/>`;
      }
      inner += `<polyline points="${pts.join(' ')}" class="md-chart-line"/>`;
      rows.forEach((row, i) => {
        const x = xAt(i);
        const y = sc.y(row.value).toFixed(1);
        const pointValue = chartFmt(row.value);
        const pointTitle = `${row.label}: ${pointValue}`;
        const dataAttrs = `data-chart-label="${esc(row.label)}" data-chart-val="${esc(pointValue)}" data-chart-color="#4f46e5" tabindex="0" role="button" aria-label="${esc(pointTitle)}"`;
        inner += `<circle cx="${x.toFixed(1)}" cy="${y}" r="7" fill="transparent" stroke="transparent" stroke-width="28" vector-effect="non-scaling-stroke" pointer-events="stroke" ${dataAttrs} class="md-chart-hit-area"><title>${esc(pointTitle)}</title></circle>`;
        inner += `<circle cx="${x.toFixed(1)}" cy="${y}" r="4.5" class="md-chart-dot" pointer-events="none" aria-hidden="true"/>`;
      });
    }
  }
  return `<div class="md-chart md-chart-${kind}"><button type="button" class="md-chart-expand" title="全屏查看图表" aria-label="全屏查看图表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg></button><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}" class="md-chart-svg">${inner}</svg><div class="md-chart-tooltip" hidden></div></div>`;
}

export const DIAGRAM_ALIAS = {
  flow: 'flow', flowchart: 'flow', 流程图: 'flow', 流程: 'flow',
  mind: 'mind', mindmap: 'mind', 'mind-map': 'mind', 思维导图: 'mind', 脑图: 'mind',
};
function diagramTextUnits(s) {
  const str = String(s == null ? '' : s);
  let u = 0;
  for (const ch of str) {
    u += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 1 : 0.56;
  }
  return u;
}
function truncateDiagramLabel(s, maxUnits = 18) {
  const str = String(s == null ? '' : s).trim();
  if (diagramTextUnits(str) <= maxUnits) return str;
  let u = 0;
  let out = '';
  for (const ch of str) {
    const step = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 1 : 0.56;
    if (u + step > maxUnits - 0.6) break;
    out += ch;
    u += step;
  }
  return `${out}…`;
}
function diagramBoxWidth(s, fontSize = 12.5, padX = 16, minW = 88, maxW = 250) {
  return Math.min(maxW, Math.max(minW, Math.ceil(diagramTextUnits(s) * fontSize + padX * 2)));
}
export function parseDiagramInfo(info, direct = '') {
  const raw = String(info || '').trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const first = direct || parts.shift() || 'flow';
  const kind = DIAGRAM_ALIAS[first.toLowerCase()] || DIAGRAM_ALIAS[first] || 'flow';
  return { kind, title: direct ? raw : parts.join(' ') };
}
function parseFlowEdges(body) {
  const edges = [];
  const nodeSet = new Set();
  const addNode = (n) => { const s = String(n || '').trim(); if (s) nodeSet.add(s); return s; };
  for (const raw of String(body || '').split('\n')) {
    const line = raw.replace(/^[-*+]\s+/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const marked = line.replace(/\s*(?:-->|->|=>|→)\s*(?:\|([^|]+)\|\s*)?/g, (_, lab) => `\u0001${lab || ''}\u0001`);
    const parts = marked.split('\u0001');
    if (parts.length < 3) { addNode(line); continue; }
    let from = addNode(parts[0]);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const label = parts[i].trim();
      const to = addNode(parts[i + 1]);
      if (from && to) edges.push({ from, to, label });
      from = to;
    }
  }
  return { nodes: [...nodeSet].slice(0, 36), edges: edges.slice(0, 48) };
}
function renderFlowDiagram(body, title = '') {
  const { nodes, edges } = parseFlowEdges(body);
  const label = title || '流程图';
  if (!nodes.length) return `<div class="md-chart-error">流程图数据为空。示例：<code>开始 -> 处理 -> 结束</code></div>`;
  const rank = Object.create(null);
  nodes.forEach((n) => { rank[n] = 0; });
  for (let k = 0; k < nodes.length; k++) {
    let changed = false;
    for (const e of edges) {
      const next = Math.min(nodes.length - 1, (rank[e.from] || 0) + 1);
      if ((rank[e.to] || 0) < next) { rank[e.to] = next; changed = true; }
    }
    if (!changed) break;
  }
  const cols = [];
  for (const n of nodes) {
    const r = Math.max(0, rank[n] || 0);
    (cols[r] ||= []).push(n);
  }
  const nonEmptyCols = cols.filter((c) => c && c.length);
  const boxH = 46, gapX = 68, gapY = 28, padX = 36, topHeader = 64, padBottom = 34;
  const nodeMeta = Object.create(null);
  nodes.forEach((n) => {
    const disp = truncateDiagramLabel(n, 18);
    nodeMeta[n] = { disp, w: diagramBoxWidth(disp, 12.5, 18, 128, 244) };
  });
  const colWidths = nonEmptyCols.map((col) => Math.max(128, ...col.map((n) => nodeMeta[n].w)));
  const colX = [];
  let cursorX = padX;
  for (let ci = 0; ci < nonEmptyCols.length; ci++) {
    colX[ci] = cursorX;
    cursorX += colWidths[ci] + (ci < nonEmptyCols.length - 1 ? gapX : 0);
  }
  const rowCount = Math.max(1, ...nonEmptyCols.map((c) => c.length));
  const contentH = rowCount * boxH + Math.max(0, rowCount - 1) * gapY;
  const w = Math.max(560, cursorX + padX);
  const totalColsW = cursorX - padX;
  const extraShiftX = w > totalColsW + padX * 2 ? (w - (totalColsW + padX * 2)) / 2 : 0;
  const h = Math.max(240, topHeader + contentH + padBottom);
  const pos = Object.create(null);
  nonEmptyCols.forEach((col, ci) => {
    const colH = col.length * boxH + Math.max(0, col.length - 1) * gapY;
    const top = topHeader + (contentH - colH) / 2;
    col.forEach((n, ri) => {
      const nw = nodeMeta[n].w;
      pos[n] = {
        ci,
        ri,
        w: nw,
        h: boxH,
        x: colX[ci] + extraShiftX + (colWidths[ci] - nw) / 2,
        y: top + ri * (boxH + gapY),
      };
    });
  });
  let inner = `<defs><marker id="md-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="md-diagram-arrow"/></marker></defs>`;
  inner += `<text x="${padX}" y="34" class="md-chart-title">${esc(label)}</text>`;
  for (const e of edges) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    let d = '', lx = 0, ly = 0;
    if (b.ci > a.ci) {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2;
      const x2 = b.x, y2 = b.y + b.h / 2;
      const mid = Math.max(20, (x2 - x1) * 0.48);
      d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + mid).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - mid).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      lx = (x1 + x2) / 2;
      ly = (y1 + y2) / 2 - 6;
    } else if (b.ci === a.ci) {
      const down = b.y >= a.y;
      const x1 = a.x + a.w / 2, y1 = down ? a.y + a.h : a.y;
      const x2 = b.x + b.w / 2, y2 = down ? b.y : b.y + b.h;
      d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      lx = (x1 + x2) / 2 + 16;
      ly = (y1 + y2) / 2 + 4;
    } else {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h;
      const x2 = b.x + b.w / 2, y2 = b.y + b.h;
      const dip = Math.max(y1, y2) + 28;
      d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${x1.toFixed(1)} ${dip.toFixed(1)}, ${x2.toFixed(1)} ${dip.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      lx = (x1 + x2) / 2;
      ly = dip - 4;
    }
    inner += `<path d="${d}" class="md-diagram-link" marker-end="url(#md-flow-arrow)"/>`;
    if (e.label) inner += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" class="md-diagram-edge-label">${esc(truncateDiagramLabel(e.label, 14))}</text>`;
  }
  nodes.forEach((n, i) => {
    const p = pos[n];
    if (!p) return;
    const fill = `md-diagram-node-${i % 6}`;
    inner += `<g class="md-diagram-node ${fill}"><rect x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" width="${p.w.toFixed(1)}" height="${p.h}" rx="14"/><text x="${(p.x + p.w / 2).toFixed(1)}" y="${(p.y + p.h / 2 + 5).toFixed(1)}" text-anchor="middle">${esc(nodeMeta[n].disp)}</text></g>`;
  });
  return `<div class="md-diagram md-diagram-flow"><button type="button" class="md-chart-expand" title="全屏查看图表" aria-label="全屏查看图表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg></button><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}" class="md-chart-svg md-diagram-svg">${inner}</svg></div>`;
}
function parseMindTree(body, title = '') {
  const lines = String(body || '').split('\n').filter((x) => x.trim() && !x.trim().startsWith('#'));
  let root = title || '';
  const rootNode = { label: root || '中心主题', children: [] };
  const stack = [rootNode];
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const m = /^(\s*)(?:[-*+]\s+)?(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const hasBullet = /^\s*[-*+]\s+/.test(raw);
    const text = m[2].trim();
    if (!hasBullet && !root && idx === 0) { rootNode.label = text; root = text; continue; }
    const depth = hasBullet ? Math.max(1, Math.floor(m[1].replace(/\t/g, '  ').length / 2) + 1) : 1;
    const node = { label: text, children: [] };
    const parent = stack[Math.max(0, depth - 1)] || rootNode;
    parent.children.push(node);
    stack[depth] = node;
    stack.length = depth + 1;
  }
  if (!rootNode.children.length && lines.length && root) {
    lines.slice(1).forEach((x) => rootNode.children.push({ label: x.replace(/^\s*[-*+]\s+/, '').trim(), children: [] }));
  }
  return rootNode;
}
function renderMindDiagram(body, title = '') {
  const tree = parseMindTree(body, title);
  const kids = tree.children.slice(0, 12);
  const rootDisp = truncateDiagramLabel(tree.label, 16);
  const rw = diagramBoxWidth(rootDisp, 13.5, 22, 124, 240);
  const rh = 48;
  const leafStep = 38;
  const branchGap = 24;
  const gapRootBranch = 52;
  const gapBranchLeaf = 44;

  const prepared = kids.map((kid, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const bDisp = truncateDiagramLabel(kid.label, 16);
    const bw = diagramBoxWidth(bDisp, 12.5, 16, 92, 216);
    const bh = 38;
    const leaves = (kid.children || []).slice(0, 8).map((ch) => {
      const lDisp = truncateDiagramLabel(ch.label, 18);
      return {
        node: ch,
        disp: lDisp,
        gw: diagramBoxWidth(lDisp, 11.5, 14, 86, 240),
        gh: 30,
      };
    });
    const leavesSpan = leaves.length ? (leaves.length - 1) * leafStep + 30 : 0;
    const subH = Math.max(bh, leavesSpan);
    return { kid, i, side, bDisp, bw, bh, leaves, subH };
  });

  const nodes = [{ node: tree, disp: rootDisp, x: 0, y: 0, w: rw, h: rh, cls: 'root' }];
  const links = [];

  for (const side of [-1, 1]) {
    const group = prepared.filter((item) => item.side === side);
    if (!group.length) continue;
    const totalSideH = group.reduce((sum, it) => sum + it.subH, 0) + Math.max(0, group.length - 1) * branchGap;
    let cursorY = -totalSideH / 2;
    for (const item of group) {
      const by = cursorY + item.subH / 2;
      const bx = side * (rw / 2 + gapRootBranch + item.bw / 2);
      const colorCls = `branch-${item.i % 6}`;
      nodes.push({ node: item.kid, disp: item.bDisp, x: bx, y: by, w: item.bw, h: item.bh, cls: `branch ${colorCls}` });
      links.push({ x1: side * (rw / 2), y1: 0, x2: bx - side * (item.bw / 2), y2: by });
      item.leaves.forEach((lf, j, arr) => {
        const gy = by + (j - (arr.length - 1) / 2) * leafStep;
        const gx = bx + side * (item.bw / 2 + gapBranchLeaf + lf.gw / 2);
        nodes.push({ node: lf.node, disp: lf.disp, x: gx, y: gy, w: lf.gw, h: lf.gh, cls: `leaf ${colorCls}` });
        links.push({ x1: bx + side * (item.bw / 2), y1: by, x2: gx - side * (lf.gw / 2), y2: gy });
      });
      cursorY += item.subH + branchGap;
    }
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const it of nodes) {
    minX = Math.min(minX, it.x - it.w / 2);
    maxX = Math.max(maxX, it.x + it.w / 2);
    minY = Math.min(minY, it.y - it.h / 2);
    maxY = Math.max(maxY, it.y + it.h / 2);
  }
  const padX = 34, topHeader = 58, padBottom = 30;
  const rawW = maxX - minX + padX * 2;
  const rawH = maxY - minY + topHeader + padBottom;
  const w = Math.max(680, Math.ceil(rawW));
  const h = Math.max(300, Math.ceil(rawH));
  const shiftX = -minX + padX + Math.max(0, (w - rawW) / 2);
  const shiftY = -minY + topHeader + Math.max(0, (h - rawH) / 2);

  let inner = `<text x="34" y="34" class="md-chart-title">${esc(title || '思维导图')}</text>`;
  for (const l of links) {
    const x1 = l.x1 + shiftX, y1 = l.y1 + shiftY;
    const x2 = l.x2 + shiftX, y2 = l.y2 + shiftY;
    const dx = (x2 - x1) * 0.48;
    inner += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}" class="md-diagram-link md-mind-link"/>`;
  }
  for (const it of nodes) {
    const cx = it.x + shiftX;
    const cy = it.y + shiftY;
    inner += `<g class="md-mind-node ${it.cls}"><rect x="${(cx - it.w / 2).toFixed(1)}" y="${(cy - it.h / 2).toFixed(1)}" width="${it.w.toFixed(1)}" height="${it.h}" rx="${Math.min(22, it.h / 2)}"/><text x="${cx.toFixed(1)}" y="${(cy + 4.5).toFixed(1)}" text-anchor="middle">${esc(it.disp)}</text></g>`;
  }
  return `<div class="md-diagram md-diagram-mind"><button type="button" class="md-chart-expand" title="全屏查看图表" aria-label="全屏查看图表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg></button><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title || tree.label || '思维导图')}" class="md-chart-svg md-diagram-svg">${inner}</svg></div>`;
}
export function renderQuickDiagram(kind, body, title = '') {
  return kind === 'mind' ? renderMindDiagram(body, title) : renderFlowDiagram(body, title);
}
