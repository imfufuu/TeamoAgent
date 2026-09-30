// ─── UI 层：渲染 / 交互 / 动画 ─────────────────────────────────────────
import { FALLBACK_MODELS, PROVIDER_ORDER, providerOf, isFreeModel, supportsFastMode, supportsVision, isImageModel, IMAGE_MODELS, imageModelLabel, DEFAULT_IMAGE_MODEL, APP_VERSION, APP_RELEASE, systemPrompt, ENCRYPTED_THINKING_RE } from './config.js';
import { REASONING_LEVELS, normalizeReasoningLevel, reasoningLevelLabel, reasoningLevelHint } from './reasoning.js';
import { isJevModel } from './jev.js';
import { createZip, fileBytesFromValue, withExtension } from './zip.js';
import { buildFileTree, collectPaths, treeStats, flattenTree } from './filetree.js';
import { fetchModels, getTransport } from './api.js';
import { gatewayBase, gatewayChosenBy, setGatewayBase } from './endpoint.js';
import { estimateTokens, contextBudgetFor } from './context.js';
import { providerIcon, APP_LOGO, ICON } from './icons.js';
import { autoTitle } from './titler.js';
import { SUGGESTIONS, pickSuggestions } from './suggestions.js';
import { claimsWebSearch, webRefusal } from './websearch.js';
import { effectiveApiKey, unlockAdminKey, adminUnlocked, isAdminAlias } from './adminkey.js';
import { SANDBOX_STORAGE_CAP, sandboxQuotaLabel } from './storagefmt.js';
import { filterCmds, tokenBreakdown, formatTokBreak, shortSuggest } from './commands.js';
import { pdfToImages } from './pdfpages.js';
import { summarizeTurnCost, formatUsd, priceBadgeFor } from './pricing.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeHref = (href) => {
  const h = String(href || '').trim();
  if (!h || /[\s<>"'`]/.test(h)) return '';
  if (h.startsWith('#') && h.length < 200) return h;
  try {
    const u = new URL(h);
    if (u.protocol === 'http:' || u.protocol === 'https:') return h;
    if (u.protocol === 'mailto:') {
      const addr = decodeURIComponent(u.pathname || '');
      if (/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(addr)) return `mailto:${addr}`;
    }
  } catch { /* 非法 URL */ }
  return '';
};
const safeImgSrc = (src) => {
  const s = String(src || '').trim();
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return s.replace(/\s+/g, '');
  if (/^blob:/i.test(s)) return s;
  return safeHref(s);
};
const sandboxPath = (src) => {
  const s = String(src || '').trim();
  const m = /^(?:sandbox:\/\/|sandbox:)(.+)$/i.exec(s);
  if (!m) return '';
  const parts = m[1].trim().split('/').map((x) => x.trim()).filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..') || /[\u0000-\u001f]/.test(parts.join('/'))) return '';
  return parts.join('/');
};
const headingSlug = (text) => {
  const s = String(text || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s-]+/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return s || 'section';
};
const parseChoiceOpts = (body) => {
  const listed = [];
  for (const line of String(body || '').split('\n')) {
    const m = /^\s*(?:[-*]|\d+\.|[A-Za-z]\.)\s+(.+?)\s*$/.exec(line);
    if (m) listed.push(m[1].trim());
  }
  if (listed.length) return listed;
  return String(body || '').split('\n').map((l) => l.trim()).filter(Boolean);
};
const peelChoices = (src) => {
  const blocks = [];
  let rest = String(src || '').replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '');
  // 从文末向前剥离完整 :::choice 块。旧版正则会把连续多个 choice
  // 贪成「第一个问题 + 所有选项」，导致第二个问题不渲染。
  const openRe = /(?:^|\n):::choice(?:[ \t]+([^\n]*))?[ \t]*\n/g;
  while (/\n:::[ \t]*$/.test(rest)) {
    const close = rest.match(/\n:::[ \t]*$/);
    if (!close || close.index == null) break;
    const beforeClose = rest.slice(0, close.index);
    let last = null;
    openRe.lastIndex = 0;
    for (let m; (m = openRe.exec(beforeClose)); ) last = m;
    if (!last) break;
    const title = (last[1] || '').trim();
    const body = beforeClose.slice(last.index + last[0].length);
    blocks.unshift({ title, body });
    rest = beforeClose.slice(0, last.index).replace(/\s+$/, '');
  }
  return { rest, blocks };
};
const choiceHtml = (blocks) => {
  const list = (Array.isArray(blocks) ? blocks : [blocks]).filter(Boolean);
  const safe = list.length ? list : [{ title: '请选择', body: '' }];
  const count = safe.length;
  const groups = safe.map((block, i) => {
    const q = esc(block.title || `问题 ${i + 1}`);
    const opts = parseChoiceOpts(block.body);
    const buttons = opts.map((o) => `<button type="button" class="choice-opt" data-choice-send="${esc(o)}">${esc(o)}</button>`).join('');
    return `<div class="choice-qblock${i === 0 ? ' active' : ''}" data-choice-idx="${i}"><div class="choice-qrow"><span class="choice-step">${i + 1}/${count}</span><div class="choice-q">${q}</div></div><div class="choice-opts">${buttons}</div></div>`;
  }).join('');
  const label = esc(count > 1 ? `选择框（${count} 个问题）` : (safe[0].title || '请选择'));
  return `<div class="choice-box${count > 1 ? ' multi' : ''}" role="group" aria-label="${label}" data-choice-count="${count}" data-choice-step="0" data-choice-answers="[]"><div class="choice-head"><div class="choice-title">${count > 1 ? `请选择 · ${count} 题` : '请选择'}</div></div><div class="choice-summary" data-choice-summary></div>${groups}<div class="choice-nav"><button type="button" class="choice-back" data-choice-back disabled>← 回退</button><span class="choice-progress" data-choice-progress>1 / ${count}</span></div></div>`;
};

const CHART_ALIAS = {
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
function parseChartInfo(info, directKind = '') {
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
function renderQuickChart(kind, body, title = '') {
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
      if (a1 - a0 >= Math.PI * 1.999) {
        inner += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${CHART_COLORS[i % CHART_COLORS.length]}" class="md-chart-slice"/>`;
      } else {
        inner += `<path d="M ${cx} ${cy} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${CHART_COLORS[i % CHART_COLORS.length]}" class="md-chart-slice"/>`;
      }
      const mid = (a0 + a1) / 2;
      const rightSide = Math.cos(mid) >= 0;
      const lx = cx + (r + 36) * Math.cos(mid);
      const ly = cy + (r + 32) * Math.sin(mid);
      pieLabels.push({
        rightSide,
        lx: Math.max(24, Math.min(w - 24, lx)),
        ly: Math.max(54, Math.min(h - 18, ly)),
        text: `${truncateDiagramLabel(row.label, 12)} ${Math.round(row.value / total * 100)}%`,
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
      inner += `<polyline points="${pts.join(' ')}" class="md-chart-line md-chart-st-line"/>`;
    }
    rows.forEach((row, i) => {
      const fill = kind === 'scatter' ? ` fill="${CHART_COLORS[i % CHART_COLORS.length]}"` : '';
      inner += `<circle cx="${x(row.x).toFixed(1)}" cy="${sc.y(row.value).toFixed(1)}" r="${kind === 'st' ? 4 : 5}"${fill} class="${kind === 'st' ? 'md-chart-dot' : 'md-chart-point'}"><title>${esc(row.label)}: ${esc(row.x)}, ${esc(row.value)}</title></circle>`;
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
        inner += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="6" fill="${CHART_COLORS[i % CHART_COLORS.length]}" class="md-chart-bar"><title>${esc(row.label)}: ${esc(row.value)}</title></rect>`;
      });
    } else {
      const pts = rows.map((row, i) => `${xAt(i).toFixed(1)},${sc.y(row.value).toFixed(1)}`);
      inner += `<polyline points="${pts.join(' ')}" class="md-chart-line"/>`;
      rows.forEach((row, i) => {
        const x = xAt(i);
        inner += `<circle cx="${x.toFixed(1)}" cy="${sc.y(row.value).toFixed(1)}" r="4" class="md-chart-dot"><title>${esc(row.label)}: ${esc(row.value)}</title></circle>`;
      });
    }
  }
  return `<div class="md-chart md-chart-${kind}"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" class="md-chart-svg">${inner}</svg></div>`;
}

const DIAGRAM_ALIAS = {
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
function parseDiagramInfo(info, direct = '') {
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
  return `<div class="md-diagram md-diagram-flow"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" class="md-chart-svg md-diagram-svg">${inner}</svg></div>`;
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
  return `<div class="md-diagram md-diagram-mind"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title || tree.label || '思维导图')}" class="md-chart-svg md-diagram-svg">${inner}</svg></div>`;
}
function renderQuickDiagram(kind, body, title = '') {
  return kind === 'mind' ? renderMindDiagram(body, title) : renderFlowDiagram(body, title);
}

function sanitizeSvgRaw(raw) {
  return String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function hydrateSandboxMedia(root, fs) {
  if (!root || !fs) return;
  for (const img of root.querySelectorAll('img[data-sandbox]')) {
    const p = img.getAttribute('data-sandbox') || '';
    let raw = '';
    try { raw = fs.read(p); } catch { raw = ''; }
    if (/^data:image\//i.test(String(raw))) {
      const safe = safeImgSrc(raw);
      if (safe) {
        img.src = safe;
        if (!img.alt) img.alt = p;
        img.classList.add('zoomable');
        continue;
      }
    }
    if (/\.svg$/i.test(p) && /<svg[\s>]/i.test(String(raw))) {
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizeSvgRaw(raw))}`;
      if (!img.alt) img.alt = p;
      img.classList.add('zoomable');
      continue;
    }
    const card = document.createElement('div');
    card.className = 'sb-file' + (raw ? '' : ' missing');
    const name = esc((p.split('/').pop() || p));
    card.innerHTML = raw
      ? `<span class="mono">${name}</span><button type="button" class="sb-dl" data-sb-dl="${esc(p)}">下载</button>`
      : `<span class="mono">${esc(p)}</span><span>沙箱中没有这个文件</span>`;
    img.replaceWith(card);
  }
}

function bindFoldRows(root) {
  if (!root) return;
  for (const n of root.querySelectorAll('.md-fold')) {
    if (n.dataset.bound) continue;
    n.dataset.bound = '1';
    const toggle = () => n.classList.toggle('expanded');
    n.addEventListener('click', (e) => {
      if (e.target.closest('a, button, .chip-copy')) return;
      toggle();
    });
    n.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }
}

const fmtSize = (n) => {
  if (n == null) return '';
  const v = Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 0;
  const kb = v / 1024;
  return kb > 1024 ? `${(v / 1048576).toFixed(1)}MB` : `${kb.toFixed(1)}KB`;
};

const contextBudgetLabel = (model) => {
  const b = contextBudgetFor(model);
  return b >= 1000 ? `${Math.round(b / 1000)}k` : String(b);
};

// 附件展示（用户气泡内）
function renderAttachments(atts) {
  if (!atts || !atts.length) return '';
  const items = atts.map((a) => {
    if (a.kind === 'image') {
      const src = safeImgSrc(a.dataUrl);
      return src
        ? `<button type="button" class="att-img" title="${esc(a.name)}"><img src="${src}" alt="${esc(a.name)}"></button>`
        : `<span class="att-file mono" title="内容未持久化">🖼 ${esc(a.name)}（已省略）</span>`;
    }
    return `<span class="att-file mono" title="${esc(a.name)}">📄 ${esc(a.name)}${a.stripped ? '（已省略）' : ` · ${fmtSize(a.size)}`}</span>`;
  }).join('');
  return `<div class="att-row">${items}</div>`;
}

const LANG_ALIAS = {
  js: 'javascript', javascript: 'javascript', jsx: 'javascript', node: 'javascript',
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
  py: 'python', python: 'python', py3: 'python',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  csharp: 'csharp', 'c#': 'csharp', cs: 'csharp',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  rb: 'ruby', ruby: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin', kotlin: 'kotlin',
  scala: 'scala',
  dart: 'dart',
  objc: 'objectivec', 'objective-c': 'objectivec', objectivec: 'objectivec',
  m: 'matlab', matlab: 'matlab', octave: 'matlab',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell', psm1: 'powershell', powershell: 'powershell', pwsh: 'powershell',
  bat: 'dos', cmd: 'dos', batch: 'dos', dos: 'dos',
  sql: 'sql',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'ini', conf: 'ini', gitconfig: 'ini', gitignore: 'ini', properties: 'ini',
  xml: 'xml', htm: 'xml', html: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  r: 'r',
  jl: 'julia', julia: 'julia',
  sas: 'sas', do: 'stata', stata: 'stata',
  hs: 'haskell', haskell: 'haskell',
  erl: 'erlang', erlang: 'erlang',
  ex: 'elixir', exs: 'elixir', elixir: 'elixir',
  clj: 'clojure', cljs: 'clojure', clojure: 'clojure',
  lisp: 'lisp', cl: 'lisp', scm: 'scheme', scheme: 'scheme',
  fs: 'fsharp', fsharp: 'fsharp', 'f#': 'fsharp',
  ml: 'ocaml', ocaml: 'ocaml',
  asm: 'x86asm', s: 'x86asm', x86asm: 'x86asm', armasm: 'armasm', arm: 'armasm',
  vhd: 'vhdl', vhdl: 'vhdl',
  v: 'verilog', sv: 'verilog', verilog: 'verilog',
  cu: 'cpp', cuda: 'cpp',
  sol: 'javascript', solidity: 'javascript',
  graphql: 'graphql', gql: 'graphql',
  tex: 'latex', latex: 'latex',
  hbs: 'handlebars', handlebars: 'handlebars',
  jinja: 'django', jinja2: 'django', j2: 'django', django: 'django',
  dockerfile: 'dockerfile', docker: 'dockerfile',
  mk: 'makefile', make: 'makefile', makefile: 'makefile',
  nginx: 'nginx', apache: 'apache', apacheconf: 'apache',
  diff: 'diff', patch: 'diff',
  regex: 'javascript', regexp: 'javascript',
};
function highlightCode(code, lang, escapeFn) {
  const raw = String(code || '').replace(/\n$/, '');
  const L = LANG_ALIAS[(lang || '').toLowerCase()] || (lang || '').toLowerCase();
  if (typeof hljs !== 'undefined') {
    try {
      if (L && hljs.getLanguage && hljs.getLanguage(L)) return hljs.highlight(raw, { language: L, ignoreIllegals: true }).value;
      return hljs.highlightAuto(raw).value;
    } catch { /* 回退纯文本 */ }
  }
  return escapeFn(raw);
}
function fenceHtml(lang, code, escapeFn) {
  const L = (lang || 'text').trim() || 'text';
  const body = highlightCode(code, L, escapeFn);
  return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeFn(L)}</span><button class="copy-code" type="button">复制</button></div><pre data-lang="${escapeFn(L)}"><code class="hljs">${body}</code></pre></div>`;
}

// ── Markdown 渲染：markdown-it（本地打包 assets/md/，完整 CommonMark + GFM 表格）
//    + KaTeX 公式；两者任一未加载时回退到内置精简渲染器（先转义再解析，无 XSS 面）──
let mdEngine; // undefined=未初始化 null=不可用
function getMd() {
  if (mdEngine === undefined) {
    if (typeof markdownit === 'undefined') { mdEngine = null; }
    else {
      const md = markdownit({ html: false, linkify: true, breaks: false, typographer: false });
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const tok = tokens[idx];
        const href = safeHref(tok.attrGet('href'));
        tok.attrSet('href', href);
        if (href.startsWith('#')) {
          tok.attrSet('target', '');
          tok.attrSet('rel', '');
          tok.attrJoin('class', 'md-jump');
        } else if (href) {
          tok.attrSet('target', '_blank');
          tok.attrSet('rel', 'noopener noreferrer nofollow');
        } else {
          tok.attrSet('target', '');
          tok.attrSet('rel', '');
        }
        return self.renderToken(tokens, idx, options);
      };
      const defaultImage = md.renderer.rules.image;
      md.renderer.rules.image = (tokens, idx, options, env, self) => {
        const tok = tokens[idx];
        const raw = String(tok.attrGet('src') || '');
        const sb = sandboxPath(raw);
        if (sb) {
          tok.attrSet('src', '');
          tok.attrSet('data-sandbox', sb);
          tok.attrJoin('class', 'sb-img');
        } else {
          tok.attrSet('src', safeImgSrc(raw));
        }
        return defaultImage ? defaultImage(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
      };
      md.core.ruler.push('heading-ids', (state) => {
        const seen = Object.create(null);
        for (let i = 0; i < state.tokens.length; i++) {
          const tok = state.tokens[i];
          if (tok.type !== 'heading_open') continue;
          const inline = state.tokens[i + 1];
          const text = inline && inline.children
            ? inline.children.filter((c) => c.type === 'text').map((c) => c.content).join('')
            : '';
          let id = headingSlug(text);
          if (seen[id]) { seen[id] += 1; id = `${id}-${seen[id]}`; }
          else seen[id] = 1;
          tok.attrSet('id', id);
        }
      });
      md.renderer.rules.fence = (tokens, idx) => {
        const tk = tokens[idx];
        const lang = (tk.info || '').trim().split(/\s+/)[0] || 'text';
        return fenceHtml(lang, tk.content, md.utils.escapeHtml);
      };
      // GFM 任务列表（markdown-it 核心不含）：[ ] / [x] 开头的列表项 → checkbox
      md.core.ruler.after('inline', 'task-lists', (state) => {
        let inList = 0;
        for (const tok of state.tokens) {
          if (tok.type === 'bullet_list_open' || tok.type === 'ordered_list_open') inList++;
          else if (tok.type === 'bullet_list_close' || tok.type === 'ordered_list_close') inList--;
          if (tok.type !== 'inline' || !inList || !tok.children || !tok.children.length) continue;
          const first = tok.children[0];
          if (first.type !== 'text') continue;
          const m = /^\[([ xX])\]\s+/.exec(first.content);
          if (!m) continue;
          first.content = first.content.slice(m[0].length);
          const cb = new state.Token('html_inline', '', 0);
          cb.content = m[1] === ' ' ? '<input type="checkbox" disabled> ' : '<input type="checkbox" checked disabled> ';
          tok.children.unshift(cb);
        }
      });
      mdEngine = md;
    }
  }
  return mdEngine;
}

// ── /system 回复格式化（.18）：行级结构化——命令行/结果行/小节标题，不再挤成一团 ──
function sysReplyHtml(text) {
  const rows = String(text || '').split('\n').map((ln) => {
    const e = esc(ln);
    const s = ln.trim();
    let cls = 'sys-row';
    if (/^\/[a-z]/i.test(s)) cls += ' sys-cmd';
    else if (/^✓/.test(s)) cls += ' sys-ok';
    else if (/^(✗|⚠)/.test(s)) cls += ' sys-err';
    else if (/^⌙|：$/.test(s)) cls += ' sys-head';
    return `<div class="${cls}">${e || '&nbsp;'}</div>`;
  });
  return `<div class="sys-reply">${rows.join('')}</div>`;
}

export function renderMarkdown(src) {
  const codeBlocks = [];
  let t = String(src || '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang, code });
    return `\uE000CB${codeBlocks.length - 1}\uE000`;
  });
  // 行内代码先剥离（.18）：`code` 里的 $…$ 不能被当数学定界符——正则/命令含 $ 锚点时
  // 曾被 KaTeX 当数学渲染（数学模式吃空格 + 未知命令标红，产生整段乱码）
  const inlineCodes = [];
  t = t.replace(/(`+)([\s\S]*?)\1/g, (_, run, code) => {
    inlineCodes.push(code);
    return `\uE000IC${inlineCodes.length - 1}\uE000`;
  });
  // LaTeX：$$..$$ / \[..\] 块级，$..$ / \(..\) 行内；在渲染前提取，占位保护。
  // 数学段守卫（.18）：像正则/代码/自然语言的内容不当数学渲染，原文保留可读；
  // \(..\) / \[..\] 是显式定界不受守卫影响。
  const MATH_REJECT = /(\(\?|\\p\{|\\P\{|\\x[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f{]|\\[bBdDwWsSnrt]|\*\/|\^\$|\.\*|\$\{|=>|https?:\/\/|[\u4e00-\u9fff]|[A-Za-z]{3,}\s+[A-Za-z]{3,})/;
  const mathOk = (x) => !MATH_REJECT.test(x);
  const maths = [];
  const hasKatex = typeof katex !== 'undefined';
  const pushMath = (tex, display) => {
    if (hasKatex) {
      try {
        maths.push(katex.renderToString(tex, { displayMode: display, throwOnError: false }));
        return `\uE000M${maths.length - 1}\uE000`;
      } catch { /* 渲染失败按原文处理 */ }
    }
    return display ? `\n\`\`\`tex\n${tex}\n\`\`\`\n` : `\`${tex}\``; // 降级：代码形式展示
  };
  t = t
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, x) => mathOk(x) ? pushMath(x, true) : _)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, x) => pushMath(x, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, x) => pushMath(x, false))
    .replace(/\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (_, x) => mathOk(x) ? pushMath(x, false) : _);

  const peeled = peelChoices(t);
  t = peeled.rest;
  const folds = [];
  t = t.replace(/^:::fold[ \t]+(.+)\n([\s\S]*?)^:::[ \t]*$/gm, (_, title, body) => {
    folds.push({ title: String(title || '').trim(), body });
    return `\n\n\uE000FOLD${folds.length - 1}\uE000\n\n`;
  });
  const ALIGN_ALIAS = {
    center: 'center', centre: 'center', 居中: 'center', 居中对齐: 'center', 中: 'center',
    right: 'right', 右: 'right', 右对齐: 'right', 靠右: 'right',
  };
  const aligns = [];
  t = t.replace(/^:::(?:align[ \t]+(.+?)|([Cc]enter|[Rr]ight|居中|右对齐))[ \t]*\n([\s\S]*?)^:::[ \t]*$/gm, (_, a, b, body) => {
    const raw = String(a || b || '').trim();
    const key = ALIGN_ALIAS[raw] || ALIGN_ALIAS[raw.toLowerCase()] || '';
    if (!key) return _;
    aligns.push({ cls: key, body });
    return `\n\n\uE000ALIGN${aligns.length - 1}\uE000\n\n`;
  });
  const charts = [];
  t = t.replace(/^:::(?:chart[ \t]+([^\n]+)|(bar|bars|line|scatter|scat|st|s-t|s–t|s—t|pie|柱状图|柱状|条形图|折线图|折线|趋势图|散点图|散点|位移时间图|位移-时间图|路程时间图|路程-时间图|饼图|饼|环形图)[ \t]*([^\n]*))\n([\s\S]*?)^:::[ \t]*$/gm, (_, info, direct, restTitle, body) => {
    const spec = parseChartInfo(info || restTitle || '', direct ? String(direct).toLowerCase() : '');
    charts.push({ ...spec, body });
    return `\n\n\uE000CHART${charts.length - 1}\uE000\n\n`;
  });
  const diagrams = [];
  t = t.replace(/^:::(?:diagram[ \t]+([^\n]+)|(flow|flowchart|mind|mindmap|mind-map|流程图|流程|思维导图|脑图)[ \t]*([^\n]*))\n([\s\S]*?)^:::[ \t]*$/gm, (_, info, direct, restTitle, body) => {
    const spec = parseDiagramInfo(info || restTitle || '', direct ? String(direct).toLowerCase() : '');
    diagrams.push({ ...spec, body });
    return `\n\n\uE000DIAGRAM${diagrams.length - 1}\uE000\n\n`;
  });
  const FONT_ALIAS = {
    楷体: 'kai', 楷: 'kai', kai: 'kai', kaiti: 'kai',
    宋体: 'song', 宋: 'song', song: 'song', songti: 'song',
    仿宋: 'fangsong', fangsong: 'fangsong',
    黑体: 'heiti', 黑: 'heiti', heiti: 'heiti', sans: 'heiti',
    行楷: 'xingkai', xingkai: 'xingkai',
    serif: 'serif', latin: 'serif', 衬线: 'serif',
    jp: 'jp', 日文: 'jp', japanese: 'jp',
  };
  const fonts = [];
  t = t.replace(/^:::font[ \t]+(.+)\n([\s\S]*?)^:::[ \t]*$/gm, (_, name, body) => {
    const raw = String(name || '').trim();
    const cls = FONT_ALIAS[raw] || FONT_ALIAS[raw.toLowerCase()] || 'serif';
    fonts.push({ cls, body });
    return `\n\n\uE000FONT${fonts.length - 1}\uE000\n\n`;
  });
  // 颜色文本：:::color <名>\n正文\n:::（正文继续走 Markdown 渲染；中英别名见 COLOR_ALIAS）
  const COLOR_ALIAS = {
    red: 'red', 红: 'red', 红色: 'red', crimson: 'red', 深红: 'red',
    blue: 'blue', 蓝: 'blue', 蓝色: 'blue',
    green: 'green', 绿: 'green', 绿色: 'green',
    orange: 'orange', 橙: 'orange', 橙色: 'orange',
    purple: 'purple', 紫: 'purple', 紫色: 'purple',
    teal: 'teal', 青: 'teal', 青色: 'teal', cyan: 'teal',
    pink: 'pink', 粉: 'pink', 粉色: 'pink',
    gold: 'gold', 金: 'gold', 金色: 'gold', yellow: 'gold', 黄: 'gold', 黄色: 'gold',
    gray: 'gray', grey: 'gray', 灰: 'gray', 灰色: 'gray',
    brown: 'brown', 棕: 'brown', 棕色: 'brown', 咖啡: 'brown',
    olive: 'olive', 橄榄: 'olive',
    accent: 'accent', 强调: 'accent', 高亮: 'accent',
  };
  const colors = [];
  t = t.replace(/^:::color[ \t]+(.+)\n([\s\S]*?)^:::[ \t]*$/gm, (_, name, body) => {
    const raw = String(name || '').trim();
    const cls = COLOR_ALIAS[raw] || COLOR_ALIAS[raw.toLowerCase()] || '';
    if (!cls) return _;
    colors.push({ cls, body });
    return `\n\n\uE000COLOR${colors.length - 1}\uE000\n\n`;
  });

  const restoreCb = (html) => html.replace(/\uE000CB(\d+)\uE000/g, (_, i) => {
    const { lang, code } = codeBlocks[+i];
    return fenceHtml(lang, code, esc);
  });
  const restoreMath = (html) => html.replace(/\uE000M(\d+)\uE000/g, (_, i) => maths[+i]); // KaTeX 输出已是安全 HTML
  const restoreWidgets = (html) => {
    const foldAt = (_, i) => {
      const f = folds[+i];
      const innerMd = getMd();
      const inner = innerMd ? innerMd.render(f.body) : `<p>${esc(f.body)}</p>`;
      return `<div class="md-fold" role="button" tabindex="0"><span class="chip-ico">${ICON.chevRight || ''}</span><span class="chip-name">${esc(f.title)}</span><div class="chip-detail"><div class="fold-inner md-fold-body">${inner}</div></div></div>`;
    };
    const fontAt = (_, i) => {
      const f = fonts[+i];
      const innerMd = getMd();
      const inner = innerMd ? innerMd.render(f.body) : `<p>${esc(f.body)}</p>`;
      return `<div class="md-font md-font-${f.cls}">${inner}</div>`;
    };
    const colorAt = (_, i) => {
      const f = colors[+i];
      const innerMd = getMd();
      const inner = innerMd ? innerMd.render(f.body) : `<p>${esc(f.body)}</p>`;
      return `<div class="md-color md-c-${f.cls}">${inner}</div>`;
    };
    const alignAt = (_, i) => {
      const a = aligns[+i];
      const innerMd = getMd();
      const inner = innerMd ? innerMd.render(a.body) : `<p>${esc(a.body)}</p>`;
      return `<div class="md-align md-align-${a.cls}">${inner}</div>`;
    };
    const chartAt = (_, i) => {
      const c = charts[+i];
      return renderQuickChart(c.kind, c.body, c.title);
    };
    const diagramAt = (_, i) => {
      const d = diagrams[+i];
      return renderQuickDiagram(d.kind, d.body, d.title);
    };
    let out = html.replace(/<p>\s*\uE000FOLD(\d+)\uE000\s*<\/p>/g, foldAt)
      .replace(/\uE000FOLD(\d+)\uE000/g, foldAt)
      .replace(/<p>\s*\uE000ALIGN(\d+)\uE000\s*<\/p>/g, alignAt)
      .replace(/\uE000ALIGN(\d+)\uE000/g, alignAt)
      .replace(/<p>\s*\uE000CHART(\d+)\uE000\s*<\/p>/g, chartAt)
      .replace(/\uE000CHART(\d+)\uE000/g, chartAt)
      .replace(/<p>\s*\uE000DIAGRAM(\d+)\uE000\s*<\/p>/g, diagramAt)
      .replace(/\uE000DIAGRAM(\d+)\uE000/g, diagramAt)
      .replace(/<p>\s*\uE000FONT(\d+)\uE000\s*<\/p>/g, fontAt)
      .replace(/\uE000FONT(\d+)\uE000/g, fontAt)
      .replace(/<p>\s*\uE000COLOR(\d+)\uE000\s*<\/p>/g, colorAt)
      .replace(/\uE000COLOR(\d+)\uE000/g, colorAt)
      .replace(/\uE000IC(\d+)\uE000/g, (_, i) => `<code>${esc(inlineCodes[+i])}</code>`);
    if (peeled.blocks.length) out += choiceHtml(peeled.blocks);
    return out;
  };

  const md = getMd();
  if (md) {
    let html = md.render(t);
    html = restoreWidgets(html);
    html = restoreCb(html);
    html = restoreMath(html);
    // 独占一段的代码块去掉外层 <p>，避免 <p><pre> 嵌套
    return html.replace(/<p>(<pre[\s\S]*?<\/pre>)<\/p>/g, '$1');
  }

  // ── 内置精简回退（markdown-it 未加载时）──
  t = esc(t);
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/!\[([^\]]*)\]\((sandbox:\/\/[^)]+)\)/gi, (_, alt, src) => {
    const sb = sandboxPath(src);
    return sb ? `<img src="" alt="${alt}" data-sandbox="${esc(sb)}" class="sb-img">` : '';
  });
  t = t.replace(/^(#{1,6}) (.*)$/gm, (_, hashes, title) => {
    const n = hashes.length;
    const id = headingSlug(title.replace(/<[^>]+>/g, ''));
    return `<h${n} id="${esc(id)}">${title}</h${n}>`;
  });
  t = t.replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 列表（连续行聚合）
  t = t.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (m) => '\n<ul>' + m.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('') + '</ul>');
  t = t.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (m) => '\n<ol>' + m.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('') + '</ol>');
  t = t.replace(/\n{2,}/g, '</p><p>').replace(/^(?!<[a-z])/, '<p>').replace(/(?!>)$/, '</p>');
  t = t.replace(/<p>\s*(<(?:h\d|ul|ol|blockquote|pre))/g, '$1').replace(/(<\/(?:h\d|ul|ol|blockquote|pre)>)\s*<\/p>/g, '$1');
  return restoreMath(restoreCb(restoreWidgets(t)));
}

