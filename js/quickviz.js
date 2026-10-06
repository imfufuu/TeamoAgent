// Dubhe Agent · 快捷可视化（从 ui.js 拆出，V1.7.1；2026.10.5.19 扩展为 14 类统计图）
// Markdown 围栏里的 :::chart（柱状 / 条形 / 折线 / 面积 / 饼 / 环形 / 堆叠 / 直方 / 箱线 / 散点 / 气泡 / 漏斗 / 桑基 / 地图）
// 与 :::diagram（流程 / 思维导图）直接渲染为内联 SVG，不依赖 DOM 以外的任何运行时；纯函数、可单测。
// 地图是唯一的例外：地理边界（assets/geo/*.json）体积较大，渲染函数先输出占位，由 ui.js 异步取回边界后再调 renderGeoMapSvg 填充。
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const CHART_ALIAS = {
  bar: 'bar', bars: 'bar', column: 'bar', 柱状图: 'bar', 柱状: 'bar', 柱形图: 'bar', 柱图: 'bar',
  barh: 'barh', hbar: 'barh', 'bar-h': 'barh', 条形图: 'barh', 条形: 'barh', 横向柱状图: 'barh', 水平柱状图: 'barh',
  line: 'line', lines: 'line', 折线图: 'line', 折线: 'line', 趋势图: 'line',
  area: 'area', 面积图: 'area', 面积: 'area',
  pie: 'pie', 饼图: 'pie', 饼: 'pie', 饼状图: 'pie',
  donut: 'donut', doughnut: 'donut', ring: 'donut', 环形图: 'donut', 环图: 'donut', 圆环图: 'donut', 甜甜圈图: 'donut',
  stacked: 'stacked', stack: 'stacked', 'stacked-bar': 'stacked', stackedbar: 'stacked', 堆叠图: 'stacked', 堆叠柱状图: 'stacked', 堆积图: 'stacked', 堆积柱状图: 'stacked',
  'stacked-area': 'stackedarea', stackedarea: 'stackedarea', 堆叠面积图: 'stackedarea', 堆积面积图: 'stackedarea',
  histogram: 'histogram', hist: 'histogram', 直方图: 'histogram', 直方: 'histogram',
  boxplot: 'boxplot', box: 'boxplot', 'box-plot': 'boxplot', 箱线图: 'boxplot', 箱型图: 'boxplot', 箱形图: 'boxplot', 盒须图: 'boxplot',
  scatter: 'scatter', scat: 'scatter', 散点图: 'scatter', 散点: 'scatter',
  bubble: 'bubble', 气泡图: 'bubble', 气泡: 'bubble',
  funnel: 'funnel', 漏斗图: 'funnel', 漏斗: 'funnel',
  sankey: 'sankey', 桑基图: 'sankey', 桑吉图: 'sankey', 桑基: 'sankey',
  map: 'map', geo: 'map', choropleth: 'map', 地图: 'map', 世界地图: 'map', 中国地图: 'map', 热力地图: 'map',
};
export const CHART_KINDS = ['bar', 'barh', 'line', 'area', 'pie', 'donut', 'stacked', 'stackedarea', 'histogram', 'boxplot', 'scatter', 'bubble', 'funnel', 'sankey', 'map'];
export const CHART_KIND_LABEL = {
  bar: '柱状图', barh: '条形图', line: '折线图', area: '面积图', pie: '饼图', donut: '环形图', stacked: '堆叠图', stackedarea: '堆叠面积图',
  histogram: '直方图', boxplot: '箱线图', scatter: '散点图', bubble: '气泡图', funnel: '漏斗图', sankey: '桑基图', map: '地图',
};
// 直接写在 ::: 后面的别名（ui.js 正则与 parseChartInfo 共用），例如 :::柱状图 标题
export const CHART_DIRECT_ALIASES = Object.keys(CHART_ALIAS).filter((k) => k !== 'map' && k !== 'box' && k !== 'ring' && k !== 'geo' && k !== 'stack' && k !== 'column' && k !== 'lines');
const CHART_COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#f97316', '#84cc16', '#ec4899', '#6366f1', '#06b6d4'];
const colorAt = (i) => CHART_COLORS[((i % CHART_COLORS.length) + CHART_COLORS.length) % CHART_COLORS.length];
const chartNum = (s) => {
  const txt = String(s ?? '').replace(/[％%,，]/g, '').trim();
  if (!txt) return null;
  const m = txt.match(/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?/i);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
};
const chartFmt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1e6) return `${Number((n / 1e6).toFixed(2))}M`;
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return Number(n.toFixed(1)).toString();
  return Number(n.toFixed(2)).toString();
};
const pctFmt = (part, total) => `${Math.round((total ? part / total : 0) * 100)}%`;
const f1 = (n) => Number(n).toFixed(1);
const splitChartLine = (line) => String(line || '').split(/[,\t|，、]+|\s{2,}|\s*[:：]\s*/).map((x) => x.trim()).filter(Boolean);
const CHINA_REGION_RE = /^(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆|内蒙古|香港|澳门|台湾)/;
const OPTION_RE = /^(bins|map|sort|unit|stack|legend|labels|xlabel|ylabel|x|y)\s*[=＝]\s*(\S+)$/i;
const MAP_WORD_RE = /^(world|china|世界|中国|世界地图|中国地图|全球)$/i;
// 标题里可以混写少量选项：bins=8 / map=china / world / china / xlabel=… / ylabel=…
export function parseChartOptions(title) {
  const opts = {};
  const rest = [];
  for (const tok of String(title || '').trim().split(/\s+/)) {
    if (!tok) continue;
    const m = OPTION_RE.exec(tok);
    if (m) { opts[m[1].toLowerCase()] = m[2]; continue; }
    if (MAP_WORD_RE.test(tok)) { opts.map = /china|中国/i.test(tok) ? 'china' : 'world'; continue; }
    rest.push(tok);
  }
  return { opts, title: rest.join(' ') };
}
export function parseChartInfo(info, directKind = '') {
  const raw = String(info || '').trim();
  if (directKind) return { kind: CHART_ALIAS[directKind] || CHART_ALIAS[directKind.toLowerCase()] || 'bar', title: raw };
  const parts = raw.split(/\s+/).filter(Boolean);
  const first = parts.shift() || 'bar';
  const kind = CHART_ALIAS[first.toLowerCase()] || CHART_ALIAS[first] || 'bar';
  return { kind, title: parts.join(' ') };
}
const cleanLines = (body) => String(body || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !/^[-|\s:]+$/.test(l));
const isHeaderCells = (cells) => cells.length >= 2 && cells.slice(1).every((c) => chartNum(c) == null);
// 通用表格：可选表头行（第一列为维度名、其余为系列名），数据行「标签, v1, v2, …」
function parseTable(body) {
  const lines = cleanLines(body);
  let series = [];
  let dim = '';
  if (lines.length && isHeaderCells(splitChartLine(lines[0]))) {
    const head = splitChartLine(lines.shift());
    dim = head[0];
    series = head.slice(1);
  } else if (lines.length && /^(label|name|x|t|time|时间|类别|标签)\s*[,|\t:：]/i.test(lines[0])) {
    lines.shift();
  }
  const rows = [];
  for (const line of lines) {
    const cells = splitChartLine(line);
    let label = '', values = [];
    if (cells.length >= 2) { label = cells[0]; values = cells.slice(1).map(chartNum); }
    if (!values.length || values[0] == null) {
      const m = /^(.*?)[\s,，|:：]+([-+]?\d+(?:\.\d+)?%?)\s*$/.exec(line);
      if (m) { label = m[1].trim(); values = [chartNum(m[2])]; }
    }
    values = values.filter((v) => v != null);
    if (label && values.length) rows.push({ label, values, value: values[0] });
  }
  const width = rows.reduce((n, r) => Math.max(n, r.values.length), 0);
  if (!series.length) series = width > 1 ? Array.from({ length: width }, (_, i) => `系列${i + 1}`) : [''];
  return { dim, series: series.slice(0, Math.max(1, width) || 1), rows: rows.slice(0, 48) };
}
// 散点 / 气泡：「x, y」「标签, x, y」「x, y, size」「标签, x, y, size」
function parsePoints(body, withSize) {
  const lines = cleanLines(body);
  if (lines.length && isHeaderCells(splitChartLine(lines[0]))) lines.shift();
  const out = [];
  for (const line of lines) {
    const cells = splitChartLine(line);
    const nums = cells.map(chartNum);
    const need = withSize ? 3 : 2;
    if (nums.length >= need && nums.slice(0, need).every((n) => n != null)) {
      out.push({ label: String(out.length + 1), x: nums[0], y: nums[1], size: withSize ? nums[2] : null, series: cells[need] && nums[need] == null ? cells[need] : '' });
    } else if (cells.length >= need + 1 && nums.slice(1, need + 1).every((n) => n != null)) {
      out.push({ label: cells[0], x: nums[1], y: nums[2], size: withSize ? nums[3] : null, series: cells[need + 1] && nums[need + 1] == null ? cells[need + 1] : '' });
    }
  }
  return out.slice(0, 400);
}
// 桑基：「A -> B, 值」「A, B, 值」「A → B 值」
function parseLinks(body) {
  const links = [];
  for (const line of cleanLines(body)) {
    let m = /^(.+?)\s*(?:->|→|=>|－>|—>)\s*(.+?)\s*[,，:：|\s]\s*([-+]?\d+(?:\.\d+)?)\s*$/.exec(line);
    let a, b, v;
    if (m) { a = m[1]; b = m[2]; v = chartNum(m[3]); } else {
      const cells = splitChartLine(line);
      if (cells.length >= 3 && chartNum(cells[2]) != null && chartNum(cells[1]) == null) { a = cells[0]; b = cells[1]; v = chartNum(cells[2]); }
    }
    if (a && b && v != null && v > 0 && a !== b) links.push({ source: a.trim(), target: b.trim(), value: v });
  }
  return links.slice(0, 120);
}
function parseNumbers(body) {
  const out = [];
  for (const line of cleanLines(body)) {
    for (const cell of splitChartLine(line)) { const n = chartNum(cell); if (n != null) out.push(n); }
  }
  return out.slice(0, 5000);
}
function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  for (const k of [1, 2, 2.5, 5, 10]) if (raw <= k * mag) return k * mag;
  return 10 * mag;
}
function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) return [min];
  const step = niceStep(max - min, count);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out.length >= 2 ? out : [min, max];
}
function linearScale(values, { includeZero = true, pad = 0 } = {}) {
  let min = Math.min(includeZero ? 0 : Infinity, ...values);
  let max = Math.max(includeZero ? 0 : -Infinity, ...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (min === max) { min -= 1; max += 1; }
  if (pad) { const p = (max - min) * pad; min -= p; max += p; }
  const ticks = niceTicks(min, max, 5);
  min = Math.min(min, ticks[0]); max = Math.max(max, ticks[ticks.length - 1]);
  return { min, max, ticks };
}
// 画布与边距：所有图共享 720×392，左边距随首个旋转标签宽度自适应
function frame(opts = {}) {
  const w = 720, h = 392;
  const m = { l: opts.left || 76, r: opts.right || 44, t: opts.legend ? 78 : 58, b: opts.bottom || 86 };
  return { w, h, m, plotW: w - m.l - m.r, plotH: h - m.t - m.b };
}
const titleSvg = (label, m) => `<text x="${m.l}" y="34" stroke="none" class="md-chart-title">${esc(label)}</text>`;
function legendSvg(series, w, m, y = 56) {
  if (!series || series.length < 2) return '';
  let x = w - m.r;
  const items = [];
  for (let i = series.length - 1; i >= 0; i--) {
    const name = truncateDiagramLabel(series[i], 10);
    const tw = diagramTextUnits(name) * 10.5 + 22;
    x -= tw;
    items.push(`<g class="md-chart-legend-item"><rect x="${f1(x)}" y="${y - 8}" width="10" height="10" rx="3" fill="${colorAt(i)}"/><text x="${f1(x + 15)}" y="${y + 1}" stroke="none" class="md-chart-tick md-chart-legend">${esc(name)}</text></g>`);
    x -= 10;
  }
  return items.join('');
}
function yAxisSvg(fr, sc, yScale, opts = {}) {
  const { m, w, h } = fr;
  const bits = [];
  const plotBottom = h - m.b, plotRight = w - m.r;
  for (const v of sc.ticks) {
    const y = yScale(v);
    bits.push(`<line x1="${m.l}" y1="${f1(y)}" x2="${plotRight}" y2="${f1(y)}" class="md-chart-grid"/>`);
    bits.push(`<text x="${m.l - 10}" y="${f1(y + 4)}" text-anchor="end" stroke="none" class="md-chart-tick">${esc(chartFmt(v))}</text>`);
  }
  bits.push(`<line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${plotBottom}" class="md-chart-axis"/>`);
  bits.push(`<line x1="${m.l}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" class="md-chart-axis"/>`);
  if (opts.yLabel) bits.push(`<text x="18" y="${f1((m.t + plotBottom) / 2)}" text-anchor="middle" stroke="none" transform="rotate(-90 18 ${f1((m.t + plotBottom) / 2)})" class="md-chart-axis-label">${esc(opts.yLabel)}</text>`);
  if (opts.xLabel) bits.push(`<text x="${f1((m.l + plotRight) / 2)}" y="${h - 14}" text-anchor="middle" stroke="none" class="md-chart-axis-label">${esc(opts.xLabel)}</text>`);
  return bits.join('');
}
function categoryTicksSvg(fr, labels, xForIndex) {
  const { m, h } = fr;
  const plotBottom = h - m.b;
  const step = Math.max(1, Math.ceil(labels.length / 8));
  const bits = [];
  labels.forEach((label, i) => {
    if (i % step) return;
    const x = xForIndex(i);
    const text = truncateDiagramLabel(label, 12);
    const rot = labels.length > 6 || diagramTextUnits(text) > 4.5;
    bits.push(`<text x="${f1(x)}" y="${plotBottom + 20}" text-anchor="${rot ? 'end' : 'middle'}" stroke="none" class="md-chart-tick"${rot ? ` transform="rotate(-25 ${f1(x)} ${plotBottom + 20})"` : ''}>${esc(text)}</text>`);
  });
  return bits.join('');
}
function numericXTicksSvg(fr, ticks, xScale) {
  const { m, h } = fr;
  const plotBottom = h - m.b;
  return ticks.map((v) => {
    const x = f1(xScale(v));
    return `<line x1="${x}" y1="${plotBottom}" x2="${x}" y2="${plotBottom + 5}" class="md-chart-axis"/><text x="${x}" y="${plotBottom + 20}" text-anchor="middle" stroke="none" class="md-chart-tick">${esc(chartFmt(v))}</text>`;
  }).join('');
}
function leftMarginFor(labels, kind) {
  if (!labels.length) return 76;
  const firstText = truncateDiagramLabel(labels[0], 12);
  const rot = labels.length > 6 || diagramTextUnits(firstText) > 4.5;
  if (!rot || !['line', 'bar', 'area', 'stacked', 'stackedarea', 'boxplot', 'histogram'].includes(kind)) return 76;
  return Math.max(76, Math.ceil(diagramTextUnits(firstText) * 10.5 * 0.9 + 18));
}
const datumAttrs = (label, val, color, extra = '') => `data-chart-label="${esc(label)}" data-chart-val="${esc(val)}" data-chart-color="${color}"${extra} tabindex="0"`;
const hitDot = (px, py, label, val, color, dotClass, r = 4.5, fill = '') => {
  const title = `${label}: ${val}`;
  return `<circle cx="${px}" cy="${py}" r="7" fill="transparent" stroke="transparent" stroke-width="28" vector-effect="non-scaling-stroke" pointer-events="stroke" ${datumAttrs(label, val, color, ` role="button" aria-label="${esc(title)}"`)} class="md-chart-hit-area"><title>${esc(title)}</title></circle>`
    + `<circle cx="${px}" cy="${py}" r="${r}"${fill} class="${dotClass}" pointer-events="none" aria-hidden="true"/>`;
};
const wrap = (kind, label, w, h, inner, extraAttrs = '') => `<div class="md-chart md-chart-${kind}"${extraAttrs}><button type="button" class="md-chart-expand" title="全屏查看图表" aria-label="全屏查看图表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg></button><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}" class="md-chart-svg">${inner}</svg><div class="md-chart-tooltip" hidden></div></div>`;
const emptyChart = (sample) => `<div class="md-chart-error">图表数据为空。示例：${sample}</div>`;
const CHART_SAMPLE = {
  bar: '<code>一月, 12</code>', barh: '<code>华东, 120</code>', line: '<code>一月, 12</code>', area: '<code>一月, 12</code>', pie: '<code>A 类, 40</code>', donut: '<code>A 类, 40</code>',
  stacked: '<code>季度, 产品A, 产品B</code><br><code>Q1, 10, 20</code>', stackedarea: '<code>月份, 移动端, 桌面端</code><br><code>一月, 10, 20</code>',
  histogram: '<code>3.2, 4.1, 5.0, 4.4 …</code>', boxplot: '<code>甲组, 12, 15, 11, 19, 14</code>', scatter: '<code>0, 1</code><br><code>1, 3</code>',
  bubble: '<code>北京, 12, 30, 80</code>（标签, x, y, 大小）', funnel: '<code>访问, 1000</code><br><code>下单, 120</code>', sankey: '<code>煤炭 -> 发电, 50</code>', map: '<code>广东, 126</code> 或 <code>China, 1400</code>',
};
// ---------- 各类图形 ----------
function renderBars(kind, table, label, opts) {
  const { rows, series } = table;
  const multi = series.length > 1;
  const fr = frame({ left: leftMarginFor(rows.map((r) => r.label), 'bar'), legend: multi });
  const { m, w, h } = fr;
  const vals = rows.flatMap((r) => r.values);
  const sc = linearScale(vals, { includeZero: true });
  const y = (v) => m.t + (sc.max - v) / (sc.max - sc.min) * fr.plotH;
  let inner = titleSvg(label, m) + legendSvg(series, w, m) + yAxisSvg(fr, sc, y, { yLabel: opts.ylabel || '值', xLabel: opts.xlabel || table.dim });
  const slot = fr.plotW / Math.max(1, rows.length);
  inner += categoryTicksSvg(fr, rows.map((r) => r.label), (i) => m.l + (i + .5) * slot);
  const groupW = Math.max(8, slot * .66);
  const bw = multi ? Math.max(4, (groupW - (series.length - 1) * 2) / series.length) : Math.max(8, slot * .58);
  const zero = y(0);
  rows.forEach((row, i) => {
    series.forEach((name, s) => {
      const v = row.values[s];
      if (v == null) return;
      const x = multi ? m.l + (i + .5) * slot - groupW / 2 + s * (bw + 2) : m.l + (i + .5) * slot - bw / 2;
      const top = v >= 0 ? y(v) : zero;
      const hh = Math.max(1, Math.abs(y(v) - zero));
      const color = multi ? colorAt(s) : colorAt(i);
      const lbl = multi ? `${name} · ${row.label}` : row.label;
      inner += `<rect x="${f1(x)}" y="${f1(top)}" width="${f1(bw)}" height="${f1(hh)}" rx="${multi ? 3 : 6}" fill="${color}" ${datumAttrs(lbl, chartFmt(v), color)} class="md-chart-bar"><title>${esc(lbl)}: ${esc(v)}</title></rect>`;
    });
  });
  return wrap(kind, label, w, h, inner);
}
function renderBarsH(table, label, opts) {
  const { rows, series } = table;
  const multi = series.length > 1;
  const longest = rows.reduce((n, r) => Math.max(n, diagramTextUnits(truncateDiagramLabel(r.label, 14))), 0);
  const fr = frame({ left: Math.min(230, Math.max(90, Math.ceil(longest * 10.5 + 26))), legend: multi, bottom: 56 });
  const { m, w, h } = fr;
  const vals = rows.flatMap((r) => r.values);
  const sc = linearScale(vals, { includeZero: true });
  const x = (v) => m.l + (v - sc.min) / (sc.max - sc.min) * fr.plotW;
  const plotBottom = h - m.b;
  let inner = titleSvg(label, m) + legendSvg(series, w, m);
  for (const v of sc.ticks) {
    inner += `<line x1="${f1(x(v))}" y1="${m.t}" x2="${f1(x(v))}" y2="${plotBottom}" class="md-chart-grid"/>`;
    inner += `<text x="${f1(x(v))}" y="${plotBottom + 20}" text-anchor="middle" stroke="none" class="md-chart-tick">${esc(chartFmt(v))}</text>`;
  }
  inner += `<line x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${plotBottom}" class="md-chart-axis"/><line x1="${m.l}" y1="${plotBottom}" x2="${w - m.r}" y2="${plotBottom}" class="md-chart-axis"/>`;
  if (opts.xlabel) inner += `<text x="${f1((m.l + w - m.r) / 2)}" y="${h - 12}" text-anchor="middle" stroke="none" class="md-chart-axis-label">${esc(opts.xlabel)}</text>`;
  const slot = fr.plotH / Math.max(1, rows.length);
  const groupH = Math.max(6, slot * .66);
  const bh = multi ? Math.max(3, (groupH - (series.length - 1) * 2) / series.length) : Math.max(6, slot * .58);
  const zero = x(0);
  rows.forEach((row, i) => {
    const cy = m.t + (i + .5) * slot;
    inner += `<text x="${m.l - 10}" y="${f1(cy + 4)}" text-anchor="end" stroke="none" class="md-chart-tick">${esc(truncateDiagramLabel(row.label, 14))}</text>`;
    series.forEach((name, s) => {
      const v = row.values[s];
      if (v == null) return;
      const yTop = multi ? cy - groupH / 2 + s * (bh + 2) : cy - bh / 2;
      const left = v >= 0 ? zero : x(v);
      const ww = Math.max(1, Math.abs(x(v) - zero));
      const color = multi ? colorAt(s) : colorAt(i);
      const lbl = multi ? `${name} · ${row.label}` : row.label;
      inner += `<rect x="${f1(left)}" y="${f1(yTop)}" width="${f1(ww)}" height="${f1(bh)}" rx="${multi ? 3 : 5}" fill="${color}" ${datumAttrs(lbl, chartFmt(v), color)} class="md-chart-bar"><title>${esc(lbl)}: ${esc(v)}</title></rect>`;
      if (!multi && ww > 0) inner += `<text x="${f1(Math.max(left, zero) + ww + 6)}" y="${f1(cy + 4)}" stroke="none" class="md-chart-label" pointer-events="none">${esc(chartFmt(v))}</text>`;
    });
  });
  return wrap('barh', label, w, h, inner);
}
function renderLines(kind, table, label, opts) {
  const { rows, series } = table;
  const multi = series.length > 1;
  const stacked = kind === 'stackedarea';
  const fr = frame({ left: leftMarginFor(rows.map((r) => r.label), 'line'), legend: multi });
  const { m, w, h } = fr;
  const stacks = rows.map((r) => { let acc = 0; return r.values.map((v) => (acc += v)); });
  const vals = stacked ? stacks.flat() : rows.flatMap((r) => r.values);
  const sc = linearScale(vals, { includeZero: true });
  const y = (v) => m.t + (sc.max - v) / (sc.max - sc.min) * fr.plotH;
  const xAt = (i) => m.l + (rows.length === 1 ? .5 : i / (rows.length - 1)) * fr.plotW;
  let inner = titleSvg(label, m) + legendSvg(series, w, m) + yAxisSvg(fr, sc, y, { yLabel: opts.ylabel || '值', xLabel: opts.xlabel || table.dim });
  inner += categoryTicksSvg(fr, rows.map((r) => r.label), xAt);
  const baseY = f1(y(0));
  const area = kind === 'area' || stacked;
  // 面积 / 堆叠面积从上层画到下层，保证下层不被遮挡
  const order = series.map((_, s) => s);
  if (stacked) order.reverse();
  for (const s of order) {
    const color = multi ? colorAt(s) : '#4f46e5';
    const valAt = (i) => (stacked ? stacks[i][s] : rows[i].values[s]);
    const pts = rows.map((row, i) => (valAt(i) == null ? null : `${f1(xAt(i))},${f1(y(valAt(i)))}`)).filter(Boolean);
    if (rows.length >= 2 && (area || !multi)) {
      let lower;
      if (stacked && s > 0) lower = rows.map((row, i) => `${f1(xAt(i))},${f1(y(stacks[i][s - 1]))}`).reverse();
      else lower = [`${f1(xAt(rows.length - 1))},${baseY}`, `${f1(xAt(0))},${baseY}`];
      const style = multi ? ` style="fill:${color};fill-opacity:${stacked ? .55 : .18}"` : '';
      inner += `<polygon points="${[...pts, ...lower].join(' ')}" class="md-chart-area"${style}/>`;
    }
    inner += `<polyline points="${pts.join(' ')}" class="md-chart-line"${multi ? ` style="stroke:${color}"` : ''}/>`;
  }
  rows.forEach((row, i) => {
    series.forEach((name, s) => {
      const v = row.values[s];
      if (v == null) return;
      const color = multi ? colorAt(s) : '#4f46e5';
      const lbl = multi ? `${name} · ${row.label}` : row.label;
      const py = f1(y(stacked ? stacks[i][s] : v));
      inner += hitDot(f1(xAt(i)), py, lbl, chartFmt(v), color, 'md-chart-dot', 4.5, multi ? ` style="stroke:${color}"` : '');
    });
  });
  return wrap(kind, label, w, h, inner);
}
function renderStackedBars(table, label, opts) {
  const { rows, series } = table;
  const fr = frame({ left: leftMarginFor(rows.map((r) => r.label), 'bar'), legend: series.length > 1 });
  const { m, w, h } = fr;
  const totals = rows.map((r) => r.values.reduce((a, b) => a + Math.max(0, b), 0));
  const sc = linearScale(totals, { includeZero: true });
  const y = (v) => m.t + (sc.max - v) / (sc.max - sc.min) * fr.plotH;
  let inner = titleSvg(label, m) + legendSvg(series, w, m) + yAxisSvg(fr, sc, y, { yLabel: opts.ylabel || '值', xLabel: opts.xlabel || table.dim });
  const slot = fr.plotW / Math.max(1, rows.length);
  inner += categoryTicksSvg(fr, rows.map((r) => r.label), (i) => m.l + (i + .5) * slot);
  const bw = Math.max(8, slot * .58);
  rows.forEach((row, i) => {
    let acc = 0;
    const x = m.l + (i + .5) * slot - bw / 2;
    series.forEach((name, s) => {
      const v = Math.max(0, row.values[s] ?? 0);
      if (!v) return;
      const top = y(acc + v), hh = Math.max(1, y(acc) - y(acc + v));
      const color = colorAt(s);
      const lbl = `${name} · ${row.label}`;
      inner += `<rect x="${f1(x)}" y="${f1(top)}" width="${f1(bw)}" height="${f1(hh)}" rx="2" fill="${color}" ${datumAttrs(lbl, chartFmt(v), color, ` data-chart-pct="${pctFmt(v, totals[i])}"`)} class="md-chart-bar"><title>${esc(lbl)}: ${esc(v)} (${pctFmt(v, totals[i])})</title></rect>`;
      acc += v;
    });
    inner += `<text x="${f1(x + bw / 2)}" y="${f1(y(acc) - 6)}" text-anchor="middle" stroke="none" class="md-chart-label" pointer-events="none">${esc(chartFmt(acc))}</text>`;
  });
  return wrap('stacked', label, w, h, inner);
}
function renderPie(kind, table, label) {
  const rows = table.rows.filter((r) => r.value > 0);
  const donut = kind === 'donut';
  const fr = frame();
  const { m, w, h } = fr;
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  const cx = w / 2, cy = h / 2 + 14, r = 102, r0 = donut ? 58 : 0;
  let a0 = -Math.PI / 2;
  let inner = titleSvg(label, m);
  const pieLabels = [];
  rows.forEach((row, i) => {
    const a1 = a0 + (row.value / total) * Math.PI * 2;
    const color = colorAt(i);
    const pct = pctFmt(row.value, total);
    const attrs = `${datumAttrs(row.label, chartFmt(row.value), color, ` data-chart-pct="${pct}"`)} class="md-chart-slice"`;
    const t = `<title>${esc(row.label)}: ${esc(row.value)} (${pct})</title>`;
    if (a1 - a0 >= Math.PI * 1.999) {
      inner += donut
        ? `<path d="M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z M ${cx} ${cy - r0} A ${r0} ${r0} 0 1 0 ${cx - 0.01} ${cy - r0} Z" fill-rule="evenodd" fill="${color}" ${attrs}>${t}</path>`
        : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" ${attrs}>${t}</circle>`;
    } else {
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const d = donut
        ? `M ${f1(x0)} ${f1(y0)} A ${r} ${r} 0 ${large} 1 ${f1(x1)} ${f1(y1)} L ${f1(cx + r0 * Math.cos(a1))} ${f1(cy + r0 * Math.sin(a1))} A ${r0} ${r0} 0 ${large} 0 ${f1(cx + r0 * Math.cos(a0))} ${f1(cy + r0 * Math.sin(a0))} Z`
        : `M ${cx} ${cy} L ${f1(x0)} ${f1(y0)} A ${r} ${r} 0 ${large} 1 ${f1(x1)} ${f1(y1)} Z`;
      inner += `<path d="${d}" fill="${color}" ${attrs}>${t}</path>`;
    }
    const mid = (a0 + a1) / 2;
    const rightSide = Math.cos(mid) >= 0;
    pieLabels.push({ rightSide, lx: Math.max(24, Math.min(w - 24, cx + (r + 36) * Math.cos(mid))), ly: Math.max(54, Math.min(h - 18, cy + (r + 32) * Math.sin(mid))), text: `${truncateDiagramLabel(row.label, 12)} ${pct}` });
    a0 = a1;
  });
  for (const side of [true, false]) {
    const group = pieLabels.filter((p) => p.rightSide === side).sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < group.length; i++) if (group[i].ly - group[i - 1].ly < 18) group[i].ly = Math.min(h - 16, group[i - 1].ly + 18);
  }
  for (const pl of pieLabels) inner += `<text x="${f1(pl.lx)}" y="${f1(pl.ly)}" text-anchor="${pl.rightSide ? 'start' : 'end'}" class="md-chart-label">${esc(pl.text)}</text>`;
  if (donut) {
    inner += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" stroke="none" class="md-chart-donut-total">${esc(chartFmt(total))}</text><text x="${cx}" y="${cy + 14}" text-anchor="middle" stroke="none" class="md-chart-tick">合计</text>`;
  }
  return wrap(kind, label, w, h, inner);
}
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export function boxStats(values) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const q1 = quantile(s, .25), med = quantile(s, .5), q3 = quantile(s, .75), iqr = q3 - q1;
  const loFence = q1 - 1.5 * iqr, hiFence = q3 + 1.5 * iqr;
  const inside = s.filter((v) => v >= loFence && v <= hiFence);
  return { min: s[0], max: s[s.length - 1], q1, med, q3, lo: inside[0] ?? s[0], hi: inside[inside.length - 1] ?? s[s.length - 1], outliers: s.filter((v) => v < loFence || v > hiFence), n: s.length };
}
function renderBoxplot(table, label, opts) {
  const groups = table.rows.map((r) => ({ label: r.label, st: boxStats(r.values) })).filter((g) => g.st);
  const fr = frame({ left: leftMarginFor(groups.map((g) => g.label), 'boxplot') });
  const { m, w, h } = fr;
  const sc = linearScale(groups.flatMap((g) => [g.st.min, g.st.max]), { includeZero: false, pad: .08 });
  const y = (v) => m.t + (sc.max - v) / (sc.max - sc.min) * fr.plotH;
  let inner = titleSvg(label, m) + yAxisSvg(fr, sc, y, { yLabel: opts.ylabel || '值', xLabel: opts.xlabel || table.dim });
  const slot = fr.plotW / Math.max(1, groups.length);
  inner += categoryTicksSvg(fr, groups.map((g) => g.label), (i) => m.l + (i + .5) * slot);
  const bw = Math.min(64, Math.max(14, slot * .5));
  groups.forEach((g, i) => {
    const cx = m.l + (i + .5) * slot, color = colorAt(i), st = g.st;
    const val = `中位数 ${chartFmt(st.med)} · Q1 ${chartFmt(st.q1)} · Q3 ${chartFmt(st.q3)} · 范围 ${chartFmt(st.min)}–${chartFmt(st.max)} · n=${st.n}`;
    inner += `<g ${datumAttrs(g.label, val, color)} class="md-chart-box" style="color:${color}"><title>${esc(g.label)}: ${esc(val)}</title>`
      + `<line x1="${f1(cx)}" y1="${f1(y(st.hi))}" x2="${f1(cx)}" y2="${f1(y(st.q3))}" class="md-chart-box-whisker"/><line x1="${f1(cx)}" y1="${f1(y(st.q1))}" x2="${f1(cx)}" y2="${f1(y(st.lo))}" class="md-chart-box-whisker"/>`
      + `<line x1="${f1(cx - bw / 3)}" y1="${f1(y(st.hi))}" x2="${f1(cx + bw / 3)}" y2="${f1(y(st.hi))}" class="md-chart-box-whisker"/><line x1="${f1(cx - bw / 3)}" y1="${f1(y(st.lo))}" x2="${f1(cx + bw / 3)}" y2="${f1(y(st.lo))}" class="md-chart-box-whisker"/>`
      + `<rect x="${f1(cx - bw / 2)}" y="${f1(y(st.q3))}" width="${f1(bw)}" height="${f1(Math.max(1, y(st.q1) - y(st.q3)))}" rx="3" class="md-chart-box-rect"/>`
      + `<line x1="${f1(cx - bw / 2)}" y1="${f1(y(st.med))}" x2="${f1(cx + bw / 2)}" y2="${f1(y(st.med))}" class="md-chart-box-median"/>`
      + st.outliers.map((v) => `<circle cx="${f1(cx)}" cy="${f1(y(v))}" r="3" class="md-chart-box-outlier"/>`).join('')
      + '</g>';
  });
  return wrap('boxplot', label, w, h, inner);
}
function renderHistogram(values, label, opts) {
  const fr = frame();
  const { m, w, h } = fr;
  const min = Math.min(...values), max = Math.max(...values);
  const wantBins = Number(opts.bins) || 0;
  let bins = Math.max(2, Math.min(40, wantBins || Math.ceil(Math.log2(values.length) + 1)));
  const span = max - min || 1;
  // 用户显式给了 bins 就严格按组数等分；否则取「好看」的组距（1/2/2.5/5×10ⁿ）
  const step = wantBins ? span / bins : niceStep(span, bins);
  const start = wantBins ? min : Math.floor(min / step) * step;
  const edges = [];
  if (wantBins) { for (let i = 0; i <= bins; i++) edges.push(Number((min + span * i / bins).toFixed(10))); } else {
    for (let e = start; e < max + step * 1e-9 || edges.length < 2; e += step) edges.push(Number(e.toFixed(10)));
    if (edges[edges.length - 1] <= max) edges.push(Number((edges[edges.length - 1] + step).toFixed(10)));
  }
  bins = edges.length - 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) { let k = Math.floor((v - start) / step); if (k >= bins) k = bins - 1; if (k < 0) k = 0; counts[k]++; }
  const sc = linearScale(counts, { includeZero: true });
  const y = (v) => m.t + (sc.max - v) / (sc.max - sc.min) * fr.plotH;
  const x = (v) => m.l + (v - edges[0]) / (edges[bins] - edges[0]) * fr.plotW;
  let inner = titleSvg(label, m) + yAxisSvg(fr, sc, y, { yLabel: opts.ylabel || '频数', xLabel: opts.xlabel || '' });
  const tickEvery = Math.max(1, Math.ceil(bins / 10));
  inner += numericXTicksSvg(fr, edges.filter((_, i) => i % tickEvery === 0), x);
  counts.forEach((c, i) => {
    const color = colorAt(0);
    const lbl = `${chartFmt(edges[i])} – ${chartFmt(edges[i + 1])}`;
    const x0 = x(edges[i]) + 1, ww = Math.max(1, x(edges[i + 1]) - x(edges[i]) - 2);
    inner += `<rect x="${f1(x0)}" y="${f1(y(c))}" width="${f1(ww)}" height="${f1(Math.max(0, y(0) - y(c)))}" rx="2" fill="${color}" ${datumAttrs(lbl, `${c}（${pctFmt(c, values.length)}）`, color)} class="md-chart-bar"><title>${esc(lbl)}: ${c}</title></rect>`;
  });
  inner += `<text x="${w - m.r}" y="${m.t - 10}" text-anchor="end" stroke="none" class="md-chart-tick">n=${values.length} · ${bins} 组 · 组距 ${esc(chartFmt(step))}</text>`;
  return wrap('histogram', label, w, h, inner);
}
function renderScatter(kind, pts, label, opts) {
  const bubble = kind === 'bubble';
  const seriesNames = [...new Set(pts.map((p) => p.series).filter(Boolean))];
  const fr = frame({ legend: seriesNames.length > 1 });
  const { m, w, h } = fr;
  const sx = linearScale(pts.map((p) => p.x), { includeZero: false, pad: .08 });
  const sy = linearScale(pts.map((p) => p.y), { includeZero: false, pad: .08 });
  const x = (v) => m.l + (v - sx.min) / (sx.max - sx.min) * fr.plotW;
  const y = (v) => m.t + (sy.max - v) / (sy.max - sy.min) * fr.plotH;
  let inner = titleSvg(label, m) + legendSvg(seriesNames, w, m) + yAxisSvg(fr, sy, y, { xLabel: opts.xlabel || opts.x || 'x', yLabel: opts.ylabel || opts.y || 'y' });
  inner += numericXTicksSvg(fr, sx.ticks, x);
  const sizes = bubble ? pts.map((p) => Math.max(0, p.size || 0)) : [];
  const maxSize = bubble ? Math.max(1, ...sizes) : 1;
  const rOf = (p) => (bubble ? 5 + Math.sqrt(Math.max(0, p.size || 0) / maxSize) * 26 : 5.5);
  const ordered = bubble ? [...pts].sort((a, b) => (b.size || 0) - (a.size || 0)) : pts;
  ordered.forEach((p, i) => {
    const sIdx = p.series ? seriesNames.indexOf(p.series) : -1;
    const color = sIdx >= 0 ? colorAt(sIdx) : colorAt(bubble ? 0 : i);
    const px = f1(x(p.x)), py = f1(y(p.y));
    const val = bubble ? `(${chartFmt(p.x)}, ${chartFmt(p.y)}) · 大小 ${chartFmt(p.size)}` : `(${chartFmt(p.x)}, ${chartFmt(p.y)})`;
    const lbl = p.series ? `${p.series} · ${p.label}` : p.label;
    if (bubble) {
      inner += `<circle cx="${px}" cy="${py}" r="${f1(rOf(p))}" fill="${color}" ${datumAttrs(lbl, val, color, ` role="button" aria-label="${esc(`${lbl}: ${val}`)}"`)} class="md-chart-bubble"><title>${esc(lbl)}: ${esc(val)}</title></circle>`;
    } else {
      inner += hitDot(px, py, lbl, val, color, 'md-chart-point', 5.5, ` fill="${color}"`);
    }
  });
  if (bubble) {
    // 气泡标签：只给最大的 8 个标注，避免拥挤
    ordered.slice(0, 8).forEach((p) => {
      if (!/^\d+$/.test(p.label)) inner += `<text x="${f1(x(p.x))}" y="${f1(y(p.y) - rOf(p) - 5)}" text-anchor="middle" stroke="none" class="md-chart-label" pointer-events="none">${esc(truncateDiagramLabel(p.label, 8))}</text>`;
    });
  }
  return wrap(kind, label, w, h, inner);
}
function renderFunnel(table, label) {
  const rows = table.rows.filter((r) => r.value >= 0);
  const fr = frame();
  const { m, w, h } = fr;
  const maxV = Math.max(...rows.map((r) => r.value)) || 1;
  const top = m.t, bottom = h - 40, gap = 4;
  const stepH = (bottom - top - gap * (rows.length - 1)) / rows.length;
  const cx = w * 0.4, maxW = w * 0.56;
  let inner = titleSvg(label, m);
  rows.forEach((row, i) => {
    const next = rows[i + 1];
    const w0 = Math.max(18, row.value / maxV * maxW);
    const w1 = Math.max(14, (next ? next.value : row.value * .72) / maxV * maxW);
    const y0 = top + i * (stepH + gap), y1 = y0 + stepH;
    const color = colorAt(i);
    const pct = pctFmt(row.value, rows[0].value);
    const conv = i ? `较上一步 ${pctFmt(row.value, rows[i - 1].value)}` : '起点';
    inner += `<polygon points="${f1(cx - w0 / 2)},${f1(y0)} ${f1(cx + w0 / 2)},${f1(y0)} ${f1(cx + w1 / 2)},${f1(y1)} ${f1(cx - w1 / 2)},${f1(y1)}" fill="${color}" ${datumAttrs(row.label, `${chartFmt(row.value)} · ${conv}`, color, ` data-chart-pct="${pct}"`)} class="md-chart-slice md-chart-funnel-step"><title>${esc(row.label)}: ${esc(row.value)} (${pct})</title></polygon>`;
    inner += `<text x="${f1(cx)}" y="${f1((y0 + y1) / 2 + 4)}" text-anchor="middle" stroke="none" class="md-chart-funnel-value" pointer-events="none">${esc(chartFmt(row.value))}</text>`;
    inner += `<text x="${f1(cx + maxW / 2 + 22)}" y="${f1((y0 + y1) / 2 - 4)}" stroke="none" class="md-chart-label">${esc(truncateDiagramLabel(row.label, 12))}</text><text x="${f1(cx + maxW / 2 + 22)}" y="${f1((y0 + y1) / 2 + 12)}" stroke="none" class="md-chart-tick">${pct}${i ? ` · ${esc(conv)}` : ''}</text>`;
  });
  return wrap('funnel', label, w, h, inner);
}
export function layoutSankey(links, width, height) {
  const nodes = new Map();
  const node = (name) => { if (!nodes.has(name)) nodes.set(name, { name, out: [], in: [], layer: 0, inSum: 0, outSum: 0 }); return nodes.get(name); };
  for (const l of links) { node(l.source).out.push(l); node(l.target).in.push(l); nodes.get(l.source).outSum += l.value; nodes.get(l.target).inSum += l.value; }
  // 分层：最长路径（DFS，带环保护）
  const seen = new Set();
  const depth = (n, stack) => {
    if (stack.has(n.name)) return 0;
    if (seen.has(n.name)) return n.layer;
    stack.add(n.name);
    let d = 0;
    for (const l of n.in) d = Math.max(d, depth(nodes.get(l.source), stack) + 1);
    stack.delete(n.name); seen.add(n.name); n.layer = d;
    return d;
  };
  for (const n of nodes.values()) depth(n, new Set());
  const maxLayer = Math.max(0, ...[...nodes.values()].map((n) => n.layer));
  // 无出边的节点靠右对齐
  for (const n of nodes.values()) if (!n.out.length && n.in.length) n.layer = maxLayer;
  const layers = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes.values()) layers[n.layer].push(n);
  const total = Math.max(...layers.map((L) => L.reduce((a, n) => a + Math.max(n.inSum, n.outSum), 0)));
  const nodeW = 14, gap = 10;
  const scale = (height - gap * (Math.max(...layers.map((L) => L.length)) - 1)) / (total || 1);
  // 重心排序（两趟）
  const center = (n) => n.y0 + n.h / 2;
  layers.forEach((L, i) => L.forEach((n, k) => { n.y0 = k; n.h = 0; }));
  const place = (L) => { let y = 0; const used = L.reduce((a, n) => a + Math.max(n.inSum, n.outSum) * scale, 0) + gap * (L.length - 1); y = (height - used) / 2; for (const n of L) { n.h = Math.max(2, Math.max(n.inSum, n.outSum) * scale); n.y0 = y; y += n.h + gap; } };
  layers.forEach(place);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < layers.length; i++) {
      layers[i].sort((a, b) => (a.in.length ? a.in.reduce((s, l) => s + center(nodes.get(l.source)), 0) / a.in.length : center(a)) - (b.in.length ? b.in.reduce((s, l) => s + center(nodes.get(l.source)), 0) / b.in.length : center(b)));
      place(layers[i]);
    }
    for (let i = layers.length - 2; i >= 0; i--) {
      layers[i].sort((a, b) => (a.out.length ? a.out.reduce((s, l) => s + center(nodes.get(l.target)), 0) / a.out.length : center(a)) - (b.out.length ? b.out.reduce((s, l) => s + center(nodes.get(l.target)), 0) / b.out.length : center(b)));
      place(layers[i]);
    }
  }
  const colW = layers.length > 1 ? (width - nodeW) / (layers.length - 1) : 0;
  layers.forEach((L, i) => L.forEach((n) => { n.x0 = layers.length > 1 ? i * colW : (width - nodeW) / 2; n.x1 = n.x0 + nodeW; n.y1 = n.y0 + n.h; }));
  // 链接端口位置
  for (const n of nodes.values()) {
    let sy = n.y0; n.out.sort((a, b) => center(nodes.get(a.target)) - center(nodes.get(b.target))); for (const l of n.out) { l.sy = sy; l.w = l.value * scale; sy += l.w; }
    let ty = n.y0; n.in.sort((a, b) => center(nodes.get(a.source)) - center(nodes.get(b.source))); for (const l of n.in) { l.ty = ty; ty += l.value * scale; }
  }
  return { nodes: [...nodes.values()], links, layers: layers.length };
}
function renderSankey(links, label) {
  const fr = frame({ left: 24, right: 24, bottom: 28 });
  const { m, w, h } = fr;
  const lay = layoutSankey(links, w - m.l - m.r - 120, h - m.t - m.b);
  const ox = m.l + 60, oy = m.t;
  const nodeIndex = new Map(lay.nodes.map((n, i) => [n.name, i]));
  let inner = titleSvg(label, m);
  const nodeBy = new Map(lay.nodes.map((n) => [n.name, n]));
  for (const l of lay.links) {
    const s = nodeBy.get(l.source), t = nodeBy.get(l.target);
    const x0 = ox + s.x1, x1 = ox + t.x0, c = (x0 + x1) / 2;
    const y0 = oy + l.sy + l.w / 2, y1 = oy + l.ty + l.w / 2;
    const color = colorAt(nodeIndex.get(l.source));
    const lbl = `${l.source} → ${l.target}`;
    inner += `<path d="M ${f1(x0)} ${f1(y0)} C ${f1(c)} ${f1(y0)}, ${f1(c)} ${f1(y1)}, ${f1(x1)} ${f1(y1)}" fill="none" stroke="${color}" stroke-width="${f1(Math.max(1.5, l.w))}" ${datumAttrs(lbl, `${chartFmt(l.value)} · 占 ${l.source} 流出的 ${pctFmt(l.value, s.outSum)}`, color)} class="md-chart-sankey-link"><title>${esc(lbl)}: ${esc(l.value)}</title></path>`;
  }
  for (const n of lay.nodes) {
    const color = colorAt(nodeIndex.get(n.name));
    const total = Math.max(n.inSum, n.outSum);
    const right = n.layer === lay.layers - 1 && lay.layers > 1;
    inner += `<rect x="${f1(ox + n.x0)}" y="${f1(oy + n.y0)}" width="${f1(n.x1 - n.x0)}" height="${f1(n.h)}" rx="3" fill="${color}" ${datumAttrs(n.name, `流入 ${chartFmt(n.inSum)} · 流出 ${chartFmt(n.outSum)}`, color)} class="md-chart-sankey-node"><title>${esc(n.name)}: ${esc(chartFmt(total))}</title></rect>`;
    inner += `<text x="${f1(right ? ox + n.x0 - 8 : ox + n.x1 + 8)}" y="${f1(oy + n.y0 + n.h / 2 + 4)}" text-anchor="${right ? 'end' : 'start'}" stroke="none" class="md-chart-label" pointer-events="none">${esc(truncateDiagramLabel(n.name, 10))} <tspan class="md-chart-tick">${esc(chartFmt(total))}</tspan></text>`;
  }
  return wrap('sankey', label, w, h, inner);
}
// 地图：先出占位（同步、纯函数），ui.js 取回 assets/geo/<map>.json 后调用 renderGeoMapSvg 替换 <svg>
function renderMapPlaceholder(table, label, opts) {
  const rows = table.rows;
  const mapId = opts.map === 'china' || (!opts.map && rows.some((r) => CHINA_REGION_RE.test(r.label))) ? 'china' : 'world';
  const fr = frame();
  const { w, h, m } = fr;
  const inner = titleSvg(label, m) + `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" stroke="none" class="md-chart-tick md-chart-map-loading">地图边界加载中…</text>`;
  const payload = esc(JSON.stringify(rows.map((r) => [r.label, r.value])));
  return wrap('map', label, w, h, inner, ` data-map="${mapId}" data-map-title="${esc(label)}" data-rows="${payload}"`);
}
const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mixHex = (a, b, t) => { const A = hexToRgb(a), B = hexToRgb(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`; };
export function renderGeoMapSvg(geo, rows, label = '地图', mapId = 'world') {
  const w = 720, h = 392, m = { l: 24, r: 24, t: 58, b: 24 };
  const alias = geo.aliases || {};
  const norm = (s) => String(s || '').trim();
  const lookup = new Map();
  for (const [lbl, val] of rows) {
    const key = alias[norm(lbl)] || norm(lbl);
    lookup.set(key, (lookup.get(key) || 0) + Number(val));
  }
  // 也接受「广东省」「United States of America」这类前缀匹配
  const findVal = (name) => {
    if (lookup.has(name)) return lookup.get(name);
    for (const [k, v] of lookup) if (k.length >= 2 && (name.startsWith(k) || k.startsWith(name))) return v;
    return null;
  };
  const vals = [...lookup.values()];
  const vmin = Math.min(...vals), vmax = Math.max(...vals);
  const lat0 = mapId === 'china' ? 35 : 0;
  const kx = Math.cos(lat0 * Math.PI / 180) || 1;
  // 投影：等距圆柱（世界）/ 按中纬度压缩的平面投影（中国）
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const proj = ([lon, lat]) => [lon * kx, -lat];
  for (const f of geo.features) for (const ring of f.r) for (const p of ring) {
    const [x, y] = proj(p);
    if (mapId === 'world' && (p[1] < -58 || p[1] > 84)) continue; // 裁掉南极与北极空白
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const plotW = w - m.l - m.r, plotH = h - m.t - m.b;
  const s = Math.min(plotW / (maxX - minX), plotH / (maxY - minY));
  const ox = m.l + (plotW - (maxX - minX) * s) / 2 - minX * s, oy = m.t + (plotH - (maxY - minY) * s) / 2 - minY * s;
  const toPx = (p) => { const [x, y] = proj(p); return `${(ox + x * s).toFixed(1)},${(oy + y * s).toFixed(1)}`; };
  let inner = `<text x="${m.l}" y="34" stroke="none" class="md-chart-title">${esc(label)}</text>`;
  const lo = '#dbe4ff', hi = '#312e81';
  let labelsSvg = '';
  for (const f of geo.features) {
    const v = findVal(f.n);
    const t = v == null ? null : (vmax === vmin ? 1 : (v - vmin) / (vmax - vmin));
    const fill = t == null ? 'var(--line-2, #e5e7eb)' : mixHex(lo, hi, 0.15 + t * 0.85);
    const d = f.r.map((ring) => `M ${ring.map(toPx).join(' L ')} Z`).join(' ');
    const attrs = v == null ? `data-chart-label="${esc(f.n)}" data-chart-val="无数据" data-chart-color="${fill}" tabindex="0"` : datumAttrs(f.n, chartFmt(v), mixHex(lo, hi, 0.15 + t * 0.85));
    inner += `<path d="${d}" fill="${fill}" ${attrs} class="md-chart-region${v == null ? ' md-chart-region-empty' : ''}"><title>${esc(f.n)}: ${v == null ? '无数据' : esc(chartFmt(v))}</title></path>`;
    if (mapId === 'china' && v != null) {
      // 省级标签：用最大外环的几何中心
      const ring = f.r.reduce((a, b) => (b.length > a.length ? b : a), f.r[0]);
      const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length, cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
      const [px, py] = toPx([cx, cy]).split(',');
      labelsSvg += `<text x="${px}" y="${py}" text-anchor="middle" stroke="none" class="md-chart-map-label" pointer-events="none">${esc(f.n)}</text>`;
    }
  }
  inner += labelsSvg;
  // 图例渐变条
  const gid = `mg${Math.abs(Math.round(vmin * 7 + vmax * 13)) % 100000}`;
  inner += `<defs><linearGradient id="${gid}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${mixHex(lo, hi, 0.15)}"/><stop offset="1" stop-color="${hi}"/></linearGradient></defs>`
    + `<rect x="${w - m.r - 150}" y="${h - 30}" width="120" height="10" rx="3" fill="url(#${gid})"/>`
    + `<text x="${w - m.r - 154}" y="${h - 21}" text-anchor="end" stroke="none" class="md-chart-tick">${esc(chartFmt(vmin))}</text><text x="${w - m.r - 26}" y="${h - 21}" stroke="none" class="md-chart-tick">${esc(chartFmt(vmax))}</text>`;
  const matched = geo.features.filter((f) => findVal(f.n) != null).length;
  if (matched < lookup.size) inner += `<text x="${m.l}" y="${h - 12}" stroke="none" class="md-chart-tick">${lookup.size - matched} 个地区未匹配到边界</text>`;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}" class="md-chart-svg">${inner}</svg>`;
}
export function renderQuickChart(kind, body, title = '') {
  kind = CHART_ALIAS[kind] || kind;
  const parsed = parseChartOptions(title);
  const opts = parsed.opts;
  const label = parsed.title || CHART_KIND_LABEL[kind] || '图表';
  const sample = CHART_SAMPLE[kind] || CHART_SAMPLE.bar;
  if (kind === 'scatter' || kind === 'bubble') {
    const pts = parsePoints(body, kind === 'bubble');
    if (!pts.length) return emptyChart(sample);
    return renderScatter(kind, pts, label, opts);
  }
  if (kind === 'histogram') {
    const nums = parseNumbers(body);
    if (nums.length < 2) return emptyChart(sample);
    return renderHistogram(nums, label, opts);
  }
  if (kind === 'sankey') {
    const links = parseLinks(body);
    if (!links.length) return emptyChart(sample);
    return renderSankey(links, label);
  }
  const table = parseTable(body);
  if (!table.rows.length) return emptyChart(sample);
  switch (kind) {
    case 'barh': return renderBarsH(table, label, opts);
    case 'line': case 'area': case 'stackedarea': return renderLines(kind, table, label, opts);
    case 'stacked': return table.series.length > 1 ? renderStackedBars(table, label, opts) : renderBars('bar', table, label, opts);
    case 'pie': case 'donut': return table.rows.some((r) => r.value > 0) ? renderPie(kind, table, label) : emptyChart(sample);
    case 'boxplot': return renderBoxplot(table, label, opts);
    case 'funnel': return renderFunnel(table, label);
    case 'map': return renderMapPlaceholder(table, label, opts);
    default: return renderBars('bar', table, label, opts);
  }
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