// ── Toast ───────────────────────────────────────────────────────────────
export function toast(msg, type = 'info', ms = 2600) {
  const wrap = $('#toasts');
  const t = el('div', `toast ${type}`, `<span>${esc(msg)}</span>`);
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 400); }, ms);
}

// ── 主 UI ───────────────────────────────────────────────────────────────
function fmtSpan(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 1000) return n + 'ms';
  if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
  const min = Math.floor(n / 60000);
  const sec = Math.round((n % 60000) / 1000);
  return sec ? `${min}min ${sec}s` : `${min}min`;
}
function fmtClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s}s`;
}
function fmtAgo(ts) {
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

export function mountUI(store, agent) {
  const msgList = $('#messages');
  const composer = $('#composer-input');
  const sendBtn = $('#send-btn');
  const statusDot = $('#status-dot');
  const statusText = $('#status-text');
  const msgNodes = new Map();

  let rafPending = false;
  let rafMsg = null;
  const schedulePaint = (m) => {
    if (!m || !msgNodes.get(m.id)) return;
    rafMsg = m;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const msg = rafMsg;
      rafMsg = null;
      if (!msg) return;
      const w = msgNodes.get(msg.id);
      if (w) paintAssistant(w, msg);
      scrollToBottom();
    });
  };

  // ── 主题 ──
  const applyTheme = () => document.documentElement.dataset.theme = store.state.settings.theme;
  applyTheme();
  $('#theme-toggle').addEventListener('click', () => {
    store.state.settings.theme = store.state.settings.theme === 'light' ? 'dark' : 'light';
    applyTheme(); store.notify();
  });

  // ── 模型下拉 ──
  const ddBtn = $('#model-btn');
  const ddMenu = $('#model-menu');
  const ddSearch = $('#model-search');
  // 网关仍可能返回已下线的福利档；本地兜底表删了也不够，这里再挡一层。
  const HIDDEN_MODELS = new Set(['glm-5.3-flash-free']);
  // 对话模型列表：过滤掉生图模型（只能由主智能体通过 generate_image 工具调用，
  // 直接选中会绕过工具循环、破坏 Agent 特性；网关 /v1/models 里带它们时也照样隐藏）
  function mergedModels() {
    const map = new Map();
    for (const m of FALLBACK_MODELS) {
      if (HIDDEN_MODELS.has(m.id) || isImageModel(m.id) || isJevModel(m.id)) continue;
      map.set(m.id, { ...m });
    }
    for (const id of store.state.models || []) {
      if (HIDDEN_MODELS.has(id) || isImageModel(id) || isJevModel(id)) continue;
      if (!map.has(id)) map.set(id, { id, provider: providerOf(id) });
    }
    return [...map.values()];
  }
  if (HIDDEN_MODELS.has(store.state.model)) {
    store.state.model = 'claude-sonnet-5';
    store.notify();
  }
  function renderModelMenu() {
    const q = ddSearch.value.trim().toLowerCase();
    // 隐藏通道：搜索 /system 出现「系统命令识别器」（输入命令获取系统反馈，如 /debug on）
    if (q === '/system' || q.startsWith('/system ')) {
      ddMenu.querySelectorAll('.dd-group, .dd-empty').forEach((n) => n.remove());
      const g = el('div', 'dd-group');
      g.appendChild(el('div', 'dd-group-title', `<span class="sys-gear">${ICON.system}</span><span>Teamo</span>`));
      const item = el('button', 'dd-item' + (store.state.model === '__system__' ? ' active' : ''));
      item.type = 'button';
      // 简约：一行式条目（图标 + 名称），介绍信息省略
      item.innerHTML = '<span class="dd-item-id mono">system-commands</span>';
      item.addEventListener('click', () => selectModel('__system__'));
      g.appendChild(item);
      ddMenu.appendChild(g);
      const foot = $('.dd-foot', ddMenu);
      if (foot) ddMenu.appendChild(foot);
      return;
    }
    const list = mergedModels().filter((m) => !q || m.id.toLowerCase().includes(q));
    const groups = new Map();
    for (const m of list) {
      if (!groups.has(m.provider)) groups.set(m.provider, []);
      groups.get(m.provider).push(m);
    }
    const order = [...PROVIDER_ORDER.filter((p) => groups.has(p)), ...[...groups.keys()].filter((p) => !PROVIDER_ORDER.includes(p))];
    ddMenu.querySelectorAll('.dd-group, .dd-empty').forEach((n) => n.remove());
    for (const p of order) {
      const g = el('div', 'dd-group');
      g.appendChild(el('div', 'dd-group-title', `${providerIcon(p)}<span>${esc(p)}</span>`));
      for (const m of groups.get(p)) {
        const item = el('button', 'dd-item' + (m.id === store.state.model ? ' active' : ''));
        item.type = 'button';
        const hit = FALLBACK_MODELS.find((x) => x.id === m.id) || {};
        const free = isFreeModel(m.id);
        const hot = !!hit.hot;
        const cheap = !!hit.cheap || free || /haiku|mini|lite|-free$/i.test(m.id);
        const encThink = ENCRYPTED_THINKING_RE.test(m.id) || !!(store.state.observedHiddenThink && store.state.observedHiddenThink[m.id]);
        item.innerHTML = `<span class="dd-item-id mono">${esc(m.id)}</span>
          <span class="dd-item-badges">
            ${hot ? '<span class="badge hot">热门</span>' : ''}
            ${free ? '<span class="badge">FREE</span>' : (cheap ? '<span class="badge cheap">低价</span>' : '')}
            ${encThink ? '<span class="badge enc" title="该模型的思考链已加密（不返回可见思考正文）">思考链已加密</span>' : ''}
            ${supportsVision(m.id) ? '<span class="badge vision" title="支持图片输入（多模态）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></span>' : ''}
          </span>`;
        item.addEventListener('click', () => selectModel(m.id));
        g.appendChild(item);
      }
      ddMenu.appendChild(g);
    }
    if (!order.length) ddMenu.appendChild(el('div', 'dd-empty', '无匹配模型'));
    const foot = $('.dd-foot', ddMenu);
    if (foot) ddMenu.appendChild(foot); // 生图模型行始终排在分组之后（sticky bottom 生效）
  }
  // ── /system 通道隔离（.17）：进入时收起真实会话现场、换一次性草稿；
  // state.js 的 commit 对 __system__ 直接跳过 → 真实会话零写入，退出后原样恢复 ──
  let preSystem = null;
  const inSystem = () => store.state.model === '__system__';
  function enterSystem() {
    if (preSystem) return;
    preSystem = { messages: store.state.messages, checkpoints: store.state.checkpoints, files: store.state.files };
    store.state.messages = []; store.state.checkpoints = []; store.state.files = {};
    // 沙箱文件也要隔离：agent.fs 换成空的（真实文件随 preSystem 暂存，退出时恢复）
    try { agent.loadFiles({}); } catch { /* 忽略 */ }
    rebuildMessages(); renderSessions(); renderFiles(); updateStats();
    syncCapLine(); // 能力行同步显示通道态，不再定格上一个模型（.18）
  }
  function exitSystem() {
    if (!preSystem) return;
    store.state.messages = preSystem.messages; store.state.checkpoints = preSystem.checkpoints; store.state.files = preSystem.files;
    preSystem = null;
    try { agent.loadFiles(store.state.files); } catch { /* 忽略 */ }
    rebuildMessages(); renderSessions(); renderFiles(); updateStats();
    syncCapLine();
  }
  // 通道内：思考/沙箱按钮灰置，会话列表禁点（防止系统输出混进 Agent 会话）
  function applySystemLock() {
    const sys = inSystem();
    for (const sel of ['#thinking-toggle', '#sandbox-toggle']) {
      const b = $(sel);
      if (!b) continue;
      b.disabled = sys;
      b.classList.toggle('sys-locked', sys);
    }
    const list = $('#session-list');
    if (list) list.classList.toggle('sys-locked', sys);
  }
  function selectModel(id) {
    if (!id) return;
    if (id === '__system__') {
      if (preSystem) { closeMenu(); return; }
      if (getBusy()) { closeMenu(); return toast('请等待当前回合结束再进入系统命令通道', 'warn'); }
      store.state.model = id;
      enterSystem();
      store.notify();
      updateModelBtn(); closeMenu(); applySystemLock();
      toast('已进入 /system 隐藏通道：直接输入 /help 查看命令（真实会话不会被写入）', 'ok', 4200);
      return;
    }
    if (preSystem) {
      if (getBusy()) { closeMenu(); return toast('请等待当前回合结束', 'warn'); }
      store.state.model = id;
      exitSystem();
      store.notify();
      updateModelBtn(); closeMenu(); applySystemLock();
      syncCapLine();
      toast('已退出隐藏通道，回到原会话', 'ok', 2400);
      return;
    }
    store.state.model = id; store.notify();
    if (typeof syncWeb === 'function') syncWeb();
    updateModelBtn(); closeMenu();
    const fast = $('#fast-toggle');
    if (fast) {
      fast.disabled = !supportsFastMode(id);
      if (store.state.settings.fastMode && !supportsFastMode(id)) {
        store.state.settings.fastMode = false; fast.classList.remove('on');
      }
    }
    syncCapLine();
  }
  function chatModels() {
    return mergedModels();
  }
  function updateModelBtn() {
    const sys = store.state.model === '__system__';
    $('#model-btn-icon').innerHTML = sys ? `<span class="sys-gear">${ICON.system || '⚙'}</span>` : providerIcon(providerOf(store.state.model));
    $('#model-btn-name').textContent = sys ? 'system-commands' : store.state.model;
    $('#model-btn-provider').textContent = sys ? 'Teamo' : providerOf(store.state.model);
    syncImageModelSelect();
  }
  // 生图模型（由 Agent 调用，不作为对话模型）：与会话绑定，切会话时同步显示
  function syncImageModelSelect() {
    const sel = $('#image-model');
    if (!sel) return;
    if (!sel.options.length) {
      for (const m of IMAGE_MODELS) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = `${m.label}（${m.note}）`;
        o.title = `模型 ID：${m.id}`;
        sel.appendChild(o);
      }
    }
    // 会话里存的值可能来自旧版本/导入：不在目录内就退回默认，避免 select 显示空值
    let want = store.state.imageModel;
    if (!IMAGE_MODELS.some((m) => m.id === want)) {
      want = DEFAULT_IMAGE_MODEL;
      store.state.imageModel = want;
    }
    if (sel.value !== want) sel.value = want;
  }
  $('#image-model')?.addEventListener('change', (e) => {
    store.state.imageModel = e.target.value;
    store.notify();
    toast(`生图模型已切换为 ${imageModelLabel(e.target.value)}（由 Agent 的 generate_image 工具调用）`, 'ok');
  });
  const openMenu = () => {
    renderModelMenu();
    // fixed 定位（脱离侧栏 overflow:hidden 裁剪），按按钮实际位置摆放
    const r = ddBtn.getBoundingClientRect();
    ddMenu.style.left = `${r.left}px`;
    ddMenu.style.top = `${r.bottom + 6}px`;
    ddMenu.style.width = `${Math.max(r.width + 60, 260)}px`;
    ddMenu.classList.add('open');
  };
  const closeMenu = () => ddMenu.classList.remove('open');
  ddBtn.addEventListener('click', () => ddMenu.classList.contains('open') ? closeMenu() : openMenu());
  ddSearch.addEventListener('input', renderModelMenu);
  // 搜索框一键清空（.18）
  const ddClear = $('#model-search-clear');
  if (ddClear) {
    const syncClear = () => { ddClear.hidden = !ddSearch.value; };
    ddSearch.addEventListener('input', syncClear);
    ddClear.addEventListener('click', () => { ddSearch.value = ''; syncClear(); renderModelMenu(); ddSearch.focus(); });
    syncClear();
  }
  document.addEventListener('click', (e) => { if (!$('#model-picker').contains(e.target)) closeMenu(); });
  window.addEventListener('resize', closeMenu);
  updateModelBtn();

  $('#refresh-models').addEventListener('click', async () => {
    if (!store.state.apiKey) return openKeyModal();
    $('#refresh-models').classList.add('spin');
    try {
      const list = await fetchModels(effectiveApiKey(store.state.apiKey));
      store.state.models = list; store.notify();
      renderModelMenu();
      toast(`已获取 ${list.length} 个模型（GET /v1/models）`, 'ok');
    } catch (err) { toast('模型列表获取失败：' + err.message, 'err'); }
    finally { $('#refresh-models').classList.remove('spin'); }
  });

  // ── 开关 ──
  const sandboxToggle = $('#sandbox-toggle');
  const syncSandbox = () => { sandboxToggle.classList.toggle('on', store.state.settings.sandboxEnabled); syncCapLine(); };
  sandboxToggle.addEventListener('click', () => {
    store.state.settings.sandboxEnabled = !store.state.settings.sandboxEnabled;
    syncSandbox(); store.notify();
    toast(store.state.settings.sandboxEnabled
      ? '沙箱已开启：Agent 可执行 JS/Python/C++ 代码'
      : '代码沙箱已关闭：不再执行代码，文件读写、生图与子智能体委派仍可用');
  });
  syncSandbox();

  // 联网：只有探测到本地中继（server.py）才能开。无中继（GitHub Pages）始终灰、点不了。
  // 打开后 Agent 可用 fetch_url 抓网页；原生网页搜索仍不下发。
  const GLOBE_SVG = '<svg class="pill-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6"/><path d="M3.2 14.5h17.6"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/></svg>';
  const webToggle = $('#web-toggle');
  const hasRelay = () => store.state.relayOk === true;
  const syncWeb = () => {
    if (!webToggle) return;
    webToggle.innerHTML = GLOBE_SVG + '联网';
    if (!hasRelay()) {
      webToggle.disabled = true;
      webToggle.classList.remove('on');
      webToggle.title = '未检测到本地中继（python3 server.py）。没有中继时联网不可用，按钮保持灰色。';
      syncCapLine();
      return;
    }
    webToggle.disabled = false;
    const on = store.state.settings.webEnabled !== false;
    webToggle.classList.toggle('on', on);
    webToggle.title = on
      ? '联网已开：经本地中继用 fetch_url 抓取网页。再点关闭。'
      : '联网已关。点此开启（经本地中继抓取网页）。';
    syncCapLine();
  };
  if (webToggle) {
    webToggle.addEventListener('click', () => {
      if (webToggle.disabled || !hasRelay()) return;
      store.state.settings.webEnabled = store.state.settings.webEnabled === false;
      store.notify();
      syncWeb();
      toast(store.state.settings.webEnabled !== false
        ? '联网已开：可经中继抓取网页'
        : '联网已关', store.state.settings.webEnabled !== false ? 'ok' : 'warn');
    });
    syncWeb();
  }

  // 思考模式：关闭 或 Mini/Low/Medium/High/Max/Ultra（按模型家族映射协议参数）
  const thinkingToggle = $('#thinking-toggle');
  const thinkMenu = $('#think-menu');
  const thinkPicker = $('#think-picker');
  const closeThinkMenu = () => {
    if (thinkMenu) thinkMenu.classList.remove('open');
    if (thinkingToggle) thinkingToggle.setAttribute('aria-expanded', 'false');
  };
  const syncThinking = () => {
    const on = store.state.settings.thinking !== false;
    thinkingToggle.classList.toggle('on', on);
    thinkingToggle.classList.toggle('ultra', on && normalizeReasoningLevel(store.state.settings.reasoningLevel) === 'ultra');
    thinkingToggle.title = on
      ? `推理级别 ${reasoningLevelLabel(store.state.settings.reasoningLevel)}（点击切换 Mini/Low/Medium/High/Max/Ultra）`
      : '思考已关闭（点击选择推理级别）';
    syncCapLine();
  };
  const renderThinkMenu = () => {
    if (!thinkMenu) return;
    const on = store.state.settings.thinking !== false;
    const cur = normalizeReasoningLevel(store.state.settings.reasoningLevel);
    const rows = [`<button type="button" class="think-item${on ? '' : ' active'}" data-think="off"><span class="think-lab">Off</span><span class="think-hint">不发送思考参数</span></button>`];
    for (const lv of REASONING_LEVELS) {
      rows.push(`<button type="button" class="think-item${on && cur === lv ? ' active' : ''}" data-think="${lv}"><span class="think-lab">${reasoningLevelLabel(lv)}</span><span class="think-hint">${reasoningLevelHint(lv)}</span></button>`);
    }
    thinkMenu.innerHTML = rows.join('');
  };
  const openThinkMenu = () => {
    renderThinkMenu();
    const r = thinkingToggle.getBoundingClientRect();
    thinkMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 200))}px`;
    thinkMenu.style.top = `${r.bottom + 6}px`;
    thinkMenu.style.width = '196px';
    thinkMenu.classList.add('open');
    thinkingToggle.setAttribute('aria-expanded', 'true');
  };
  thinkingToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (thinkMenu && thinkMenu.classList.contains('open')) closeThinkMenu();
    else openThinkMenu();
  });
  if (thinkMenu) {
    thinkMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-think]');
      if (!btn) return;
      const v = btn.getAttribute('data-think');
      if (v === 'off') {
        store.state.settings.thinking = false;
        toast('思考 Off');
      } else {
        store.state.settings.thinking = true;
        store.state.settings.reasoningLevel = normalizeReasoningLevel(v);
        toast(`推理级别 ${reasoningLevelLabel(v)}`);
      }
      store.notify();
      syncThinking();
      closeThinkMenu();
    });
  }
  document.addEventListener('click', (e) => {
    if (thinkPicker && !thinkPicker.contains(e.target)) closeThinkMenu();
  });
  window.addEventListener('resize', closeThinkMenu);
  syncThinking();

  const fastToggle = $('#fast-toggle');
  const syncFast = () => {
    fastToggle.classList.toggle('on', store.state.settings.fastMode);
    fastToggle.disabled = !supportsFastMode(store.state.model);
  };
  fastToggle.addEventListener('click', () => {
    store.state.settings.fastMode = !store.state.settings.fastMode;
    syncFast(); store.notify();
    toast(store.state.settings.fastMode ? '快速模式开启（service_tier=fast，2x 计费，仅 GPT 系列）' : '快速模式关闭');
  });
  syncFast();

  // ── API Key 弹窗（role=dialog + Esc 关闭 + 焦点圈定，a11y P2-3）──
  const keyModal = $('#key-modal');
  const keyInput = $('#key-input');
  let modalReturnFocus = null;
  window.openKeyModal = openKeyModal;
  function openKeyModal() {
    modalReturnFocus = document.activeElement;
    keyInput.value = store.state.apiKey;
    keyModal.classList.add('open');
    setTimeout(() => keyInput.focus(), 100);
  }
  function closeKeyModal() {
    if (!keyModal.classList.contains('open')) return;
    keyModal.classList.remove('open');
    // 归还焦点，键盘用户不迷失
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
    modalReturnFocus = null;
  }
  $('#key-btn').addEventListener('click', openKeyModal);
  $('#key-close').addEventListener('click', closeKeyModal);
  // 点击遮罩区域关闭
  keyModal.addEventListener('click', (e) => { if (e.target === keyModal) closeKeyModal(); });
  document.addEventListener('keydown', (e) => {
    if (!keyModal.classList.contains('open')) return;
    if (e.key === 'Escape') { closeKeyModal(); return; }
    // 焦点圈定：Tab 只在弹窗内循环
    if (e.key === 'Tab') {
      const focusables = [$('#key-close'), keyInput, $('#key-save')];
      const idx = focusables.indexOf(document.activeElement);
      if (idx < 0) return;
      if (e.shiftKey && idx === 0) { e.preventDefault(); focusables[focusables.length - 1].focus(); }
      else if (!e.shiftKey && idx === focusables.length - 1) { e.preventDefault(); focusables[0].focus(); }
    }
  });
  $('#key-save').addEventListener('click', async () => {
    const typed = keyInput.value.trim();
    // 管理员别名：先用口令解封（解不开就拒绝保存，避免存进去一把用不了的 key）
    if (isAdminAlias(typed)) {
      const r = await unlockAdminKey(typed);
      if (!r.ok) {
        return toast(r.reason === 'bad-password' ? '管理员口令不正确（admin- 开头的密钥会被当作管理员口令）' : '管理员密钥不可用',
          'err', 5200);
      }
      store.state.apiKey = typed; store.notify();
      closeKeyModal();
      toast('管理员密钥已启用：请求会用管理员密钥发出（明文密钥不落盘、不上屏）', 'ok', 4200);
      updateKeyBtn(); updateTransportBadge();
      return;
    }
    store.state.apiKey = typed; store.notify();
    closeKeyModal();
    toast(store.state.apiKey ? 'API Key 已保存（仅存于浏览器 localStorage）' : 'API Key 已清除', 'ok');
    updateKeyBtn(); updateTransportBadge();
  });
  // 底部「API Key」按钮的文案：管理员模式下明确标出来（但不显示密钥任何片段）
  function updateKeyBtn() {
    const b = $('#key-btn');
    if (!b) return;
    const admin = isAdminAlias(store.state.apiKey);
    b.textContent = admin ? '管理员' : 'API Key';
    b.classList.toggle('admin-mode', admin);
    b.title = admin
      ? (adminUnlocked() ? '管理员密钥已启用（请求使用管理员密钥，明文不落盘）' : '管理员密钥未解封：点开重新输入口令')
      : '填入 TeamoRouter API Key（或管理员口令）';
  }
  updateKeyBtn();
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#key-save').click(); });

  // ── 会话记录（侧栏只做记录与切换；回滚全部在对话区）─────────────────
  function sessionActivityAt(s) {
    const msgs = (s && Array.isArray(s.messages)) ? s.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const ts = Number(msgs[i] && msgs[i].ts);
      if (ts > 0) return ts;
    }
    return Number((s && (s.createdAt || s.updatedAt)) || Date.now());
  }
  function startOfDay(ts) {
    const d = new Date(ts || Date.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function sessionSpanLabel(ts) {
    const days = Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days === 2) return '前天';
    if (days <= 6) return '7天内';
    if (days <= 29) return '30天内';
    return '更早';
  }
  function sessionMeta(s) {
    const n = (s.messages || []).filter((m) => m.role === 'user').length;
    const t = new Date(sessionActivityAt(s));
    const time = t.toDateString() === new Date().toDateString()
      ? t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : `${t.getMonth() + 1}/${t.getDate()}`;
    return `${n} 轮 · ${time}`;
  }
  let memSelected = new Set();
  function syncMemDelBtn() {
    const btn = $('#memory-del');
    if (!btn) return;
    const n = memSelected.size;
    btn.disabled = n === 0;
    btn.textContent = n ? `删除 ${n}` : '删除';
  }
  function renderMemory() {
    const box = $('#memory-list');
    if (!box) return;
    const list = Array.isArray(store.state.memory) ? store.state.memory : [];
    box.innerHTML = '';
    memSelected = new Set([...memSelected].filter((i) => i >= 0 && i < list.length));
    if (!list.length) {
      box.innerHTML = '<div class="mem-empty">还没有长效记忆。重要约定由智能体自行记下，不能在这里手写。</div>';
      memSelected = new Set();
      syncMemDelBtn();
      return;
    }
    for (const [i, f] of list.entries()) {
      const text = String((f && (f.text || f)) || '').trim();
      if (!text) continue;
      const bubble = el('button', 'mem-bubble' + (memSelected.has(i) ? ' selected' : ''));
      bubble.type = 'button';
      bubble.setAttribute('role', 'listitem');
      bubble.dataset.mem = String(i);
      bubble.setAttribute('aria-pressed', memSelected.has(i) ? 'true' : 'false');
      bubble.title = '点击选中，可多选后删除';
      bubble.textContent = text;
      box.appendChild(bubble);
    }
    syncMemDelBtn();
  }
  function commitMemory(next) {
    store.state.memory = Array.isArray(next) ? next : [];
    if (typeof store.save === 'function') store.save(true);
    renderMemory();
  }
  const memListEl = $('#memory-list');
  if (memListEl) memListEl.addEventListener('click', (e) => {
    const bubble = e.target.closest('[data-mem]');
    if (!bubble || !memListEl.contains(bubble)) return;
    const i = Number(bubble.getAttribute('data-mem'));
    if (!Number.isInteger(i) || i < 0) return;
    if (memSelected.has(i)) memSelected.delete(i);
    else memSelected.add(i);
    bubble.classList.toggle('selected', memSelected.has(i));
    bubble.setAttribute('aria-pressed', memSelected.has(i) ? 'true' : 'false');
    syncMemDelBtn();
  });
  const memDel = $('#memory-del');
  if (memDel) memDel.addEventListener('click', () => {
    if (!memSelected.size) return;
    const cur = Array.isArray(store.state.memory) ? store.state.memory : [];
    const n = memSelected.size;
    if (!confirm(`删除选中的 ${n} 条长效记忆？不可恢复。`)) return;
    const next = cur.filter((_, i) => !memSelected.has(i));
    memSelected = new Set();
    commitMemory(next);
  });

  // 侧栏只列「有内容的」会话：空的「新对话」草稿在用户发出第一条消息之前不进列表
  //（store.listableSessions 负责过滤，「＋ 新建」也会复用空草稿，不堆 invisible 记录）
  function renderSessions() {
    const box = $('#session-list'); box.innerHTML = '';
    box.classList.toggle('sys-locked', inSystem());
    const list = store.listableSessions ? store.listableSessions() : store.sortedSessions();
    if (!list.length) {
      box.appendChild(el('div', 'sess-empty-hint', '还没有会话记录'));
      return;
    }
    let lastSpan = '';
    for (const s of list) {
      const span = sessionSpanLabel(sessionActivityAt(s));
      if (span !== lastSpan) {
        const sep = el('div', 'sess-date-sep');
        sep.textContent = span;
        box.appendChild(sep);
        lastSpan = span;
      }
      const node = el('div', 'sess-item' + (s.id === store.state.activeSessionId ? ' active' : ''));
      node.innerHTML = `<span class="sess-main"><span class="sess-title">${esc(s.title || '新对话')}</span><span class="sess-meta">${sessionMeta(s)}</span></span>`
        + `<button class="sess-rename" type="button" title="重命名会话">${ICON.pencil || ''}</button>`
        + `<button class="sess-del" type="button" title="删除会话" aria-label="删除会话「${esc(s.title || '新对话')}」">${ICON.x}</button>`;
      node.addEventListener('click', () => switchToSession(s.id));
      const del = $('.sess-del', node);
      if (del) del.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasActive = s.id === store.state.activeSessionId;
        if (getBusy() && wasActive) return toast('当前会话正在输出，不能删这一条', 'warn');
        if (!confirm(`删除会话「${s.title || '新对话'}」？不可恢复。`)) return;
        store.deleteSession(s.id);
        if (wasActive) {
          agent.loadFiles(store.state.files);
          rebuildMessages(); renderFiles(); updateStats(); updateModelBtn();
        }
        renderSessions();
        toast('会话已删除');
      });
      const rename = $('.sess-rename', node);
      if (rename) {
        rename.addEventListener('click', (e) => { e.stopPropagation(); startRename(node, s); });
        // 双击标题也进改名（桌面用户的直觉路径）
        $('.sess-title', node).addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(node, s); });
      }
      box.appendChild(node);
    }
    renderMemory();
  }

  // 就地改名：Enter 提交、Esc 取消、失焦提交；改名后 titleSource='user'，
  // Agent 的自动总结不再覆盖它
  function startRename(node, s) {
    const span = $('.sess-title', node);
    if (!span || $('.sess-rename-input', node)) return;
    const input = el('input', 'sess-rename-input');
    input.type = 'text';
    input.value = s.title || '';
    input.maxLength = 48;
    input.setAttribute('aria-label', '重命名会话');
    span.replaceWith(input);
    input.focus(); input.select();
    let closed = false;
    const done = (commit) => {
      if (closed) return;
      closed = true;
      const v = input.value.trim();
      input.replaceWith(span);
      if (commit && v && v !== (s.title || '') && typeof store.renameSession === 'function') {
        store.renameSession(s.id, v);
        toast('会话已重命名', 'ok', 1400);
      }
      renderSessions();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    input.addEventListener('blur', () => done(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }
  function switchToSession(id) {
    if (id === store.state.activeSessionId) return;
    if (inSystem()) return toast('系统命令通道内不能进入其他会话：先在模型菜单选回普通模型', 'warn');
    if (getBusy()) return toast('请等待当前回合结束再切换会话', 'warn');
    store.switchSession(id);
    agent.loadFiles(store.state.files);
    // 模型随会话恢复：切回来后模型按钮显示该会话自己的模型，而不是上一次的全局选择
    rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats(); updateModelBtn();
    syncThinking(); syncCapLine();
  }
  $('#new-session').addEventListener('click', () => {
    if (inSystem()) return toast('系统命令通道内不能新建会话：先在模型菜单选回普通模型', 'warn');
    if (getBusy()) return toast('请等待当前回合结束', 'warn');
    (store.ensureDraft ? store.ensureDraft() : store.createSession());
    agent.loadFiles({});
    rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats(); updateModelBtn();
    syncThinking(); syncCapLine();
    composer.focus();
  });
  // 一键清除所有会话记录（含各自的沙箱文件与检查点）：不可恢复，所以必须确认
  $('#clear-sessions').addEventListener('click', () => {
    if (getBusy()) return toast('请等待当前回合结束', 'warn');
    const n = (store.listableSessions ? store.listableSessions() : store.sortedSessions()).length;
    if (!n) { toast('当前没有任何会话记录'); return; }
    if (!confirm(`清除全部 ${n} 条会话记录？所有消息、检查点与沙箱文件都会被删除，且不可恢复。`)) return;
    if (!confirm('再次确认：此操作不可恢复。确定清空全部会话？')) return;
    if (typeof store.clearAllSessions !== 'function') {
      return toast('浏览器缓存了旧版本代码，请硬刷新（Ctrl/Cmd + Shift + R）后再用「清空」', 'warn', 5000);
    }
    const removed = store.clearAllSessions();
    agent.loadFiles({});
    rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats(); updateModelBtn();
    toast(`已清除 ${removed || n} 条会话记录`, 'ok');
    composer.focus();
  });
  renderSessions();

  // ── 回滚撤销浮条（对话区内，回滚后出现 8 秒）+ 粒子粉碎动画（Requirement 6）──
  const undoPill = $('#undo-pill');
  let undoTimer = null;
  let activeRollbackAnim = null;
  function cancelRollbackAnim() {
    if (activeRollbackAnim && typeof activeRollbackAnim.cancel === 'function') {
      activeRollbackAnim.cancel();
    }
    activeRollbackAnim = null;
  }
  function showUndoPill() {
    undoPill.classList.add('show');
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => undoPill.classList.remove('show'), 8000);
  }
  undoPill.addEventListener('click', () => {
    cancelRollbackAnim();
    undoPill.classList.remove('show');
    if (store.undoRollback()) { rebuildMessages(); renderSessions(); updateStats(); toast('已撤销回滚'); }
  });
  function disintegrateMessageNodes(nodes, onDone) {
    cancelRollbackAnim();
    const list = (nodes || []).filter((n) => n && n.isConnected);
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!list.length || reduced || typeof HTMLCanvasElement === 'undefined') {
      onDone && onDone();
      return;
    }
    const hostRect = msgList.getBoundingClientRect();
    if (!(hostRect.width > 0 && hostRect.height > 0)) {
      onDone && onDone();
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement('canvas');
    canvas.className = 'rollback-particle-canvas';
    canvas.style.cssText = `position:fixed;left:${hostRect.left}px;top:${hostRect.top}px;width:${hostRect.width}px;height:${hostRect.height}px;pointer-events:none;z-index:60;`;
    canvas.width = Math.round(hostRect.width * dpr);
    canvas.height = Math.round(hostRect.height * dpr);
    document.body.appendChild(canvas);
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) {
      canvas.remove();
      onDone && onDone();
      return;
    }
    ctx.scale(dpr, dpr);
    const dark = document.documentElement.dataset.theme === 'dark';
    const palette = dark
      ? ['#93c5fd', '#60a5fa', '#a5b4fc', '#e2e8f0', '#94a3b8', '#38bdf8']
      : ['#3b82f6', '#2563eb', '#6366f1', '#1e293b', '#475569', '#0ea5e9'];
    const particles = [];
    for (const node of list) {
      const r = node.getBoundingClientRect();
      node.style.height = `${r.height}px`;
      node.classList.add('msg-disintegrating');
      const relX = r.left - hostRect.left;
      const relY = r.top - hostRect.top;
      const w = Math.max(40, Math.min(r.width, hostRect.width));
      const h = Math.max(24, Math.min(r.height, hostRect.height));
      if (relY + r.height < -40 || relY > hostRect.height + 40) continue;
      const area = w * h;
      const count = Math.max(72, Math.min(180, Math.round(area / 420)));
      for (let i = 0; i < count; i++) {
        const px = relX + Math.random() * w;
        const py = Math.max(0, Math.min(hostRect.height, relY + Math.random() * h));
        const wave = ((px - relX) / Math.max(1, w)) * 0.42 + ((py - relY) / Math.max(1, h)) * 0.18;
        const angle = (Math.random() - 0.5) * Math.PI * 1.4 - Math.PI * 0.28;
        const speed = 28 + Math.random() * 96;
        particles.push({
          x: px,
          y: py,
          vx: Math.cos(angle) * speed + (Math.random() - 0.32) * 44,
          vy: Math.sin(angle) * speed - (18 + Math.random() * 48),
          size: 1.8 + Math.random() * 3.8,
          rot: Math.random() * Math.PI * 2,
          vrot: (Math.random() - 0.5) * 9,
          delay: wave * 220 + Math.random() * 60,
          life: 440 + Math.random() * 240,
          color: palette[i % palette.length],
          shard: i % 3 !== 0,
        });
      }
    }
    const t0 = performance.now();
    let lastT = t0;
    let rafId = 0;
    let finished = false;
    const finish = (runCallback) => {
      if (finished) return;
      finished = true;
      if (rafId) cancelAnimationFrame(rafId);
      canvas.remove();
      if (activeRollbackAnim && activeRollbackAnim.canvas === canvas) activeRollbackAnim = null;
      if (runCallback && onDone) onDone();
    };
    activeRollbackAnim = { canvas, cancel: () => finish(false) };
    const tick = (now) => {
      if (finished) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - lastT) / 1000));
      lastT = now;
      const elapsed = now - t0;
      ctx.clearRect(0, 0, hostRect.width, hostRect.height);
      let alive = 0;
      for (const p of particles) {
        const local = elapsed - p.delay;
        if (local < 0) { alive++; continue; }
        const prog = local / p.life;
        if (prog >= 1) continue;
        alive++;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy -= 22 * dt; // 轻盈上浮微粒感
        p.vx *= (1 - 0.9 * dt);
        p.rot += p.vrot * dt;
        const alpha = Math.max(0, (1 - prog) * (1 - prog * 0.65));
        const s = p.size * (1 - prog * 0.45);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shard) {
          ctx.beginPath();
          ctx.moveTo(-s, -s * 0.6);
          ctx.lineTo(s * 1.1, -s * 0.2);
          ctx.lineTo(s * 0.4, s * 1.1);
          ctx.lineTo(-s * 0.8, s * 0.7);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(-s * 0.5, -s * 0.5, s, s);
        }
        ctx.restore();
      }
      if (alive > 0 && elapsed < 780) {
        rafId = requestAnimationFrame(tick);
      } else {
        finish(true);
      }
    };
    rafId = requestAnimationFrame(tick);
  }
  function doRollback(m) {
    if (getBusy()) return toast('请等待当前回合结束');
    if (!confirm('回滚到本轮对话之前？该轮及其后的消息将被移除（可撤销）。')) return;
    const msgs = store.state.messages || [];
    const idx = msgs.findIndex((x) => x.id === m.id);
    let userIdx = idx;
    while (userIdx >= 0 && msgs[userIdx].role !== 'user') userIdx--;
    const targetCount = userIdx >= 0 ? userIdx : idx;
    const discardedIds = new Set(targetCount >= 0 ? msgs.slice(targetCount).map((x) => x.id) : [m.id]);
    const discardedNodes = $$('.msg', msgList).filter((n) => discardedIds.has(n.dataset.id));
    store.rollbackBeforeMessage(m.id);
    renderSessions(); updateStats(); showUndoPill();
    toast('已回滚，可点击「撤销回滚」恢复', 'ok');
    if (discardedNodes.length) {
      disintegrateMessageNodes(discardedNodes, () => rebuildMessages());
    } else {
      rebuildMessages();
    }
  }

  // ── 侧栏 & 沙箱面板收起体系 ───────────────────────────────────────────
  // 宽屏：两者都并入网格（收起=列宽归零，展开=挤压布局，绝不遮挡内容）
  // 中等桌面宽度：沙箱面板改右侧浮层；移动窄屏才自底部全屏滑入，✕ / Esc 收回
  const sidebar = $('.sidebar');
  const panel = $('#sandbox-panel');
  const backdrop = $('#overlay-backdrop');
  const fab = $('#sidebar-fab');
  const mqSidebar = window.matchMedia('(max-width: 860px)');
  const mqPanel = window.matchMedia('(max-width: 1180px)');

  function updateBackdrop() {
    const show = (mqSidebar.matches && sidebar.classList.contains('sidebar-open'))
      || (mqPanel.matches && !panel.classList.contains('collapsed'));
    backdrop.classList.toggle('show', show);
  }
  function setPanelCollapsed(v) {
    panel.classList.toggle('collapsed', v);
    // 以前这里把按钮内容整体替换成两个方块符号字符：既丢掉了 pill 的「SVG 图标 + 中文文字」统一外观，
    // 又在窄屏下把按钮压到 30 多像素宽（点不中）。改成切状态类 + 提示语，外观与其它 pill 一致。
    const btn = $('#panel-toggle');
    btn.classList.toggle('on', !v);
    btn.setAttribute('aria-pressed', v ? 'false' : 'true');
    btn.title = v ? '沙箱面板已收起（文件树 / 下载 / 清空）：点开' : '沙箱面板已展开：点此收起';
    if (typeof syncCapLine === 'function') syncCapLine();
    // 面板浮层会盖住内容：打开时关掉移动侧栏；关闭靠面板内 ✕ / Esc，也可点遮罩。
    if (!v && mqSidebar.matches) sidebar.classList.remove('sidebar-open');
    updateBackdrop();
  }
  function setSidebarOpen(open) {
    sidebar.classList.toggle('sidebar-open', open);
    const t = $('#sidebar-toggle');
    if (t) {
      t.title = mqSidebar.matches ? '关闭侧栏' : '收起侧栏';
      t.setAttribute('aria-label', t.title);
      t.setAttribute('aria-expanded', mqSidebar.matches ? String(open) : String(!sidebar.classList.contains('collapsed')));
    }
    if (open && mqPanel.matches && !panel.classList.contains('collapsed')) setPanelCollapsed(true);
    else updateBackdrop();
  }
  $('#panel-toggle').addEventListener('click', () => setPanelCollapsed(!panel.classList.contains('collapsed')));
  $('#panel-close')?.addEventListener('click', () => setPanelCollapsed(true));
  $$('[data-panel-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.panelTab;
      $$('[data-panel-tab]').forEach((x) => x.classList.toggle('on', x.dataset.panelTab === id));
      const files = $('#tab-files');
      const mem = $('#tab-memory');
      if (files) files.hidden = id !== 'files';
      if (mem) mem.hidden = id !== 'memory';
    });
  });
  $('#sidebar-toggle').addEventListener('click', () => {
    if (mqSidebar.matches) setSidebarOpen(false);
    else sidebar.classList.add('collapsed');
  });
  fab.addEventListener('click', () => {
    if (mqSidebar.matches) setSidebarOpen(!sidebar.classList.contains('sidebar-open'));
    else sidebar.classList.remove('collapsed');
  });
  const dismissDrawers = () => {
    setSidebarOpen(false);
    if (mqPanel.matches) setPanelCollapsed(true);
    else updateBackdrop();
  };
  backdrop.addEventListener('click', dismissDrawers);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (keyModal.classList.contains('open')) return;
    if (sidebar.classList.contains('sidebar-open') || (mqPanel.matches && !panel.classList.contains('collapsed'))) {
      e.preventDefault();
      dismissDrawers();
    }
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!mqSidebar.matches) sidebar.classList.remove('sidebar-open');
      updateBackdrop();
    }, 120);
  });
  // 初始：面板默认收起；侧栏宽屏展开、窄屏隐藏（由 fab 打开）
  setPanelCollapsed(true);
  updateBackdrop();


  // 品牌图标加载失败兜底（捕获阶段监听资源错误）：替换为首字母徽章
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('p-icon')) {
      const span = document.createElement('span');
      span.className = 'p-icon-fallback';
      span.textContent = (t.alt || '?').slice(0, 1);
      t.replaceWith(span);
    }
  }, true);
  // ── 沙箱下载：整包 ZIP / 单个文件（图片按原始二进制还原，可直接打开）──
  const stampName = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  function saveBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const zipName = (path, mime) => withExtension(path.split('/').pop() || 'file', mime && mime.startsWith('image/') ? mime : '');
  function downloadFile(path) {
    let raw;
    try { raw = agent.fs.read(path); } catch { return toast('文件已不存在', 'err'); }
    const { bytes, mime } = fileBytesFromValue(raw);
    const name = zipName(path, mime);
    saveBlob(name, new Blob([bytes], { type: mime }));
    toast(`已下载 ${name}（${fmtSize(bytes.length)}）`, 'ok');
  }
  // 打包：整包（保留目录结构）或单个目录；entries.name 即沙箱内路径
  const zipEntriesOf = (paths) => paths.map((p) => {
    let raw = '';
    try { raw = agent.fs.read(p); } catch { /**/ }
    const { bytes, mime } = fileBytesFromValue(raw);
    return { name: withExtension(p, mime && mime.startsWith('image/') ? mime : ''), bytes };
  });
  let filesZippedOnce = false;
  function saveZip(entries, base) {
    if (!entries.length) return toast('没有可打包的文件', 'warn');
    const blob = createZip(entries);
    saveBlob(`${base}-${stampName()}.zip`, blob);
    filesZippedOnce = true;
    toast(`已打包 ${entries.length} 个文件（${fmtSize(blob.size)}）`, 'ok');
  }
  $('#download-zip').addEventListener('click', () => saveZip(zipEntriesOf(Object.keys(agent.fs.export())), 'teamo-sandbox'));
  $('#clear-files').addEventListener('click', () => {
    const n = Object.keys(agent.fs.export()).length;
    if (!n) return toast('沙箱里没有文件');
    if (!filesZippedOnce) {
      if (!confirm('尚未打包 ZIP。清空后文件无法恢复，仍要清空沙箱？')) return;
    } else if (!confirm('清空虚拟文件系统里的全部文件？此操作不可恢复。')) return;
    if (!confirm('再次确认：确定清空沙箱文件？')) return;
    agent.fs.clear(); store.clearFiles(); renderFiles(); toast('虚拟文件系统已清空');
  });

  // 目录折叠状态：本次页面会话内记住（沙箱是路径即结构，没有真实目录节点）
  const collapsedDirs = new Set();
  // 图片以 data URL 存放，字符串长度会虚高 ~1/3；按 base64 反推真实字节
  const approxBytes = (raw) => {
    const str = String(raw || '');
    if (str.startsWith('data:')) {
      const comma = str.indexOf(',');
      if (comma > 0 && /;base64/i.test(str.slice(0, comma))) return Math.max(0, Math.round((str.length - comma - 1) * 0.75));
    }
    return new TextEncoder().encode(str).length;
  };

  const storageQuota = SANDBOX_STORAGE_CAP; // 产品上限 120MB，不用 navigator.storage 那种 39321.6MB
  const zipEstimateBytes = (files) => {
    // zip.js 使用 STORE（不压缩内容），这里估算「打包后容器大小」：数据字节 + 本地头/中心目录/EOCD。
    // 这样不必每次刷新文件树都真正 createZip / 解码所有大图。
    const enc = new TextEncoder();
    let n = 22;
    for (const f of files || []) {
      const nameLen = enc.encode(String(f.path || '').replace(/^\/+/, '').replace(/\\/g, '/')).length;
      n += Number(f.size || 0) + 30 + nameLen + 46 + nameLen;
    }
    return n;
  };

  function renderFiles() {
    const box = $('#file-list'); box.innerHTML = '';
    const files = agent.fs.list().map((f) => {
      let raw = '';
      try { raw = agent.fs.read(f.path); } catch { /**/ }
      return { path: f.path, size: approxBytes(raw), isImage: /^data:image\//.test(raw) };
    });
    const tree = buildFileTree(files);
    const stat = treeStats(tree);
    const quotaEl = $('#files-count');
    if (quotaEl) {
      quotaEl.textContent = sandboxQuotaLabel(stat.size, storageQuota);
      quotaEl.title = `沙箱已用 ${sandboxQuotaLabel(stat.size, storageQuota)}（上限 120MB）`;
    }
    const nEl = $('#files-n');
    if (nEl) {
      const n = Number(stat.files) || 0;
      nEl.textContent = `${n} 个文件`;
    }
    const zipEl = $('#files-zip');
    if (zipEl) {
      const z = zipEstimateBytes(files);
      zipEl.textContent = `ZIP ≈ ${fmtSize(z)}`;
      zipEl.title = `ZIP 打包后估算体积：${fmtSize(z)}（STORE 容器；未实际下载前仅估算）`;
    }
    if (!tree.length) { box.appendChild(el('div', 'empty-hint', '暂无文件')); return; }
    const imageSet = new Set(files.filter((f) => f.isImage).map((f) => f.path));
    const rows = flattenTree(tree, { isCollapsed: (p) => collapsedDirs.has(p) });
    for (const r of rows) {
      const closed = r.type === 'dir' && collapsedDirs.has(r.path);
      const row = el('div', `ft-row ft-${r.type}${r.type === 'dir' ? (closed ? ' closed' : ' open') : ' file-item'}`);
      row.style.setProperty('--d', r.depth);
      row.dataset.path = r.path;
      row.title = r.type === 'dir' ? `${r.path}/（点击${collapsedDirs.has(r.path) ? '展开' : '折叠'}，共 ${r.count} 个文件）` : r.path;
      if (r.type === 'dir') {
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.setAttribute('aria-expanded', String(!closed));
        row.innerHTML = `<span class="ft-chev">${ICON.chevRight}</span>`
          + `<span class="ft-ico">${closed ? ICON.folder : ICON.folderOpen}</span>`
          + `<span class="ft-name">${esc(r.name)}</span>`
          + `<span class="ft-actions"><button class="files-icon-btn ft-copy" type="button" title="复制文件名">${ICON.copy}</button><button class="files-icon-btn ft-zip" type="button" title="打包 ${esc(r.path)}/">${ICON.download}</button></span>`;
        const toggle = () => {
          if (collapsedDirs.has(r.path)) collapsedDirs.delete(r.path); else collapsedDirs.add(r.path);
          renderFiles();
        };
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        $('.ft-copy', row).addEventListener('click', (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(r.name).then(() => toast('已复制文件名', 'ok', 1200), () => toast('复制失败：浏览器拒绝了剪贴板权限', 'err'));
        });
        $('.ft-zip', row).addEventListener('click', (e) => {
          e.stopPropagation();
          saveZip(zipEntriesOf(collectPaths(r)), `teamo-${r.name || 'folder'}`);
        });
      } else {
        row.innerHTML = `<span class="ft-sp"></span>`
          + `<span class="ft-ico">${imageSet.has(r.path) ? ICON.image : ICON.file}</span>`
          + `<span class="ft-name file-path">${esc(r.name)}</span>`
          + `<span class="ft-actions"><button class="files-icon-btn ft-copy" type="button" title="复制文件名">${ICON.copy}</button><button class="files-icon-btn file-dl" type="button" title="下载此文件">${ICON.download}</button></span>`;
        $('.ft-copy', row).addEventListener('click', (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(r.name).then(() => toast('已复制文件名', 'ok', 1200), () => toast('复制失败：浏览器拒绝了剪贴板权限', 'err'));
        });
        $('.file-dl', row).addEventListener('click', (e) => { e.stopPropagation(); downloadFile(r.path); });
        row.addEventListener('click', () => openFileViewer(r.path));
      }
      box.appendChild(row);
    }
  }

  function openFileViewer(path) {
    const viewer = $('#file-viewer');
    let raw = '';
    try { raw = agent.fs.read(path); } catch { return toast('文件已不存在', 'err'); }
    const imgSrc = /^data:image\//.test(raw) ? safeImgSrc(raw) : '';
    viewer.innerHTML = `<div class="file-viewer-head mono">${esc(path)}<span class="fv-actions">`
      + `<button id="fv-dl" type="button" title="下载此文件">${ICON.download}<span>下载</span></button>`
      + `<button id="fv-close" type="button" title="关闭">${ICON.x}</button></span></div>`
      + (imgSrc ? `<div class="fv-img"><img src="${esc(imgSrc)}" alt="${esc(path)}"></div>` : `<pre>${esc(raw)}</pre>`);
    viewer.classList.add('open');
    $('#fv-close').addEventListener('click', () => viewer.classList.remove('open'));
    $('#fv-dl').addEventListener('click', () => downloadFile(path));
  }
  renderFiles();

  // ── 消息渲染 ──────────────────────────────────────────────────────────
  function loadLastSuggest() {
    try { return JSON.parse(sessionStorage.getItem('teamo.suggest.last') || '[]'); } catch { return []; }
  }
  function saveLastSuggest(picks) {
    try { sessionStorage.setItem('teamo.suggest.last', JSON.stringify((picks || []).map((x) => x.text))); } catch { /* 无 storage */ }
  }
  function renderEmpty() {
    if (store.state.messages.length) return;
    const exclude = loadLastSuggest();
    let picks = pickSuggestions(SUGGESTIONS, 3, Math.random, exclude);
    const same = picks.map((x) => x.text).join('\0') === exclude.join('\0');
    if (same && SUGGESTIONS.length > 3) picks = pickSuggestions(SUGGESTIONS, 3, Math.random, exclude);
    saveLastSuggest(picks);
    msgList.appendChild(el('div', 'empty-state', `
      <div class="empty-logo">${APP_LOGO}</div>
      <h2>TeamoAgent</h2>
      <p>TeamoAgent · 基于 <span class="mono">TeamoRouter</span> 网关的网页端智能体<br>模型自选 · 代码沙箱 · 对话回滚 · 工具调用循环</p>
      <div class="empty-cards">
        ${picks.map((x) => {
          const shown = x.title || (mqPanel.matches ? shortSuggest(x.text) : x.text);
          return `<button class="suggest" type="button" data-prompt="${esc(x.text)}">${esc(shown)}</button>`;
        }).join('')}
      </div>
      <button class="suggest-shuffle" type="button" title="换一批任务示例">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>换一批</button>`));
    $$('.suggest', msgList).forEach((b) => b.addEventListener('click', () => {
      composer.value = b.dataset.prompt || b.textContent;
      composer.focus(); autoGrow();
    }));
    const shuffle = $('.suggest-shuffle', msgList);
    if (shuffle) shuffle.addEventListener('click', () => { clearEmpty(); renderEmpty(); });
  }
  function clearEmpty() { const e = $('.empty-state', msgList); if (e) e.remove(); }

  function messageNode(m) {
    const wrap = el('div', `msg msg-${m.role} enter`);
    wrap.dataset.id = m.id;
    if (m.transientModeration || (m.moderation && m.moderation.blocked)) wrap.classList.add('msg-moderation');
    if (m.role === 'user') {
      wrap.innerHTML = `<div class="bubble md-body">${renderMarkdown(m.text)}${renderAttachments(m.attachments)}</div>
        <div class="msg-user-bar">
        ${m.jev && m.jev.summary ? `<div class="jev-chip" title="TypeSafe Jev 对本轮的校准分类">Jev · ${esc(m.jev.summary)}</div>` : ''}
        <div class="msg-actions msg-actions-user">
          <button class="act" data-act="copy" title="复制这条消息">${ICON.copy || ''}<span>复制</span></button>
        </div>
        </div>`;
      bindFoldRows($('.md-body', wrap) || wrap);
      $$('.act', wrap).forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.act === 'copy') {
          navigator.clipboard.writeText(m.text || '').then(() => toast('已复制', 'ok', 1200), () => toast('复制失败：浏览器拒绝了剪贴板权限', 'err'));
        }
      }));
    } else {
      // 模型名/头像每轮（一次 user 提问开始的回合）只显示一次：
      // 仅当上一条消息是 user 时渲染 msg-head，工具循环产生的后续 assistant 消息不再重复
      const idx = store.state.messages.findIndex((x) => x.id === m.id);
      const prev = idx > 0 ? store.state.messages[idx - 1] : null;
      const moderationNotice = !!(m.transientModeration || (m.moderation && m.moderation.blocked));
      // 审核拦截消息自带 Moderator 头像与名称：它前面不是 user（用户气泡已被移除），
      // 旧逻辑 showHead 会判 false 导致「无图标无审核员」，这里强制显示
      const showHead = moderationNotice || !prev || prev.role === 'user';
      // 用这条消息生成时实际使用的模型（而不是当前选择），切换会话/换模型后回看不再张冠李戴
      const headModel = m.model || store.state.model;
      const headName = headModel === '__system__' ? 'system-commands' : headModel === 'Moderator' ? 'Moderator · 审核员' : headModel;
      const headIcon = headModel === '__system__' ? `<span class="sys-gear">${ICON.system || '⚙'}</span>` : providerIcon(providerOf(headModel));
      wrap.innerHTML = `
        ${showHead ? `<div class="msg-head"><span class="avatar">${headIcon}</span><span class="msg-model mono">${esc(headName)}</span><span class="msg-meta"></span></div>` : ''}
        <div class="md-body"></div>
        <div class="tool-chips"></div>
        <div class="msg-toolbar"${moderationNotice ? ' hidden' : ''}>
        <div class="msg-actions">
          <button class="act" data-act="copy" title="复制本轮回复">${ICON.copy || ''}<span>复制</span></button>
          <button class="act act-danger" data-act="rollback" title="回滚到本轮之前（将移除该轮及其后的消息）">${ICON.rollback || ''}<span>回滚</span></button>
          <button class="act act-regen" data-act="regen" title="重新生成并覆盖最近这一条回答（更早的回答请先「回滚」再重新提问）">${ICON.regen || ''}<span>重新生成</span></button>
        </div>
        <div class="msg-foot mono" hidden></div>
        </div>`;
      $$('.act', wrap).forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'copy') {
        navigator.clipboard.writeText(m.text || '').then(() => toast('已复制', 'ok', 1200), () => toast('复制失败：浏览器拒绝了剪贴板权限', 'err'));
      }
        if (act === 'rollback') doRollback(m);
        if (act === 'regen') {
          if (getBusy()) return;
          // 「重新生成」= 覆盖这一次的回答：先把旧回答从会话与视图里一起抹掉，再重跑同一轮。
          // 之前只调 agent.regenerate()：store 里旧消息删了，但 DOM 节点还挂在消息区，
          // 新回答又追加在下面 → 看起来像「没重新生成」或「生成了两条」。
          const removed = store.dropLastAssistantTurn();
          if (removed) { rebuildMessages(); toast('已覆盖上一次回答，正在重新生成…', 'ok', 1600); }
          agent.regenerate();
        }
      }));
    }
    return wrap;
  }

  // ── 「重试并联网检索」：上游模型偶发不调用服务端搜索（直接回「我上不了网」）时的补救 ──
  // 真机对照实验里，提问里写明「先联网检索再回答」能明显提高命中率，所以这里一键改写重问；
  // 不放在通用 .act 处理器里 —— 提示条是在动作条之后才挂上去的，那时监听器已经绑定完了。
  function doWebRetry(m) {
    if (getBusy()) return;
    const i = store.state.messages.findIndex((x) => x.id === m.id);
    const um = i > 0 ? store.state.messages[i - 1] : null;
    if (!um || um.role !== 'user') { toast('找不到对应的提问，请手动重新提问', 'err', 2200); return; }
    if (i !== store.state.messages.length - 1) { toast('这条不是最近一轮，请先「回滚」再重问', 'err', 2400); return; }
    if (/先联网(检索|查|搜索)/.test(um.text || '')) { toast('这一轮已经要求过「先联网检索」了 —— 建议换个模型（Claude / GPT 系列）再试', 'err', 2800); return; }
    store.dropLastAssistantTurn();   // 覆盖式重试：别把没检索到的旧回答留在上面
    store.updateMessage(um.id, { text: '先联网检索再回答：' + (um.text || '') });
    rebuildMessages();
    toast('已改写提问（先联网检索再回答），正在重试…', 'ok', 1800);
    agent.regenerate();
  }

  function paintFoot(wrap, m) {
    const foot = $('.msg-foot', wrap);
    if (!foot) return;
    if (m.role !== 'assistant' || !m.done) { foot.hidden = true; foot.textContent = ''; return; }
    if (m.toolCalls && m.toolCalls.length) { foot.hidden = true; foot.textContent = ''; return; }
    const bits = [];
    if (m.reasoningLevel && m.reasoningLevel !== 'off') bits.push(reasoningLevelLabel(m.reasoningLevel));
    const clock = m.durationMs != null ? fmtClock(m.durationMs) : '';
    const ago = m.ts ? fmtAgo(m.ts) : '';
    const time = [clock, ago].filter(Boolean).join(' | ');
    const line = bits.length && time ? `${bits[0]} · ${time}` : (bits[0] || time);
    if (!line) { foot.hidden = true; foot.textContent = ''; return; }
    foot.hidden = false;
    foot.textContent = line;
    foot.title = m.reasoningLevel === 'off' ? '本轮思考 Off' : (m.ts ? new Date(m.ts).toLocaleString() : '');
  }

  function paintAssistant(wrap, m) {
    wrap.classList.toggle('cancelled', !!m.cancelled);
    const body = $('.md-body', wrap);
    let html = '';
    const noOutputYet = !m.text && !m.reasoning && !(m.toolCalls && m.toolCalls.length);
    // 光标/连接动画只属于「正在跑的这一条」。导入的历史回复没有 done 字段，
    // 不能靠 !m.done 一直闪烁 —— 必须叠上本轮忙碌状态。
    const live = !m.done && getBusy();
    // 思考过程：Off 本轮不画。Claude 5 / GPT / Gemini 常只返回签名或 reasoning_tokens、没有正文。
    const thinkOn = m.reasoningLevel !== 'off';
    const showThink = thinkOn && m.reasoning;
    const hiddenThink = thinkOn && !m.reasoning && (m.thoughtHidden || (m.usage && m.usage.reasoning) || (m.thinkingBlocks && m.thinkingBlocks.length));
    if (live && noOutputYet && !thinkOn) {
      // 连接动画：请求已发出但首字未到（网关排队 / TTFB 慢），明确提示当前状态
      html += `<div class="connect-line"><span class="connect-ring" aria-hidden="true"></span><span>正在连接 <b class="mono">${esc(m.model || store.state.model)}</b>，等待首个响应…</span></div>`;
    }
    html += m.model === '__system__' ? sysReplyHtml(m.text) : renderMarkdown(m.text || '');
    if (live && !noOutputYet) html += '<span class="cursor"></span>';
    if (m.cancelled) html += '<span class="cancelled-tag">已停止</span>';
    if (m.done && /^(length|max_tokens|max_output_tokens)$/i.test(String(m.finishReason || ''))) {
      html += '<div class="trunc-note">输出碰到长度上限，未写完。再说「继续」或点重新生成。</div>';
    }
    body.innerHTML = html;
    body.classList.toggle('empty', !String(html || '').trim());
    hydrateSandboxMedia(body, agent.fs);
    bindFoldRows(body);
    const msgs = store.state.messages;
    const idx = msgs.findIndex((x) => x.id === m.id);
    const followedByUser = idx >= 0 && msgs.slice(idx + 1).some((x) => x.role === 'user' && !x.silent);
    for (const box of $$('.choice-box', body)) {
      if (!m.done || followedByUser) box.remove();
    }
    // 思考过程与工具芯片同构：整行 click + .expanded + .chip-detail，不用 <details>
    // 有可见思考正文时边流边展开；思考结束（正文/工具出现或 round done）自动折叠。
    // 流式时只改 fold-inner，禁止整段 innerHTML（会把 0fr→1fr 动画打回 0 高，看起来像没流式）。
    let reason = $('.reasoning', wrap);
    const thinkPending = live && thinkOn && !m.cancelled && !showThink && !hiddenThink;
    if (showThink || hiddenThink || thinkPending) {
      if (!reason) {
        reason = el('div', 'reasoning');
        reason.addEventListener('click', (e) => {
          if (e.target.closest('a, button, .chip-copy')) return;
          reason.classList.toggle('expanded');
          wrap._reasonUser = reason.classList.contains('expanded');
        });
        reason.innerHTML = `<span class="think-ico">${ICON.thinking || ''}</span><span class="mono chip-name"></span><span class="chip-state"></span><div class="chip-detail reason-detail"><div class="fold-inner"></div></div>`;
        wrap.insertBefore(reason, body);
      }
      const bits = [];
      // 注意：不再把「思考中」塞进 bits——title 已经是「思考中」，重复会出现「思考中 · 思考中」（.17）
      if (m.reasoningLevel && m.reasoningLevel !== 'off') bits.push(reasoningLevelLabel(m.reasoningLevel));
      if (hiddenThink && m.usage && m.usage.reasoning) bits.push(`${m.usage.reasoning} tok`);
      if (m.reasoningMs) bits.push(fmtSpan(m.reasoningMs));
      // 思考进行中（本轮还没有正文/工具）只显示「思考中」，完成后才定名为「思考过程」
      const thinkStreaming = live && !m.text && !(m.toolCalls && m.toolCalls.length);
      const title = (showThink || thinkPending) ? (thinkStreaming ? '思考中' : '思考过程') : '已思考';
      const nameEl = $('.chip-name', reason);
      const stateEl = $('.chip-state', reason);
      if (nameEl) nameEl.textContent = title;
      if (stateEl) stateEl.textContent = bits.join(' · ');
      const inner = $('.fold-inner', reason);
      const detail = showThink
        ? (live ? `<pre class="think-stream">${esc(m.reasoning)}</pre>` : renderMarkdown(m.reasoning))
        : (hiddenThink
          ? '<div class="think-hidden">该模型在网关侧做了推理，但不返回可见思考文本。DeepSeek、GLM、Claude Haiku 会显示正文。</div>'
          : '');
      const sig = `${live ? 'live' : 'done'}:${(m.reasoning || '').length}:${hiddenThink ? 1 : 0}`;
      if (inner && inner.dataset.sig !== sig) {
        inner.dataset.sig = sig;
        // 流式思考：只改既有 <pre> 的 textContent（整段 innerHTML 会让长思考逐帧重建，越流越卡）
        const pre = live && showThink ? inner.querySelector('pre.think-stream') : null;
        if (pre) pre.textContent = m.reasoning || '';
        else inner.innerHTML = detail;
        if (!live) {
          hydrateSandboxMedia($('.reason-detail', reason) || reason, agent.fs);
          bindFoldRows($('.reason-detail', reason) || reason);
        }
      }
      const thinkLive = live && (thinkPending || !!m.reasoning) && !m.text && !(m.toolCalls && m.toolCalls.length);
      const autoOpen = thinkLive;
      reason.classList.toggle('live', thinkLive);
      reason.classList.toggle('expanded', wrap._reasonUser == null ? autoOpen : !!wrap._reasonUser);
    } else if (reason) {
      reason.remove();
    }
    if (m.webSearch) body.appendChild(webNote(m.webSearch));
    // 诚实性护栏：正文说「已联网搜索」但本轮没有任何服务端检索事件 → 如实提醒，不替模型背书
    else if (m.done && m.role === 'assistant' && claimsWebSearch(m.text)) {
      const warn = el('div', 'web-note warn');
      warn.innerHTML = '<span class="web-fail">未见检索事件</span>'
        + '<span>本轮没有收到任何网页搜索事件（模型的「已联网」说法无法证实），其中的具体数字请另行核实</span>';
      body.appendChild(warn);
    }
    // 开关开着、模型却回「我上不了网」：上游没去调用服务器搜索（网关侧实测会发生），给一句可操作提示
    else if (m.done && m.role === 'assistant' && store.state.settings.webEnabled !== false && webRefusal(m.text)) {
      const hint = el('div', 'web-note hint');
      hint.innerHTML = '<span class="web-hint">联网开关是开着的，但本轮没有发生检索</span>'
        + '<span>上游模型自己没调用服务端搜索（网关侧偶发）。需要实时数据的话，点右边的按钮用同一句提问重试（会自动写明「先联网检索再回答」），或换个模型重问一次</span>'
        + `<button class="act web-act" data-act="web-retry" title="同一句提问重试，并在提问前面写明「先联网检索再回答」">${ICON.globe || ''}<span>重试并联网检索</span></button>`;
      body.appendChild(hint);
      const wb = $('.web-act', hint);
      if (wb) wb.addEventListener('click', (e) => { e.preventDefault(); doWebRetry(m); });
    }
    if (m.error) body.innerHTML += `<div class="err-box">⚠ ${esc(m.error)}</div>`;
    // 工具芯片
    const chips = $('.tool-chips', wrap);
    if (m.toolCalls && m.toolCalls.length) {
      const groups = [];
      const seen = new Map();
      for (const t of m.toolCalls) {
        if (t.name === 'write_file') continue;
        if (t.name === 'read_file') continue;
        if (!seen.has(t.name)) {
          const g = { name: t.name, items: [] };
          seen.set(t.name, g);
          groups.push(g);
        }
        seen.get(t.name).items.push(t);
      }
      const sig = groups.map((g) => g.items.map((t) => t.id).join('+')).join('|');
      if (chips.dataset.sig !== sig) {
        chips.dataset.sig = sig;
        chips.innerHTML = '';
        for (const g of groups) {
          const chip = el('div', 'chip');
          const ids = g.items.map((t) => t.id);
          chip.dataset.callIds = ids.join(',');
          chip.dataset.callId = ids[0] || '';
          const label = g.items.length > 1 ? `${g.name} ×${g.items.length}` : g.name;
          chip.innerHTML = `<span class="chip-ico">${ICON.tool || ''}</span><span class="mono chip-name">${esc(label)}</span><span class="chip-json"><button type="button" class="chip-copy" data-which="in" title="复制入参 JSON">入参</button><button type="button" class="chip-copy" data-which="out" title="复制出参 JSON">出参</button></span><span class="chip-state">…</span>`;
          chip.addEventListener('click', (e) => {
            if (e.target.closest('.chip-copy')) return;
            chip.classList.toggle('expanded');
            chip._userToggle = chip.classList.contains('expanded');
          });
          const detail = el('div', 'chip-detail mono');
          chip.appendChild(detail);
          chip._detail = detail;
          chip._items = g.items.map((t) => ({ id: t.id, args: t.args, name: t.name }));
          chip._args = g.items.length === 1 ? g.items[0].args : g.items.map((t) => t.args);
          chip._outs = {};
          chips.appendChild(chip);
        }
      }
      const toolOut = (id) => {
        const tm = store.state.messages.find((x) => x.role === 'tool' && x.toolCallId === id);
        return tm ? String(tm.content || '') : '';
      };
      for (const chip of $$('.chip', chips)) {
        const ids = String(chip.dataset.callIds || chip.dataset.callId || '').split(',').filter(Boolean);
        const items = (m.toolCalls || []).filter((t) => ids.includes(t.id));
        if (items.length) {
          chip._items = items.map((t) => ({ id: t.id, args: t.args, name: t.name }));
          chip._args = items.length === 1 ? items[0].args : items.map((t) => t.args);
        }
        if (!chip._outs) chip._outs = {};
        for (const id of ids) {
          const out = toolOut(id);
          if (out) chip._outs[id] = out;
        }
        const outs = ids.map((id) => chip._outs[id]).filter((x) => x != null);
        chip._out = outs.join('\n\n');
        if (!chip._renderedArgs || !m.done) {
          const argHtml = items.length > 1
            ? items.map((t, i) => `<div class="chip-args">#${i + 1} ${esc(JSON.stringify(t.args))}</div>`).join('')
            : `<div class="chip-args">参数 ${esc(JSON.stringify(chip._args))}</div>`;
          const resHtml = outs.length ? `<pre class="chip-result">${esc(chip._out)}</pre>` : '';
          chip._detail.innerHTML = `<div class="fold-inner">${argHtml}${resHtml}</div>`;
          chip._renderedArgs = !!m.done;
        }
        chip.classList.toggle('live', live && !chip.classList.contains('done'));
        if (chip._userToggle == null) chip.classList.toggle('expanded', !chip.classList.contains('done'));
        if (m.cancelled && !chip.classList.contains('ok') && !chip.classList.contains('fail')) {
          chip.classList.add('done');
          chip.classList.remove('running');
          const st = $('.chip-state', chip);
          if (st && !st.querySelector('.chip-ok, .chip-fail')) st.textContent = '已停止';
        }
      }
    }
    // 连续 Edited / Explored File 合并到同一轮最后一条对应工具的助手消息，避免连着两块
    const msgsAll = store.state.messages;
    const idxA = msgsAll.findIndex((x) => x.id === m.id);
    const pathsOf = (msg, name) => [...new Set((msg.toolCalls || []).filter((c) => c.name === name && c.args && c.args.path).map((c) => String(c.args.path)))];
    const mergedPaths = (name) => {
      let later = false;
      if (idxA >= 0) {
        for (let i = idxA + 1; i < msgsAll.length; i++) {
          if (msgsAll[i].role === 'user') break;
          if (msgsAll[i].role === 'assistant' && pathsOf(msgsAll[i], name).length) { later = true; break; }
        }
      }
      const out = [];
      if (!later && idxA >= 0) {
        const seen = new Set();
        for (let i = idxA; i >= 0; i--) {
          const x = msgsAll[i];
          if (x.role === 'user') break;
          if (x.role !== 'assistant') continue;
          const ps = pathsOf(x, name);
          if (!ps.length) break;
          for (let j = ps.length - 1; j >= 0; j--) {
            const p = ps[j];
            if (!seen.has(p)) { seen.add(p); out.unshift(p); }
          }
        }
      } else if (!later) {
        out.push(...pathsOf(m, name));
      }
      return out;
    };
    const paintPathFold = (cls, name, icon, one, many, afterEl) => {
      const paths = mergedPaths(name);
      let node = $(`.${cls}`, wrap);
      if (paths.length) {
        if (!node) {
          node = el('div', cls);
          node.addEventListener('click', (e) => {
            if (e.target.closest('a, button, .chip-copy')) return;
            node.classList.toggle('expanded');
            node._userToggle = node.classList.contains('expanded');
          });
          afterEl.after(node);
        } else if (node.previousElementSibling !== afterEl) {
          afterEl.after(node);
        }
        const label = paths.length === 1 ? one : `${many} ${paths.length}`;
        node.innerHTML = `<span class="chip-ico think-ico">${icon || ''}</span><span class="mono chip-name">${esc(label)}</span><div class="chip-detail"><div class="fold-inner"><ul>${paths.map((x) => `<li class="mono">${esc(x)}</li>`).join('')}</ul></div></div>`;
        // 与思考/工具芯片同构：流式期间展开，回合完成后自动折叠（用户手动展开过则尊重）
        if (node._userToggle == null) node.classList.toggle('expanded', !!live);
        if (idxA >= 0) {
          for (let i = idxA - 1; i >= 0; i--) {
            const x = msgsAll[i];
            if (x.role === 'user') break;
            if (x.role !== 'assistant') continue;
            if (!pathsOf(x, name).length) break;
            const w = msgList.querySelector(`.msg-assistant[data-id="${CSS.escape(x.id)}"]`);
            const old = w && $(`.${cls}`, w);
            if (old) {
              old.remove();
              syncAssistantShell(w);
            }
          }
        }
      } else if (node) node.remove();
      return $(`.${cls}`, wrap) || afterEl;
    };
    const afterRead = paintPathFold('explored-files', 'read_file', ICON.file, 'Explored File', 'Explored Files', chips);
    paintPathFold('edited-files', 'write_file', ICON.edited, 'Edited File', 'Edited Files', afterRead);
    // meta（无 msg-head 的续消息没有该节点；多轮工具调用时汇总整轮 token 与官方预估价格到本轮首条 msg-head）
    paintTurnMeta(wrap, m);
    paintFoot(wrap, m);
    syncAssistantShell(wrap);
    // 复制/回滚/重新生成的显隐统一交给 refreshActionVisibility（回合结束才显示）
    refreshActionVisibility();
  }

  function syncAssistantShell(w) {
    if (!w || !w.classList.contains('msg-assistant')) return;
    const hasHead = !!$('.msg-head', w);
    const bodyEl = $('.md-body', w);
    const hasBody = !!(bodyEl && !bodyEl.classList.contains('empty') && String(bodyEl.innerHTML || '').trim());
    const hasReason = !!$('.reasoning', w);
    const chipsEl = $('.tool-chips', w);
    const hasChips = !!(chipsEl && chipsEl.children.length > 0);
    const hasExplored = !!$('.explored-files', w);
    const hasEdited = !!$('.edited-files', w);
    const footEl = $('.msg-foot', w);
    const hasFoot = !!(footEl && !footEl.hidden && String(footEl.textContent || '').trim());
    const emptyShell = !hasHead && !hasBody && !hasReason && !hasChips && !hasExplored && !hasEdited && !hasFoot;
    w.classList.toggle('msg-collapsed', emptyShell);
  }

  function collectTurnCostInfo(m) {
    const msgs = store.state.messages || [];
    const idx = msgs.findIndex((x) => x.id === m.id);
    if (idx < 0) {
      const c = summarizeTurnCost({ messages: [m], model: m.model || store.state.model, fastMode: !!(m.fastMode ?? store.state.settings.fastMode) });
      return { headMsg: m, turnDone: !!m.done, hasUsage: !!m.usage, summary: c };
    }
    let start = idx;
    while (start > 0 && msgs[start - 1].role !== 'user') start--;
    const turnAssistants = [];
    for (let i = start; i < msgs.length; i++) {
      if (i > start && msgs[i].role === 'user') break;
      if (msgs[i].role === 'assistant') turnAssistants.push(msgs[i]);
    }
    const headMsg = turnAssistants[0] || m;
    const lastA = turnAssistants[turnAssistants.length - 1] || m;
    const turnDone = turnAssistants.length > 0
      && turnAssistants.every((x) => !!x.done)
      && (!getBusy() || !(lastA.toolCalls && lastA.toolCalls.length));
    const hasExplicitUsage = turnAssistants.some((x) => x.usage && (x.usage.input != null || x.usage.output != null));
    const toolCosts = [];
    for (const a of turnAssistants) {
      for (const tc of a.toolCalls || []) {
        if (!tc) continue;
        if (tc.billing) {
          toolCosts.push(tc.billing);
        } else if (tc.name === 'generate_image') {
          const args = tc.args || {};
          toolCosts.push({
            kind: 'image',
            model: args.model || store.state.imageModel || DEFAULT_IMAGE_MODEL,
            size: (tc.width && tc.height) ? `${tc.width}x${tc.height}` : (args.size || '1024x1024'),
            quality: args.quality || 'auto',
            count: Number(args.n) || 1,
          });
        } else if (tc.name === 'analyze_image') {
          const tm = msgs.find((x) => x.role === 'tool' && x.toolCallId === tc.id);
          const outChars = tm && tm.content ? String(tm.content).length : 600;
          toolCosts.push({
            kind: 'vision',
            model: 'deepseek-v4-flash-vision-exp',
            usage: { input: 1600, output: Math.max(120, Math.ceil(outChars / 2)) },
            imageCount: 1,
          });
        }
      }
    }
    const normalizedAssistants = turnAssistants.map((a) => {
      if (a.usage && (a.usage.input != null || a.usage.output != null)) return a;
      if (!a.done || a.model === 'Moderator' || a.model === '__system__') return a;
      if (!a.text && !a.reasoning && !(a.toolCalls && a.toolCalls.length)) return a;
      const prevMsgs = msgs.slice(0, msgs.indexOf(a));
      const estIn = Math.max(64, estimateTokens(prevMsgs));
      const estOut = Math.max(1, estimateTokens([{ role: 'assistant', text: (a.text || '') + (a.reasoning || '') }]));
      return { ...a, usage: { input: estIn, output: estOut }, _estimatedUsage: true };
    });
    const hasAnyUsage = hasExplicitUsage || normalizedAssistants.some((a) => !!a.usage) || toolCosts.length > 0;
    const summary = summarizeTurnCost({
      messages: normalizedAssistants,
      model: headMsg.model || store.state.model,
      fastMode: !!(headMsg.fastMode ?? store.state.settings.fastMode),
      toolCosts,
      jevUsage: headMsg.jevUsage,
    });
    return { headMsg, turnDone: turnDone || (!!m.done && !getBusy()), hasUsage: hasAnyUsage, summary };
  }

  function paintTurnMeta(wrap, m) {
    const info = collectTurnCostInfo(m);
    const targetWrap = (info.headMsg && msgNodes.get(info.headMsg.id)) || wrap;
    const meta = $('.msg-meta', targetWrap);
    if (!meta) return;
    const headModel = (info.headMsg && info.headMsg.model) || m.model || '';
    if (headModel === 'Moderator' || headModel === '__system__') {
      meta.innerHTML = '';
      return;
    }
    const parts = [];
    if (info.hasUsage) {
      const s = info.summary;
      const costReady = info.turnDone;
      const costHtml = costReady ? ` · <span class="tok-cost" title="按模型官方列表价预估（含识图/生图/子智能体）">${esc(s.formatted)}</span>` : '';
      const tipParts = [`本轮 API 用量：输入 ${s.inputTokens} tok / 输出 ${s.outputTokens} tok${s.reasoningTokens ? `（含推理 ${s.reasoningTokens} tok）` : ''}`];
      if (costReady) {
        tipParts.push(`官方定价预估：${s.formatted}`);
        if (s.visionUsd > 0) tipParts.push(`含识图模型：${formatUsd(s.visionUsd)}`);
        if (s.imageUsd > 0) tipParts.push(`含生图模型：${formatUsd(s.imageUsd)}`);
        if (s.subagentUsd > 0) tipParts.push(`含子智能体：${formatUsd(s.subagentUsd)}`);
      }
      parts.push(`<button type="button" class="tok-btn" title="${esc(tipParts.join(' · '))}">↑${s.inputTokens} ↓${s.outputTokens} tok${costHtml}</button>`);
    }
    const tr = (info.headMsg && info.headMsg.transport) || m.transport;
    if (tr) parts.push(tr === 'proxy' ? '中继' : '直连');
    meta.innerHTML = parts.join(' · ');
    const tb = $('.tok-btn', meta);
    if (tb) tb.addEventListener('click', (e) => { e.stopPropagation(); showTokBreak(tb, info); });
  }

  // 操作条显隐规则：
  //   ① 复制 / 重新生成 只出现在「本轮末尾」的 assistant 消息上（每轮一次）
  //   ② 整轮输出没结束（流式、工具执行、子智能体跑着）时，本轮所有按钮一律不显示
  //      —— 用户要的是「输出完了再动手」，半截输出上点复制/回滚都不是想要的结果
  // 联网来源条：搜索由模型服务端完成，这里只把「查了什么、来自哪儿」亮出来（含引用链接）
  function webNote(w) {
    const box = el('div', 'web-note');
    const sources = (w.sources || []).filter((x) => x && x.url).slice(0, 6);
    if (w.status === 'searching') box.innerHTML = '<span class="web-dot"></span><span>联网检索中（模型原生 web_search）…</span>';
    else if (w.status === 'error') {
      // 上游检索服务不可用（如 Anthropic 的 error_code:"unavailable"）：如实说清，不显示「0 条来源」
      box.innerHTML = `<span class="web-fail">联网检索未成功</span><span class="mono">${esc(String(w.message || '上游未返回结果').slice(0, 90))}</span>`
        + (sources.length ? '' : '<span class="web-hint">可稍后重试，或换用其它支持原生联网的模型</span>');
    }
    else {
      // 各家原生格式给的计数字段不一致（有的只给 sources），取两者较大值，别显示「0 条来源」
      const n = Math.max(Number(w.results) || 0, sources.length);
      const q = (w.queries || []).slice(0, 2).map((x) => `「${String(x).slice(0, 40)}」`).join(' ');
      box.innerHTML = `<span class="web-tag">联网</span><span>${q ? esc(q) + ' · ' : ''}服务端检索到 ${n} 条来源</span>`;
      if (sources.length) {
        const ul = el('div', 'web-srcs');
        for (const x of sources) {
          const a = el('a', 'web-src'); a.href = x.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.textContent = String(x.title || x.url).slice(0, 90);
          ul.appendChild(a);
        }
        box.appendChild(ul);
      }
    }
    return box;
  }

  function refreshActionVisibility() {
    const msgs = store.state.messages;
    const busy = getBusy();
    const turnStartOf = (i) => {
      while (i > 0 && msgs[i].role !== 'user') i--;
      return msgs[i] && msgs[i].role === 'user' ? i : -1;
    };
    const readyByStart = new Map();
    const turnReady = (start) => {
      if (start < 0) return false;
      if (readyByStart.has(start)) return readyByStart.get(start);
      let anyAssistant = false, allDone = true;
      for (let k = start + 1; k < msgs.length && msgs[k].role !== 'user'; k++) {
        if (msgs[k].role === 'assistant') { anyAssistant = true; if (!msgs[k].done) allDone = false; }
      }
      const v = !busy && anyAssistant && allDone;
      readyByStart.set(start, v);
      return v;
    };
    // 每轮末尾的 assistant（按轮起点记住）+ 整个会话最后一条 assistant（「重新生成」才给）
    const lastAssistantOfTurn = new Map();
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== 'assistant') continue;
      const st = turnStartOf(i);
      if (st >= 0) lastAssistantOfTurn.set(st, msgs[i].id);
    }
    const lastOverall = [...msgs].reverse().find((x) => x.role === 'assistant');
    for (const wrap of $$('.msg-user, .msg-assistant', msgList)) {
      const idx = msgs.findIndex((x) => x.id === wrap.dataset.id);
      if (idx < 0) continue;
      const m = msgs[idx];
      const start = m.role === 'user' ? idx : turnStartOf(idx);
      const ready = turnReady(start);
      const show = m.role === 'user' ? ready : ready && lastAssistantOfTurn.get(start) === m.id;
      wrap.classList.toggle('actions-pending', !show);
      const regen = $('.act-regen', wrap);
      if (regen) regen.style.display = show && lastOverall && lastOverall.id === m.id ? '' : 'none';
      if (m.role === 'assistant') syncAssistantShell(wrap);
    }
  }
  function appendMessage(m) {
    clearEmpty();
    const wrap = messageNode(m);
    msgNodes.set(m.id, wrap);
    if (m.role === 'assistant') paintAssistant(wrap, m);
    msgList.appendChild(wrap);
    if (m.role === 'assistant') refreshActionVisibility();
    scrollToBottom();
  }

  function rebuildMessages() {
    cancelRollbackAnim();
    msgNodes.clear(); msgList.innerHTML = '';
    renderEmpty();
    // 入场动画只给最后一条：旧写法每追加一条就重扫整个列表（n 条消息 → n 次全量
    // querySelectorAll，长会话首屏明显卡顿），而且语义也只是「别给历史消息加动画」
    for (const m of store.state.messages) {
      if (m.role === 'tool' || m.silent) continue;
      appendMessage(m);
    }
    for (const n of $$('.msg', msgList)) n.classList.remove('enter');
    // 把 tool 结果回填到芯片
    for (const m of store.state.messages) if (m.role === 'tool') attachToolResult(m);
    refreshActionVisibility();
    scrollToBottom(true);
  }

  function attachToolResult(toolMsg) {
    const id = toolMsg.toolCallId;
    const chip = $$('.chip', msgList).find((c) => String(c.dataset.callIds || c.dataset.callId || '').split(',').includes(id));
    if (!chip) return;
    const body = String(toolMsg.content || '');
    const okOne = !body.startsWith('工具执行失败')
      && !body.startsWith('图像模型调用失败')
      && !body.startsWith('图像调用在发起前失败')
      && !/── 错误 ──|不是合法 JSON|未配置 TeamoRouter API Key/.test(body);
    if (!chip._outs) chip._outs = {};
    chip._outs[id] = body;
    const ids = String(chip.dataset.callIds || chip.dataset.callId || '').split(',').filter(Boolean);
    const outs = ids.map((x) => chip._outs[x]).filter((x) => x != null);
    const allIn = outs.length >= ids.length && ids.length > 0;
    const ok = outs.every((b) => b && !b.startsWith('工具执行失败')
      && !b.startsWith('图像模型调用失败')
      && !b.startsWith('图像调用在发起前失败')
      && !/── 错误 ──|不是合法 JSON|未配置 TeamoRouter API Key/.test(b));
    const dm = /执行耗时 (\d+)ms/.exec(body);
    const dur = dm ? fmtSpan(Number(dm[1])) : '';
    const errTxt = body.slice(0, 400);
    const st = $('.chip-state', chip);
    if (st) {
      if (!allIn) st.textContent = `${outs.length}/${ids.length}`;
      else {
        st.innerHTML = ok
          ? `<span class="chip-ok">✓</span>${dur ? ` <span class="chip-time">${dur}</span>` : ''}`
          : `<span class="chip-fail" title="${esc(errTxt)}">✗</span>${dur ? ` <span class="chip-time">${dur}</span>` : ''}`;
        st.classList.toggle('bad', !ok);
        st.title = ok ? '' : errTxt;
      }
    }
    if (allIn) {
      chip.classList.add('done');
      chip.classList.toggle('ok', ok);
      chip.classList.toggle('fail', !ok);
      chip.classList.remove('running');
      if (chip._userToggle == null) chip.classList.remove('expanded');
    }
    chip._out = outs.join('\n\n');
    const items = chip._items || [];
    const argHtml = items.length > 1
      ? items.map((t, i) => `<div class="chip-args">#${i + 1} ${esc(JSON.stringify(t.args))}</div>`).join('')
      : `<div class="chip-args">参数 ${esc(JSON.stringify(chip._args))}</div>`;
    chip._detail.innerHTML = `<div class="fold-inner">${argHtml}<pre class="chip-result">${esc(chip._out)}</pre></div>`;
    chip._renderedArgs = true;
  }

  function scrollToBottom(force) {
    const near = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight < 160;
    if (near || force) msgList.scrollTo({ top: msgList.scrollHeight, behavior: 'smooth' });
  }

  // ── 定位到最新输出（向上滚动超过阈值时浮现）─────────────────────────
  const jumpBtn = $('#jump-bottom');
  msgList.addEventListener('scroll', () => {
    const dist = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight;
    jumpBtn.classList.toggle('show', dist > 240);
  }, { passive: true });
  jumpBtn.addEventListener('click', () => {
    jumpBtn.classList.remove('show');
    scrollToBottom(true);
  });

  // ── 状态栏（连接/生成过程可见化：脉冲状态点 + 跳动点 + 实时耗时）──────
  const STATUS = {
    idle: ['', 'ok'],
    moderating: ['连接模型中', 'busy'],  // 对用户只显示「连接模型中」，不暴露审核过程（避免心理负担）；fail-closed 拦截时气泡会说明
    connecting: ['连接模型中', 'busy'],
    thinking: ['思考中', 'busy'], streaming: ['生成中', 'busy'],
    executing: ['沙箱执行中', 'busy'], done: ['完成', 'ok'], error: ['出错', 'err'], cancelled: ['已停止', 'warn'],
  };
  const DOTS = '<span class="sdots" aria-hidden="true"><i></i><i></i><i></i></span>';
  let busySince = 0;
  let busyTimer = null;
  const stopBusyTicker = () => { if (busyTimer) { clearInterval(busyTimer); busyTimer = null; } };
  function paintStatus(s) {
    const [label] = STATUS[s] || STATUS.idle;
    statusText.innerHTML = `${esc(label)}${DOTS}<span class="selapsed mono"></span>`;
    paintElapsed();
  }
  // 只刷新耗时文本，绝不重建 DOTS 节点——之前 ticker 每 200ms 重写整个 innerHTML，
  // CSS 弹跳动效每帧被重置，三个点看起来一卡一卡（.17 修复）
  function paintElapsed() {
    if (!busySince) return;
    const el = statusText.querySelector('.selapsed');
    if (!el) return;
    const secs = (performance.now() - busySince) / 1000;
    el.textContent = secs >= 0.8 ? `${secs.toFixed(1)}s` : '';
  }
  function setStatus(s) {
    const [label, cls] = STATUS[s] || STATUS.idle;
    const busy = ['moderating', 'connecting', 'thinking', 'streaming', 'executing'].includes(s);
    if (busy) {
      if (!busySince) busySince = performance.now();
      statusDot.className = `dot busy ${s}`;
      if (!busyTimer) busyTimer = setInterval(paintElapsed, 100);
      paintStatus(s);
    } else {
      busySince = 0; stopBusyTicker();
      statusDot.className = 'dot ' + cls;
      // 完成态短暂回显后清空，避免状态栏留白显得突兀
      if (s === 'done') {
        statusText.textContent = label;
        setTimeout(() => { if (agent.getStatus() === 'done') statusText.textContent = ''; }, 1600);
        const lastA = [...(store.state.messages || [])].reverse().find((x) => x && x.role === 'assistant');
        if (lastA) {
          const w = msgNodes.get(lastA.id);
          if (w && typeof paintTurnMeta === 'function') paintTurnMeta(w, lastA);
        }
      } else {
        statusText.textContent = label;
      }
    }
    if (typeof refreshActionVisibility === 'function') refreshActionVisibility();
    sendBtn.classList.toggle('stop-mode', busy);
    $('#send-ico').textContent = busy ? '■' : '↑';
    sendBtn.title = busy ? '停止' : '发送 (Enter)';
    // 顶栏不确定进度条：连接阶段更快，让用户一眼看出「正在等模型响应」
    const bar = $('#turn-bar');
    if (bar) bar.classList.toggle('on', busy);
    if (bar) bar.classList.toggle('connecting', s === 'connecting' || s === 'moderating');
  }
  function getBusy() { return ['moderating', 'connecting', 'thinking', 'streaming', 'executing'].includes(agent.getStatus()); }

  function updateTransportBadge() {
    const b = $('#transport-badge');
    const proxy = getTransport() === 'proxy';
    const host = gatewayBase().replace(/^https?:\/\//, '');
    // 徽章要一眼看出「现在走哪个域名」：国内用户最关心的就是这一格（完整域名在悬停提示里）
    const short = (host.match(/teamorouter\.(com|cn)/) || [])[1] ? '.' + host.match(/teamorouter\.(com|cn)/)[1] : host;
    b.textContent = `${proxy ? '中继' : '直连'} · ${short}`;
    const by = gatewayChosenBy();
    const why = by === 'probe' ? '启动探测自动选择' : by === 'failover' ? '直连失败后自动切换' : by === 'manual' ? '手动选择' : by === 'stored' ? '沿用上次选择' : '默认';
    b.title = proxy
      ? `浏览器直连失败，已通过本地服务器代理转发（目标 ${host}）`
      : `浏览器直连 ${host}（${why}）· 点这里可切换到另一个域名（国内网络建议用 api.teamorouter.cn）`;
    syncCapLine();
  }
  // 点传输徽章 = 手动切换接入点（国内网络下用户可能知道哪个更快）
  $('#transport-badge').addEventListener('click', () => {
    const from = gatewayBase();
    const to = setGatewayBase(null, 'manual');
    updateTransportBadge();
    toast(`网关接入点已切换：${to.replace(/^https?:\/\//, '')}（原 ${from.replace(/^https?:\/\//, '')}）`, 'ok', 3200);
  });
  // 请求期发生自动切换（直连失败→换域名）时提示一次
  window.addEventListener('teamo:endpoint-switched', (e) => {
    updateTransportBadge();
    const to = e && e.detail && e.detail.to ? e.detail.to.replace(/^https?:\/\//, '') : '';
    toast(`直连域名不可达，已自动切换到 ${to}`, 'warn', 5000);
  });

  // ── 输出用时（本轮 / 会话累计，随会话持久化）────────────────────────
  const fmtDur = (ms) => {
    if (!(ms > 0)) return '—';
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  };
  function renderTimeStats() {
    const st = store.state.stats || {};
    $('#time-stats').textContent = st.totalMs ? `本轮 ${fmtDur(st.lastMs)} · 累计 ${fmtDur(st.totalMs)}` : '';
  }

  // ── 会话统计 & 导出 ───────────────────────────────────────────────────
  function hideTokPop() {
    const pop = $('#tok-pop');
    if (pop) pop.hidden = true;
  }
  function placeTokPop(anchor) {
    const pop = $('#tok-pop');
    if (!pop || pop.hidden) return;
    const r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : ($('#conv-stats') || {}).getBoundingClientRect?.();
    if (!r) return;
    const pw = pop.offsetWidth || 240;
    const ph = pop.offsetHeight || 160;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    let top = r.top - ph - 10;
    if (top < 8) top = Math.min(window.innerHeight - ph - 8, r.bottom + 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  function showTokBreak(anchor, turnInfo = null) {
    const pop = $('#tok-pop');
    const body = $('#tok-pop-body');
    const stats = $('#conv-stats');
    if (!pop) return;
    if (!pop.hidden) { hideTokPop(); return; }
    const sysTok = estimateTokens([{ role: 'system', text: systemPrompt(new Date(), { webEnabled: false }) }]);
    const b = tokenBreakdown(store.state.messages, estimateTokens, sysTok);
    const n = (x) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(x || 0));
    const rows = [
      ['系统', b.system], ['历史', b.history], ['工具结果', b.tools], ['本轮', b.current], ['合计', b.total],
    ];
    let html = rows.map(([k, v], i) => `<div class="tok-row${i === rows.length - 1 ? ' total' : ''}"><span>${k}</span><span>${n(v)}</span></div>`).join('');
    if (turnInfo && turnInfo.summary) {
      const s = turnInfo.summary;
      const headModel = (turnInfo.headMsg && turnInfo.headMsg.model) || store.state.model;
      const rateBadge = priceBadgeFor(headModel, { fastMode: !!(turnInfo.headMsg && turnInfo.headMsg.fastMode) });
      html += `<div class="tok-row total"><span>对话模型 (${esc(rateBadge || headModel)})</span><span>${esc(formatUsd(s.chatUsd))}</span></div>`;
      if (s.visionUsd > 0) html += `<div class="tok-row"><span>识图模型</span><span>${esc(formatUsd(s.visionUsd))}</span></div>`;
      if (s.imageUsd > 0) html += `<div class="tok-row"><span>生图模型</span><span>${esc(formatUsd(s.imageUsd))}</span></div>`;
      if (s.subagentUsd > 0) html += `<div class="tok-row"><span>子智能体</span><span>${esc(formatUsd(s.subagentUsd))}</span></div>`;
      html += `<div class="tok-row total"><span>本轮预估总价</span><span>${esc(s.formatted)}</span></div>`;
    }
    if (body) body.innerHTML = html;
    const line = formatTokBreak(b);
    if (stats) stats.title = line + '（再点一次收起）';
    pop.hidden = false;
    placeTokPop(anchor && anchor.nodeType ? anchor : stats);
  }
  function updateStats() {
    const msgs = store.state.messages;
    const n = msgs.filter((m) => m.role !== 'tool').length;
    const stats = $('#conv-stats');
    if (!n) { if (stats) stats.textContent = ''; hideTokPop(); return; }
    const tk = estimateTokens(msgs);
    const budget = contextBudgetLabel(store.state.model);
    stats.textContent = `${n} 条 · ~${tk >= 1000 ? (tk / 1000).toFixed(1) + 'k' : tk} tok / ${budget}`;
    stats.title = '点击查看 token 构成（系统 / 历史 / 工具结果 / 本轮）';
    const pop = $('#tok-pop');
    if (pop && !pop.hidden) {
      pop.hidden = true;
      showTokBreak(stats);
    }
  }
  $('#export-btn').addEventListener('click', () => {
    if (!store.state.messages.length) return toast('暂无可导出的对话');
    const active = store.state.sessions.find((s) => s.id === store.state.activeSessionId) || {};
    const data = {
      app: 'TeamoAgent', exportedAt: new Date().toISOString(), model: store.state.model,
      imageModel: store.state.imageModel, title: active.title || '',
      checkpoints: store.state.checkpoints,
      messages: store.state.messages.map((m) => ({
        role: m.role, text: m.text, content: m.content, toolCalls: m.toolCalls,
        toolCallId: m.toolCallId, name: m.name, usage: m.usage, ts: m.ts, model: m.model,
        done: m.done !== false, cancelled: !!m.cancelled,
        reasoning: m.reasoning, reasoningMs: m.reasoningMs, reasoningLevel: m.reasoningLevel,
        durationMs: m.durationMs, thinkingBlocks: m.thinkingBlocks, thoughtHidden: m.thoughtHidden,
        attachments: (m.attachments || []).map((a) => ({ kind: a.kind, name: a.name, size: a.size, stripped: !!a.stripped })),
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `teamo-agent-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('已导出会话 JSON', 'ok');
  });

  // ── 导入会话（兼容本应用导出的 JSON）────────────────────────────────
  $('#import-btn').addEventListener('click', () => $('#import-input').click());
  $('#import-input').addEventListener('change', async () => {
    const input = $('#import-input');
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      // 忙判定必须在改 store 之前：旧写法先 importSession 再判忙，
      // 回合进行中导入会把正在跑的对话数组换掉（半轮丢失 + 状态栏错乱）
      if (getBusy()) return toast('请等待当前回合结束再导入', 'warn');
      const data = JSON.parse(await file.text());
      const s = store.importSession(data);
      if (!s) return toast('导入失败：文件里没有有效的 messages 数组', 'err');
      agent.loadFiles(store.state.files);
      rebuildMessages(); renderSessions(); renderFiles(); updateStats(); renderTimeStats();
      toast(`已导入会话「${s.title}」（${s.messages.length} 条消息）`, 'ok');
    } catch (err) {
      toast('导入失败：' + err.message, 'err');
    }
  });

  // ── 附件（按钮 / 拖拽 / 粘贴）────────────────────────────────────────
  const IMG_RE = /^image\/(png|jpeg|jpg|gif|webp)$/;
  const TEXT_RE = /\.(txt|md|markdown|js|mjs|cjs|ts|py|json|jsonl|csv|tsv|log|html?|css|scss|xml|ya?ml|sh|bash|zsh|sql|ini|toml|env|conf|cfg|c|h|cpp|hpp|java|go|rs|rb|php|swift|kt|vue|svelte)$/i;
  const PDF_RE = /\.pdf$/i;
  const ZIP_RE = /\.zip$/i;
  const MAX_IMG = 5 * 1024 * 1024, MAX_TEXT = 512 * 1024, MAX_PDF = 12 * 1024 * 1024, MAX_ZIP = 12 * 1024 * 1024, MAX_FILES = 8;
  let pending = [];
  const attachChips = $('#attach-chips');
  const fileInput = $('#attach-input');

  const readAs = (mode, file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    mode === 'text' ? r.readAsText(file) : r.readAsDataURL(file);
  });

  async function addFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    for (const f of files) {
      if (pending.length >= MAX_FILES) { toast(`单次最多 ${MAX_FILES} 个附件`, 'warn'); break; }
      try {
        if (IMG_RE.test(f.type)) {
          if (f.size > MAX_IMG) { toast(`${f.name}：图片超过 5MB`, 'err'); continue; }
          if (globalThis.__teamoPrewarmImageModeration) globalThis.__teamoPrewarmImageModeration('attachment');
          pending.push({ id: Math.random().toString(36).slice(2), kind: 'image', name: f.name, mime: f.type, size: f.size, dataUrl: await readAs('dataURL', f) });
        } else if (PDF_RE.test(f.name) || f.type === 'application/pdf') {
          if (f.size > MAX_PDF) { toast(`${f.name}：PDF 超过 12MB`, 'err'); continue; }
          toast(`${f.name}：正在把每一页转成图片…`, 'ok', 2400);
          const buf = await f.arrayBuffer();
          const got = await pdfToImages(buf, { name: f.name });
          if (!got.ok || !got.images.length) {
            toast(`${f.name}：${got.error || '无法渲染 PDF'}`, 'err', 6000);
            continue;
          }
          if (got.images.length && globalThis.__teamoPrewarmImageModeration) globalThis.__teamoPrewarmImageModeration('pdf');
          for (const img of got.images) {
            pending.push({
              id: Math.random().toString(36).slice(2),
              kind: 'image',
              name: img.name,
              mime: 'image/jpeg',
              size: Math.round((img.dataUrl.length * 3) / 4),
              dataUrl: img.dataUrl,
              source: 'pdf',
              originalName: `${f.name} · 第 ${img.page} 页`,
            });
          }
          const more = got.truncated ? `（共 ${got.pages} 页，已渲染前 ${got.images.length} 页）` : `（${got.images.length} 页）`;
          toast(`${f.name}：已转成图片${more}，发送并通过审核后写入 uploads/，请让 Agent 用 analyze_image 识别`, 'ok', 5200);
        } else if (ZIP_RE.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') {
          if (f.size > MAX_ZIP) { toast(`${f.name}：ZIP 超过 12MB`, 'err'); continue; }
          pending.push({
            id: Math.random().toString(36).slice(2),
            kind: 'file',
            name: f.name,
            mime: f.type || 'application/zip',
            size: f.size,
            dataUrl: await readAs('dataURL', f),
            source: 'zip',
            originalName: f.name,
          });
          toast(`${f.name}：已添加 ZIP，发送并通过审核后写入 uploads/，请用 unzip_file 解压`, 'ok', 4200);
        } else if (TEXT_RE.test(f.name) || f.type.startsWith('text/') || f.type === 'application/json') {
          if (f.size > MAX_TEXT) { toast(`${f.name}：文本超过 512KB`, 'err'); continue; }
          pending.push({ id: Math.random().toString(36).slice(2), kind: 'text', name: f.name, mime: f.type || 'text/plain', size: f.size, text: await readAs('text', f) });
        } else {
          toast(`不支持的文件类型：${f.name}（支持图片、PDF、ZIP 与文本/代码文件）`, 'err');
        }
      } catch (err) { toast(err.message, 'err'); }
    }
    renderAttachChips();
  }

  function renderAttachChips() {
    attachChips.innerHTML = '';
    attachChips.style.display = pending.length ? '' : 'none';
    for (const a of pending) {
      const chip = el('div', 'attach-chip enter');
      const imgSrc = a.kind === 'image' ? safeImgSrc(a.dataUrl) : '';
      chip.innerHTML = (imgSrc
        ? `<img src="${esc(imgSrc)}" alt="">`
        : `<span class="attach-chip-ico">📄</span>`)
        + `<span class="attach-chip-name mono">${esc(a.originalName || a.name)}</span><span class="attach-chip-size">${fmtSize(a.size)}</span><button class="attach-chip-x" type="button" aria-label="移除附件">${ICON.x}</button>`;
      $('.attach-chip-x', chip).addEventListener('click', () => {
        pending = pending.filter((x) => x.id !== a.id);
        renderAttachChips();
      });
      attachChips.appendChild(chip);
    }
  }

  $('#attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  const mainEl = $('.main');
  ['dragenter', 'dragover'].forEach((ev) => mainEl.addEventListener(ev, (e) => { e.preventDefault(); mainEl.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach((ev) => mainEl.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget && mainEl.contains(e.relatedTarget)) return;
    mainEl.classList.remove('drag-over');
  }));
  mainEl.addEventListener('drop', (e) => addFiles(e.dataTransfer && e.dataTransfer.files));
  composer.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  // ── 输入区 ────────────────────────────────────────────────────────────
  function autoGrow() {
    composer.style.height = 'auto';
    composer.style.height = Math.min(composer.scrollHeight, 200) + 'px';
  }
  composer.addEventListener('input', autoGrow);
  composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
  });
  sendBtn.addEventListener('click', () => {
    if (getBusy()) { agent.abort(); return; }
    doSend();
  });
  function doSend() {
    const text = composer.value.trim();
    if (!text && !pending.length) return;
    if (store.state.model === '__system__') {
      if (getBusy()) return;
      composer.value = ''; autoGrow();
      handleSystemCommand(text);
      return;
    }
    if (!store.state.apiKey) { openKeyModal(); toast('请先配置 TeamoRouter API Key', 'warn'); return; }
    if (getBusy()) return;
    composer.value = ''; autoGrow();
    const atts = pending; pending = []; renderAttachChips();
    agent.send(text, atts);
  }

  // ── /system 隐藏通道：命令识别器（本地执行，不走网关）──
  async function handleSystemCommand(input) {
    const raw = String(input || '').trim();
    store.pushMessage({ role: 'user', text: raw, done: true });
    const cmd = raw.replace(/^[/／]+/, '').trim();
    const sp = cmd.indexOf(' ');
    const name = (sp < 0 ? cmd : cmd.slice(0, sp)).toLowerCase();
    const arg = sp < 0 ? '' : cmd.slice(sp + 1).trim();
    let out = '';
    if (name === 'help' || !name) {
      out = [
        '⌙ /system 可用命令：',
        '/debug on | off —— 开/关调试浮窗（系统日志：网络/错误/审核全链路）',
        '/status —— 版本 / 模型 / 预热 / 审核状态',
        '/version —— 仅版本一行',
        '/stats —— 会话与耗时统计',
        '/model <模型ID> —— 切换模型（需完整 ID）',
        '/models —— 列出可用模型',
        '/theme dark|light —— 切换深/浅主题',
        '/cache [clear] —— 查看离线缓存 / 清空后自动重建',
        '/key —— 查看 API Key 尾号（完整 Key 不回显）',
        '/export —— 导出全部会话记录（JSON 下载）',
        '/clear —— 清空通道草稿（真实会话不受影响）',
        '提示：模型菜单搜索 /system 可回到本识别器',
      ].join('\n');
    } else if (name === 'debug') {
      const on = /^(on|1|开|开启|open|show)$/i.test(arg);
      const off = /^(off|0|关|关闭|close|hide)$/i.test(arg);
      if (!on && !off) out = '用法：/debug on 或 /debug off';
      else if (typeof globalThis.__teamoDebugSet !== 'function') out = '调试浮窗模块未加载（旧版本缓存），请强刷页面后重试';
      else {
        const now = globalThis.__teamoDebugSet(on);
        out = now ? '✓ 调试浮窗已开启：审核全链路 / console.warn·error / Agent 状态将实时上屏（Ctrl+Alt+D 可关）'
                  : '✓ 调试浮窗已关闭';
      }
    } else if (name === 'status') {
      const log = globalThis.__teamoModLog || [];
      const pw = [...log].reverse().find((e) => e.stage === 'prewarm:done');
      out = [
        `版本：${APP_RELEASE} · 构建 ${APP_VERSION}`,
        `当前模型：${store.state.model === '__system__' ? '（未选择，处于 /system 通道）' : store.state.model}`,
        `可用模型：${chatModels().length} 个`,
        `调试浮窗：${globalThis.__teamoDebugActive && globalThis.__teamoDebugActive() ? '开启' : '关闭'}`,
        `审核模型预热：${pw ? `已完成（NudeNet ${pw.nudenet ? '✓' : '✗'} / NSFWJS ${pw.nsfwjs ? '✓' : '✗'}${pw.toxicity != null ? ` / Toxicity ${pw.toxicity ? '✓' : '✗'}` : ''}）` : '尚未执行（发图或打开页面 2 秒后自动开始）'}`,
        `内容审核：${store.state.settings.contentModeration === true ? '开启（图片 fail-closed）' : '关闭'}`,
      ].join('\n');
    } else if (name === 'version') {
      out = `Teamo ${APP_RELEASE} · 构建 ${APP_VERSION}`;
    } else if (name === 'stats') {
      const st = store.state.stats || {};
      const msgs = store.state.messages || [];
      const rounds = msgs.filter((m) => m.role === 'user').length;
      out = [
        `通道草稿：${msgs.length} 条消息（${rounds} 轮）`,
        `真实会话：${(store.state.sessions || []).length} 个（${preSystem ? '已隔离，未写入' : '当前'}）`,
        `最近回合：${st.lastMs ? fmtSpan(st.lastMs) : '—'}`,
        `累计耗时：${st.totalMs ? fmtSpan(st.totalMs) : '—'}`,
      ].join('\n');
    } else if (name === 'theme') {
      const v = String(arg || '').toLowerCase();
      if (v !== 'dark' && v !== 'light') out = '用法：/theme dark 或 /theme light';
      else { store.state.settings.theme = v; applyTheme(); store.notify(); out = `✓ 主题已切换：${v === 'dark' ? '深色' : '浅色'}`; }
    } else if (name === 'cache') {
      if (typeof caches === 'undefined') out = '当前环境不支持 Cache Storage（需 https 或 localhost）';
      else {
        const names = await caches.keys();
        if (/^(clear|清空|clean)$/i.test(arg)) {
          await Promise.all(names.map((n) => caches.delete(n)));
          out = `✓ 已清空 ${names.length} 个离线缓存。刷新页面后自动重建（模型/审核资产会重新下载一次）`;
        } else {
          let n = 0;
          for (const nm of names) { try { n += (await (await caches.open(nm)).keys()).length; } catch { /* 忽略 */ } }
          out = `离线缓存：${names.length} 个（${names.join('、') || '无'}），共 ${n} 条资产\n用法：/cache clear 清空（SW 之后自动重建）`;
        }
      }
    } else if (name === 'key') {
      const k = store.state.apiKey || '';
      out = k ? `API Key：${k.slice(0, 10)}…${k.slice(-4)}（已配置；完整 Key 不回显）` : '尚未配置 API Key（普通对话需要；/system 通道本身不需要）';
    } else if (name === 'export') {
      try {
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), version: APP_VERSION, sessions: store.state.sessions }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `teamo-sessions-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        out = `✓ 已导出 ${(store.state.sessions || []).length} 个会话（JSON，含沙箱文件清单）`;
      } catch (e) { out = `导出失败：${e && e.message ? e.message : e}`; }
    } else if (name === 'model') {
      const id = arg.trim();
      if (!id) out = '用法：/model <模型完整 ID>（如 /model claude-sonnet-5）';
      else if (id === '__system__') out = '不能切换到保留标识';
      else if (chatModels().some((m) => m.id === id)) { selectModel(id); out = `✓ 已切换模型：${id}`; }
      else out = `未找到模型「${id}」——输入 /models 查看可用列表`;
    } else if (name === 'models') {
      const ids = chatModels().map((m) => m.id);
      out = `可用模型 ${ids.length} 个：\n` + ids.join('、');
    } else if (name === 'clear') {
      store.state.messages = [];
      store.state.checkpoints = [];
      // 通道内清的是一次性草稿；真实沙箱文件只在真实会话里才动
      if (!inSystem()) { try { agent.loadFiles({}); } catch { /* 忽略 */ } }
      store.notify();
      rebuildMessages(); renderFiles(); updateStats();
      out = inSystem() ? '✓ 通道草稿已清空（真实会话不受影响）' : '✓ 当前会话消息与沙箱文件已清空（会话本身保留）';
    } else {
      out = `未知命令「${name}」——输入 /help 查看可用命令`;
    }
    store.pushMessage({ role: 'assistant', text: out, model: '__system__', done: true });
    store.notify();
    rebuildMessages(); renderSessions(); updateStats();
    const last = store.state.messages[store.state.messages.length - 1];
    if (last && last.model === '__system__') { try { scrollToBottom(); } catch { /* 忽略 */ } }
  }

  function readChoiceAnswers(box) {
    try { return JSON.parse(box.dataset.choiceAnswers || '[]'); } catch { return []; }
  }
  function writeChoiceAnswers(box, answers) {
    box.dataset.choiceAnswers = JSON.stringify((answers || []).map((x) => String(x || '')));
  }
  function setChoiceStep(box, step) {
    if (!box) return;
    const blocks = $$('.choice-qblock', box);
    const count = blocks.length || Number(box.dataset.choiceCount || 1) || 1;
    const idx = Math.max(0, Math.min(count - 1, Number(step) || 0));
    box.dataset.choiceStep = String(idx);
    blocks.forEach((b, i) => b.classList.toggle('active', i === idx));
    const answers = readChoiceAnswers(box);
    const summary = $('[data-choice-summary]', box);
    if (summary) {
      summary.innerHTML = answers.length
        ? answers.map((a, i) => a ? `<button type="button" class="choice-pill" data-choice-jump="${i}" title="回到第 ${i + 1} 题"><b>${i + 1}</b>${esc(a)}</button>` : '').join('')
        : '';
    }
    blocks.forEach((b, i) => {
      const ans = answers[i] || '';
      for (const opt of $$('.choice-opt', b)) opt.classList.toggle('selected', !!ans && opt.getAttribute('data-choice-send') === ans);
    });
    const back = $('[data-choice-back]', box);
    if (back) back.disabled = idx <= 0;
    const progress = $('[data-choice-progress]', box);
    if (progress) progress.textContent = `${idx + 1} / ${count}`;
  }
  function choiceReplyText(box) {
    const answers = readChoiceAnswers(box);
    const qs = $$('.choice-qblock', box).map((b, i) => (($('.choice-q', b) || {}).textContent || `问题 ${i + 1}`).trim());
    return answers.map((a, i) => `${qs[i] || `问题 ${i + 1}`}：${a}`).join('\n');
  }
  // 复制代码块按钮（事件委托）
  msgList.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-code');
    if (btn) {
      const block = btn.closest('.code-block') || btn.parentElement;
      const code = block.querySelector('code');
      if (!code) return;
      navigator.clipboard.writeText(code.textContent).then(() => { btn.textContent = '已复制'; setTimeout(() => (btn.textContent = '复制'), 1500); });
      return;
    }
    const jump = e.target.closest('a.md-jump, a[href^="#"]');
    if (jump && jump.getAttribute('href') && jump.getAttribute('href').startsWith('#')) {
      const wrap = jump.closest('.md-body, .msg');
      const id = decodeURIComponent(jump.getAttribute('href').slice(1));
      const target = wrap && id ? wrap.querySelector(`#${CSS.escape(id)}`) : null;
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    const opt = e.target.closest('[data-choice-send]');
    if (opt) {
      if (getBusy()) return;
      const box = opt.closest('.choice-box');
      const block = opt.closest('.choice-qblock');
      if (!box || !block) return;
      const text = opt.getAttribute('data-choice-send') || '';
      if (!text) return;
      const idx = Number(block.dataset.choiceIdx || box.dataset.choiceStep || 0) || 0;
      const count = Number(box.dataset.choiceCount || $$('.choice-qblock', box).length || 1) || 1;
      const answers = readChoiceAnswers(box);
      answers.length = idx;
      answers[idx] = text;
      writeChoiceAnswers(box, answers);
      if (idx + 1 < count) {
        setChoiceStep(box, idx + 1);
        return;
      }
      if (!store.state.apiKey) { openKeyModal(); toast('请先配置 TeamoRouter API Key', 'warn'); setChoiceStep(box, idx); return; }
      const reply = choiceReplyText(box) || text;
      for (const b of $$('.choice-box', msgList)) b.remove();
      agent.send(reply, []);
      return;
    }
    const back = e.target.closest('[data-choice-back]');
    if (back) {
      e.preventDefault();
      const box = back.closest('.choice-box');
      if (!box) return;
      const target = Math.max(0, (Number(box.dataset.choiceStep || 0) || 0) - 1);
      const answers = readChoiceAnswers(box);
      answers.length = target; // 回退即清掉目标题及其后的旧选择状态
      writeChoiceAnswers(box, answers);
      setChoiceStep(box, target);
      return;
    }
    const choiceJump = e.target.closest('[data-choice-jump]');
    if (choiceJump) {
      e.preventDefault();
      const box = choiceJump.closest('.choice-box');
      if (!box) return;
      setChoiceStep(box, Number(choiceJump.getAttribute('data-choice-jump') || 0));
      return;
    }
    const dl = e.target.closest('[data-sb-dl]');
    if (dl) {
      e.preventDefault();
      const path = dl.getAttribute('data-sb-dl') || '';
      let raw = '';
      try { raw = agent.fs.read(path); } catch { raw = ''; }
      if (!raw) return;
      const { bytes } = fileBytesFromValue(raw);
      const blob = new Blob([bytes]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = path.split('/').pop() || 'file';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  });


  function syncCapLine() {
    const eln = $('#cap-line');
    if (!eln) return;
    const bits = [store.state.model === '__system__' ? 'system-commands' : store.state.model]; // 通道态与模型钮同一叫法（.18）
    if (store.state.settings.thinking !== false) bits.push(`思考 ${reasoningLevelLabel(store.state.settings.reasoningLevel)}`);
    if (store.state.settings.sandboxEnabled) bits.push('沙箱');
    if (store.state.relayOk === true && store.state.settings.webEnabled !== false) bits.push('联网');
    bits.push(getTransport() === 'proxy' ? '中继' : '直连');
    const panelOpen = $('#sandbox-panel') && !$('#sandbox-panel').classList.contains('collapsed');
    if (panelOpen) bits.push('面板');
    eln.textContent = bits.join('  ·  ');
  }

  const statsEl = $('#conv-stats');
  if (statsEl) {
    statsEl.addEventListener('click', (e) => { e.stopPropagation(); showTokBreak(statsEl); });
    statsEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTokBreak(statsEl); } });
  }
  document.addEventListener('click', (e) => {
    const pop = $('#tok-pop');
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target) || (statsEl && statsEl.contains(e.target)) || e.target.closest('.tok-btn')) return;
    hideTokPop();
  });
  window.addEventListener('resize', () => { if ($('#tok-pop') && !$('#tok-pop').hidden) placeTokPop($('#conv-stats')); });

  function syncComposerPh() {
    if (!composer) return;
    composer.placeholder = mqPanel.matches
      ? '输入消息，可粘贴或拖入附件…'
      : '输入消息，Enter 发送 / Shift+Enter 换行，可拖入或粘贴附件…';
  }
  syncComposerPh();
  if (mqPanel.addEventListener) mqPanel.addEventListener('change', () => { syncComposerPh(); if (!store.state.messages.length) { clearEmpty(); renderEmpty(); } });

  function openLightbox(src, alt) {
    const box = $('#img-lightbox');
    const pic = $('#img-lightbox-pic');
    if (!box || !pic || !src) return;
    pic.src = src;
    pic.alt = alt || '';
    box.hidden = false;
  }
  function closeLightbox() {
    const box = $('#img-lightbox');
    if (!box) return;
    box.hidden = true;
    const pic = $('#img-lightbox-pic');
    if (pic) pic.removeAttribute('src');
  }
  const lightbox = $('#img-lightbox');
  if (lightbox) lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox || e.target.closest('.img-lightbox-x')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#img-lightbox') && !$('#img-lightbox').hidden) closeLightbox(); });
  document.addEventListener('click', (e) => {
    const img = e.target.closest('img');
    if (!img || img.id === 'img-lightbox-pic') return;
    if (!img.closest('.md-body, .att-img, .fv-img, .file-viewer')) return;
    const src = img.currentSrc || img.src;
    if (!src) return;
    e.preventDefault();
    openLightbox(src, img.alt);
  });

  // 复制工具入参/出参 JSON（不触发展开）
  msgList.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip-copy');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const chip = btn.closest('.chip');
    if (!chip) return;
    const which = btn.dataset.which;
    const payload = which === 'out' ? (chip._out || $('.chip-result', chip)?.textContent || '') : JSON.stringify(chip._args ?? {}, null, 2);
    navigator.clipboard.writeText(String(payload || '')).then(() => {
      const prev = btn.textContent; btn.textContent = '已复制'; setTimeout(() => (btn.textContent = prev), 1200);
    }).catch(() => toast('复制失败', 'warn'));
  });

  // ⌘K 命令面板
  const pal = $('#cmd-palette');
    const palInput = $('#cmd-input');
  const palList = $('#cmd-list');
  let palItems = [];
  let palIdx = 0;
  function collectCmds() {
    const items = [];
    chatModels().forEach((m, i) => items.push({
      group: '模型', id: 'm:' + m.id, label: m.id, hint: m.provider || '',
      kbd: i < 9 ? '⌃' + (i + 1) : '',
      run: () => selectModel(m.id),
    }));
    try {
      for (const f of agent.fs.list()) {
        items.push({ group: '文件', id: 'f:' + f.path, label: f.path, run: () => {
          setPanelCollapsed(false);
          openFileViewer(f.path);
        } });
      }
    } catch { /* fs 未就绪 */ }
    items.push({ group: '操作', id: 'p:panel', label: '打开 / 收起沙箱面板', kbd: '⌘B', run: () => setPanelCollapsed(!$('#sandbox-panel').classList.contains('collapsed')) });
    items.push({ group: '操作', id: 'p:new', label: '新建会话', run: () => $('#new-session').click() });
    if (globalThis.__teamoDebugToggle) items.push({ group: '操作', id: 'p:debug', label: globalThis.__teamoDebugActive && globalThis.__teamoDebugActive() ? '关闭调试浮窗（系统日志）' : '打开调试浮窗（系统日志）', kbd: '⌃⌥D', run: () => globalThis.__teamoDebugToggle() });
    return items;
  }
  function paintPal() {
    if (!palList) return;
    const vis = filterCmds(palInput ? palInput.value : '', palItems);
    palList.innerHTML = vis.map((it, i) => `<button type="button" class="cmd-item${i === palIdx ? ' active' : ''}" data-i="${i}" role="option"><span class="cmd-g">${esc(it.group)}</span><span class="cmd-l">${esc(it.label)}</span>${it.kbd ? `<span class="cmd-k">${esc(it.kbd)}</span>` : ''}</button>`).join('')
      || '<div class="empty-hint">无匹配</div>';
    palList._vis = vis;
  }
  function openPal() {
    if (!pal) return;
    palItems = collectCmds();
    palIdx = 0;
    pal.hidden = false;
    if (palInput) { palInput.value = ''; palInput.focus(); }
    paintPal();
  }
  function closePal() {
    if (pal) pal.hidden = true;
  }
  function runPal(it) {
    closePal();
    if (it && typeof it.run === 'function') it.run();
  }
  if (palInput) palInput.addEventListener('input', () => { palIdx = 0; paintPal(); });
  if (palList) palList.addEventListener('click', (e) => {
    const row = e.target.closest('.cmd-item');
    if (!row) return;
    const vis = palList._vis || [];
    runPal(vis[+row.dataset.i]);
  });
  if (pal) pal.addEventListener('click', (e) => { if (e.target === pal) closePal(); });

  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const inPal = pal && !pal.hidden;
    if (inPal) {
      const vis = palList && palList._vis || [];
      if (e.key === 'Escape') { e.preventDefault(); closePal(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = Math.min(vis.length - 1, palIdx + 1); paintPal(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); paintPal(); return; }
      if (e.key === 'Enter') { e.preventDefault(); runPal(vis[palIdx]); return; }
    }
    if (e.key === 'Escape' && pal && !pal.hidden) { e.preventDefault(); closePal(); return; }
    if (meta && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); inPal ? closePal() : openPal(); return; }
    if (meta && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      setPanelCollapsed(!$('#sandbox-panel').classList.contains('collapsed'));
      return;
    }
    if ((e.ctrlKey || e.altKey) && /^[1-9]$/.test(e.key)) {
      const mods = chatModels();
      const pick = mods[+e.key - 1];
      if (pick) { e.preventDefault(); selectModel(pick.id); toast(`模型 ${pick.id}`, 'ok', 1800); }
    }
  });

  // ── 初次渲染 ──
  rebuildMessages();
  setInterval(() => {
    for (const m of store.state.messages || []) {
      if (m.role !== 'assistant' || !m.done) continue;
      const wrap = msgNodes.get(m.id);
      if (wrap) paintFoot(wrap, m);
    }
  }, 30000);
  setStatus('idle');
  updateTransportBadge();
  updateStats();
  renderTimeStats();
  syncCapLine();
  // 构建标识：静态站点无法靠响应头保证刷新即最新，先把版本号亮出来便于自检
  const stampEl = $('#build-stamp');
  if (stampEl) {
    // 入口 index.html 自带 app-version meta；子资源 URL 没有版本参数（Pages 对所有静态文件统一回
    // cache-control: max-age=600），所以「入口已新、某个 js 还是旧的」是真实存在的窗口期
    //（这正是硬刷新后仍看到旧版本号的机制）。这里直接比对并把原因说出来。
    const entryVer = (document.querySelector('meta[name="app-version"]') || {}).content || '';
    const drifted = !!entryVer && entryVer !== APP_VERSION;
    const rel = `Teamo ${APP_RELEASE} 正式版`;
    stampEl.textContent = drifted ? `${rel} · v${APP_VERSION} / 入口 ${entryVer}` : `${rel} · v${APP_VERSION}`;
    stampEl.title = `${rel}（构建 ${APP_VERSION}）${drifted ? `；入口 index.html 是 ${entryVer}（两者应一致）` : ''} · 若看到的不是最新改动，请按 Ctrl/Cmd + Shift + R 强制刷新`;
    if (drifted) setTimeout(() => toast(`资源缓存不一致（入口 ${entryVer}，模块 ${APP_VERSION}）：请硬刷新或用无痕窗口打开`, 'warn', 9000), 700);
  }

  if (!store.state.apiKey) setTimeout(openKeyModal, 600);

  // ── 暴露给 agent hooks ───────────────────────────────────────────────
  return {
    setStatus,
    refreshKeyBtn: updateKeyBtn,   // main.js 解封成功后刷新按钮文案
    // 刷新页面后：外置在 IndexedDB 的重数据取回来了 → 重绘消息（附件图片、芯片里的生成图）
    // 与文件面板（沙箱里的图），并把沙箱重新灌进 agent（createAgent 建 fs 时它们还没回来）
    afterHydrate() {
      try { agent.loadFiles(store.state.files); } catch { /* 忽略 */ }
      rebuildMessages(); renderFiles(); renderSessions(); updateStats(); updateTransportBadge();
    },
    updateTransportBadge,
    updateStats,
    renderSessions,
    renderFiles,
    rebuildMessages, // 外部触发整段对话重绘（会话切换、示例卡刷新等）
    // 用户消息入列后立刻上屏：否则要等本轮输出完（甚至切出再切回会话）才看得到自己说了什么
    onUserMessage(m) {
      // 兼容只传文本的旧调用方（缓存错配时会出现）：退化为「最近一条还没上屏的 user 消息」
      const msg = (m && m.id) ? m : [...store.state.messages].reverse().find((x) => x.role === 'user' && !msgNodes.has(x.id));
      if (!msg || !msg.id || msgNodes.has(msg.id)) return;
      if (!msg.silent) {
        for (const box of $$('.choice-box', msgList)) box.remove();
        appendMessage(msg);
      }
      refreshActionVisibility();
    },
    onJevPlan(m) {
      const wrap = m && m.id ? msgNodes.get(m.id) : null;
      if (!wrap || !m.jev || !m.jev.summary) return;
      if ($('.jev-chip', wrap)) {
        $('.jev-chip', wrap).textContent = `Jev · ${m.jev.summary}`;
        return;
      }
      const chip = el('div', 'jev-chip', `Jev · ${esc(m.jev.summary)}`);
      chip.title = 'TypeSafe Jev 对本轮的校准分类';
      const bar = $('.msg-user-bar', wrap);
      const actions = $('.msg-actions-user', wrap);
      if (bar && actions) bar.insertBefore(chip, actions);
      else if (bar) bar.prepend(chip);
      else wrap.appendChild(chip);
    },
    onAssistantStart(m) { appendMessage(m); },
    onDelta(m) { schedulePaint(m); },
    onReasoning(m) { schedulePaint(m); },
    onToolDelta(m) { schedulePaint(m); },
    onAssistantDone(m) {
      const wrap = msgNodes.get(m.id);
      if (wrap) paintAssistant(wrap, m);
      scrollToBottom();
      renderSessions(); // 刷新会话记录的轮数/时间
      refreshActionVisibility();
      updateTransportBadge();
    },
    onTurnTiming(ms) {
      if (!(ms > 0)) return;
      const st = store.state.stats || (store.state.stats = { lastMs: 0, totalMs: 0 });
      st.lastMs = ms;
      st.totalMs += ms;
      store.notify();
      renderTimeStats();
    },
    // 回合结束后给会话起个标题（Agent 总结；用户手改过的不会被覆盖）
    // 联网：进度与来源（模型服务端返回的 web_search 事件）
    onWebSearch: (m) => {
      const wrap = msgNodes.get(m && m.id);
      if (!wrap) return;
      paintAssistant(wrap, store.state.messages.find((x) => x.id === m.id) || m);
    },
    onWebFallback: (model, why) => {
      toast(`联网已自动关闭（${String(why || '').slice(0, 120)}）`, 'warn', 7000);
      syncWeb();
    },
    // 起标题失败绝不能冒泡到回合流程（catch 掉，标题自然退回「首条消息截断」）
    autoTitle: () => autoTitle(store).then((r) => { if (r && r.ok) renderSessions(); return r; }, () => ({ ok: false, reason: 'view-error' })),
    onToolStart() { scrollToBottom(); },
    onToolResult(call, result) {
      renderFiles();
      updateStats();
      renderMemory();
      // 同步回填对话流中的工具芯片（成功 ✓ / 失败红点 + 展开详情）
      attachToolResult({ toolCallId: call.id, content: result });
    },
    // 用户点了「停止」：Agent 已把那条消息标成 cancelled+done，但视图不会自己重画 ——
    // 停止前若首字还没到，屏上会一直留着「正在连接 xxx，等待首个响应…」和转圈。
    // 这里显式重绘这一条（并收起未完成的工具芯片），保证停下就是停下。
    onCancelled() {
      const last = [...store.state.messages].reverse().find((m) => m.role === 'assistant' && m.cancelled)
        || [...store.state.messages].reverse().find((m) => m.role === 'assistant' && !m.done);
      if (last) {
        const wrap = msgNodes.get(last.id);
        if (wrap) paintAssistant(wrap, last);
        for (const chip of $$('.chip', wrap || msgList)) {
          if (!chip.classList.contains('done')) {
            chip.classList.add('done');
            const st = $('.chip-state', chip);
            if (st && st.textContent === '…') { st.textContent = '已停止'; }
          }
        }
      }
      refreshActionVisibility();
      scrollToBottom();
    },

    // 沙箱执行进度 → 回写到对应工具芯片的状态位（Pyodide 首次加载 10~30s、
    // C++ 远程编译、子智能体委派都需要可见的进度，否则界面看起来像卡死）
    onToolEvent(call, patch) {
      const chip = $(`.chip[data-call-id="${CSS.escape(call.id)}"]`, msgList);
      if (!chip) return;
      const state = $('.chip-state', chip);
      if (!state) return;
      if (patch.status === 'running') {
        chip.classList.add('running');
        state.textContent = patch.note || '执行中…';
        state.title = patch.note || '';
        state.classList.remove('bad');
      } else if (patch.status === 'error') {
        chip.classList.remove('running');
        chip.classList.add('fail');
        chip.classList.remove('ok');
        const errTxt = String((patch.error && patch.error.message) || patch.note || '工具失败').slice(0, 400);
        state.innerHTML = `<span class="chip-fail" title="${esc(errTxt)}">✗</span>`;
        state.title = errTxt;
        state.classList.add('bad');
      } else if (patch.status === 'ok') {
        chip.classList.remove('running');
        chip.classList.add('ok');
        chip.classList.remove('fail');
        const dur = patch.durationMs != null ? fmtSpan(patch.durationMs) : '';
        state.innerHTML = `<span class="chip-ok">✓</span>${dur ? ` <span class="chip-time">${dur}</span>` : ''}`;
        state.title = patch.note || '';
        state.classList.remove('bad');
      }
      if (patch.image) {
        // 图走正文 sandbox:// 占位，不在芯片里画。仍记在 toolCall 上，好进 IDB。
        call.image = patch.image;
        if (patch.imagePath) call.imagePath = patch.imagePath;
        if (patch.width) call.width = patch.width;
        if (patch.height) call.height = patch.height;
        store.save();
      }
      if (patch.status === 'running' || patch.image) scrollToBottom();
    },
    attachToolResult,
    // 用户附件已通过审核并复制到沙箱 uploads/ → 刷新文件面板并提示（可在面板内单个下载或整包 ZIP）
    onFsChange(paths) {
      renderFiles();
      if (paths && paths.length) toast(`附件已复制到沙箱：${paths.join('、')}`, 'ok', 4200);
    },
    scrollToBottom: () => scrollToBottom(true),
    syncWeb,
  };
}
