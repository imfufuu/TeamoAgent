// ─── Mermaid 流程图 / 时序图 与 DOT 有向图 → SVG（本地，不走生图模型）──

const C = {
  bg: '#0f0f0e',
  box: '#1b1b18',
  stroke: '#d8d3c7',
  text: '#f4f1ea',
  muted: '#9a958a',
  accent: '#c4b5fd',
  edge: '#a8a39a',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrapSvg(w, h, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">`
    + `<rect width="100%" height="100%" fill="${C.bg}"/>${body}</svg>`;
}

function textWidth(s, size = 13) {
  const t = String(s || '');
  let w = 0;
  for (const ch of t) w += /[\u4e00-\u9fff]/.test(ch) ? 1 : 0.62;
  return Math.ceil(w * size + 8);
}

function unquote(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t.replace(/^\[|\]$/g, '').replace(/^\(|\)$/g, '').replace(/^\{|\}$/g, '');
}

function parseMermaidFlow(src) {
  const lines = String(src).split(/\r?\n/).map((l) => l.replace(/%%.*$/, '').trim()).filter(Boolean);
  if (!lines.length) throw new Error('空图');
  const head = lines[0].toLowerCase();
  if (!/^(graph|flowchart)\b/.test(head)) return null;
  const dirTok = /\b(TD|TB|BT|LR|RL)\b/i.exec(head);
  const dir = (dirTok ? dirTok[1] : 'TD').toUpperCase();
  const vertical = dir === 'TD' || dir === 'TB' || dir === 'BT';
  const nodes = new Map();
  const edges = [];
  const ensure = (id, label, shape) => {
    if (!nodes.has(id)) nodes.set(id, { id, label: label || id, shape: shape || 'rect' });
    else {
      if (label) nodes.get(id).label = label;
      if (shape) nodes.get(id).shape = shape;
    }
    return nodes.get(id);
  };
  const nodePat = /([A-Za-z0-9_]+)(\[\[.*?\]\]|\[.*?\]|\(\(.*?\)\)|\(.*?\)|\{.*?\})?/;
  const edgePat = new RegExp(
    `^${nodePat.source}\\s*(-->|---|-.->|==>|--x|---|-->)\\s*(?:\\|([^|]+)\\|)?\\s*${nodePat.source}$`,
  );
  for (const line of lines.slice(1)) {
    if (/^subgraph\b|^end$/i.test(line) || /^classDef\b/i.test(line)) continue;
    const m = edgePat.exec(line.replace(/\s+/g, ' '));
    if (m) {
      const a = ensure(m[1], m[2] ? unquote(m[2]) : '', shapeOf(m[2]));
      const b = ensure(m[5], m[6] ? unquote(m[6]) : '', shapeOf(m[6]));
      edges.push({ from: a.id, to: b.id, label: (m[4] || '').trim() });
      continue;
    }
    const n = line.match(new RegExp(`^${nodePat.source}$`));
    if (n) ensure(n[1], n[2] ? unquote(n[2]) : n[1], shapeOf(n[2]));
  }
  if (!nodes.size) throw new Error('没有识别到节点。示例：flowchart TD\\n  A[开始] --> B{判断}');
  return { kind: 'flow', dir, vertical, nodes: [...nodes.values()], edges };
}

function shapeOf(tok) {
  const t = String(tok || '');
  if (t.startsWith('[[')) return 'rect';
  if (t.startsWith('((')) return 'circle';
  if (t.startsWith('{')) return 'diamond';
  if (t.startsWith('(')) return 'round';
  return 'rect';
}

function parseMermaidSeq(src) {
  const lines = String(src).split(/\r?\n/).map((l) => l.replace(/%%.*$/, '').trim()).filter(Boolean);
  if (!lines.length || !/^sequenceDiagram\b/i.test(lines[0])) return null;
  const actors = [];
  const seen = new Set();
  const msgs = [];
  const add = (name) => {
    const id = String(name || '').trim();
    if (!id) return;
    if (!seen.has(id)) { seen.add(id); actors.push(id); }
  };
  for (const line of lines.slice(1)) {
    const p = line.match(/^participant\s+(\S+)(?:\s+as\s+(.+))?$/i);
    if (p) { add(p[2] || p[1]); continue; }
    const m = line.match(/^(.+?)(-->>|->>|-->>|->)(.+?):\s*(.*)$/);
    if (m) {
      const a = m[1].trim();
      const b = m[3].trim();
      add(a); add(b);
      msgs.push({ from: a, to: b, label: m[4].trim(), dash: m[2].includes('--') });
    }
  }
  if (!actors.length) throw new Error('时序图没有参与者。示例：sequenceDiagram\\n  Alice->>Bob: 你好');
  return { kind: 'seq', actors, msgs };
}

function layoutFlow(g) {
  const idx = new Map(g.nodes.map((n, i) => [n.id, i]));
  const incoming = g.nodes.map(() => 0);
  const outs = g.nodes.map(() => []);
  for (const e of g.edges) {
    if (!idx.has(e.from) || !idx.has(e.to)) continue;
    incoming[idx.get(e.to)] += 1;
    outs[idx.get(e.from)].push(idx.get(e.to));
  }
  const rank = g.nodes.map(() => 0);
  const q = [];
  incoming.forEach((n, i) => { if (!n) q.push(i); });
  const seen = new Set();
  while (q.length) {
    const i = q.shift();
    if (seen.has(i)) continue;
    seen.add(i);
    for (const j of outs[i]) {
      rank[j] = Math.max(rank[j], rank[i] + 1);
      q.push(j);
    }
  }
  const byRank = new Map();
  g.nodes.forEach((n, i) => {
    const r = rank[i];
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r).push(n);
  });
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const padX = 28;
  const padY = 28;
  const gapX = 36;
  const gapY = 56;
  const boxes = new Map();
  ranks.forEach((r, ri) => {
    const row = byRank.get(r);
    const heights = row.map((n) => (n.shape === 'diamond' ? 52 : 40));
    const widths = row.map((n) => Math.max(72, Math.min(220, textWidth(n.label) + 28)));
    const totalW = widths.reduce((a, b) => a + b, 0) + gapX * (row.length - 1);
    let x = padX;
    row.forEach((n, i) => {
      const w = widths[i];
      const h = heights[i];
      const y = padY + ri * (Math.max(...heights) + gapY);
      boxes.set(n.id, { ...n, x, y, w, h });
      x += w + gapX;
    });
    const used = x - gapX;
    if (used < totalW) { /* noop */ }
  });
  let maxX = padX;
  let maxY = padY;
  for (const b of boxes.values()) {
    maxX = Math.max(maxX, b.x + b.w + padX);
    maxY = Math.max(maxY, b.y + b.h + padY + 12);
  }
  // 居中每一层
  const layers = new Map();
  for (const b of boxes.values()) {
    if (!layers.has(b.y)) layers.set(b.y, []);
    layers.get(b.y).push(b);
  }
  for (const row of layers.values()) {
    const right = Math.max(...row.map((b) => b.x + b.w));
    const shift = Math.max(0, (maxX - padX - right) / 2);
    for (const b of row) b.x += shift;
  }
  return { boxes, w: Math.max(maxX, 240), h: Math.max(maxY, 160) };
}

function nodeSvg(b) {
  const tx = b.x + b.w / 2;
  const ty = b.y + b.h / 2 + 5;
  const label = `<text x="${tx}" y="${ty}" text-anchor="middle" font-size="13" fill="${C.text}" font-family="ui-sans-serif,system-ui,sans-serif">${esc(b.label)}</text>`;
  if (b.shape === 'diamond') {
    const cx = tx, cy = b.y + b.h / 2;
    const pts = `${cx},${b.y} ${b.x + b.w},${cy} ${cx},${b.y + b.h} ${b.x},${cy}`;
    return `<polygon points="${pts}" fill="${C.box}" stroke="${C.stroke}" stroke-width="1.2"/>${label}`;
  }
  if (b.shape === 'circle') {
    const r = Math.max(b.w, b.h) / 2;
    return `<circle cx="${tx}" cy="${b.y + b.h / 2}" r="${r}" fill="${C.box}" stroke="${C.stroke}" stroke-width="1.2"/>${label}`;
  }
  const rx = b.shape === 'round' ? 16 : 8;
  return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${rx}" fill="${C.box}" stroke="${C.stroke}" stroke-width="1.2"/>${label}`;
}

function edgeSvg(e, boxes) {
  const a = boxes.get(e.from);
  const b = boxes.get(e.to);
  if (!a || !b) return '';
  const x1 = a.x + a.w / 2;
  const y1 = a.y + a.h;
  const x2 = b.x + b.w / 2;
  const y2 = b.y;
  const midy = (y1 + y2) / 2;
  const d = `M ${x1} ${y1} C ${x1} ${midy}, ${x2} ${midy}, ${x2} ${y2}`;
  let lab = '';
  if (e.label) {
    lab = `<text x="${(x1 + x2) / 2}" y="${midy - 4}" text-anchor="middle" font-size="11" fill="${C.accent}" font-family="ui-sans-serif,system-ui,sans-serif">${esc(e.label)}</text>`;
  }
  return `<path d="${d}" fill="none" stroke="${C.edge}" stroke-width="1.3" marker-end="url(#arr)"/>${lab}`;
}

function renderFlow(g) {
  const { boxes, w, h } = layoutFlow(g);
  const nodes = [...boxes.values()].map(nodeSvg).join('');
  const edges = g.edges.map((e) => edgeSvg(e, boxes)).join('');
  const defs = `<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${C.edge}"/></marker></defs>`;
  return wrapSvg(w, h, defs + edges + nodes);
}

function renderSeq(g) {
  const pad = 36;
  const colW = Math.max(120, ...g.actors.map((a) => textWidth(a) + 40));
  const headH = 48;
  const rowH = 44;
  const w = pad * 2 + colW * g.actors.length;
  const h = pad + headH + rowH * Math.max(g.msgs.length, 1) + pad;
  const xOf = (name) => pad + g.actors.indexOf(name) * colW + colW / 2;
  let body = '';
  g.actors.forEach((a, i) => {
    const x = pad + i * colW + 12;
    const bw = colW - 24;
    body += `<rect x="${x}" y="${pad}" width="${bw}" height="32" rx="8" fill="${C.box}" stroke="${C.stroke}"/>`;
    body += `<text x="${x + bw / 2}" y="${pad + 21}" text-anchor="middle" font-size="13" fill="${C.text}" font-family="ui-sans-serif,system-ui,sans-serif">${esc(a)}</text>`;
    const lx = xOf(a);
    body += `<line x1="${lx}" y1="${pad + 32}" x2="${lx}" y2="${h - pad}" stroke="${C.muted}" stroke-dasharray="3 6"/>`;
  });
  g.msgs.forEach((m, i) => {
    const y = pad + headH + i * rowH + 10;
    const x1 = xOf(m.from);
    const x2 = xOf(m.to);
    const dash = m.dash ? ' stroke-dasharray="5 4"' : '';
    body += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${C.edge}" stroke-width="1.4"${dash} marker-end="url(#arr)"/>`;
    body += `<text x="${(x1 + x2) / 2}" y="${y - 6}" text-anchor="middle" font-size="11" fill="${C.accent}" font-family="ui-sans-serif,system-ui,sans-serif">${esc(m.label)}</text>`;
  });
  const defs = `<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${C.edge}"/></marker></defs>`;
  return wrapSvg(w, h, defs + body);
}

export function renderMermaid(code) {
  const src = String(code == null ? '' : code).trim();
  if (!src) return { ok: false, error: 'code 不能为空' };
  try {
    const seq = parseMermaidSeq(src);
    if (seq) return { ok: true, svg: renderSeq(seq), kind: 'sequence' };
    const flow = parseMermaidFlow(src);
    if (flow) return { ok: true, svg: renderFlow(flow), kind: 'flowchart' };
    return { ok: false, error: '仅支持 flowchart/graph（TD/LR）与 sequenceDiagram。不要用 generate_image 硬画。' };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function parseDot(src) {
  const s = String(src);
  if (!/\b(di)?graph\b/i.test(s)) return null;
  const nodes = new Map();
  const edges = [];
  const ensure = (id, label) => {
    const k = unquote(id);
    if (!nodes.has(k)) nodes.set(k, { id: k, label: label || k, shape: 'rect' });
    else if (label) nodes.get(k).label = label;
    return nodes.get(k);
  };
  const attr = (raw) => {
    const o = {};
    String(raw || '').replace(/(\w+)\s*=\s*("(?:\\.|[^"])*"|[^\s,\]]+)/g, (_, k, v) => {
      o[k.toLowerCase()] = unquote(v);
      return '';
    });
    return o;
  };
  const reEdge = /("(?:\\.|[^"])+"|[A-Za-z_][\w]*)\s*(->|--)\s*("(?:\\.|[^"])+"|[A-Za-z_][\w]*)\s*(?:\[([^\]]*)\])?/g;
  const reNode = /("(?:\\.|[^"])+"|[A-Za-z_][\w]*)\s*\[([^\]]*)\]/g;
  let m;
  const used = new Set();
  while ((m = reEdge.exec(s))) {
    const a = unquote(m[1]);
    const b = unquote(m[3]);
    const lab = attr(m[4]).label || '';
    ensure(a); ensure(b);
    edges.push({ from: a, to: b, label: lab });
    used.add(m.index);
  }
  while ((m = reNode.exec(s))) {
    const id = unquote(m[1]);
    if (['graph', 'digraph', 'node', 'edge', 'subgraph'].includes(id.toLowerCase())) continue;
    ensure(id, attr(m[2]).label || id);
  }
  if (!nodes.size) throw new Error('没有识别到节点。示例：digraph { a -> b }');
  return { kind: 'flow', dir: /rankdir\s*=\s*LR/i.test(s) ? 'LR' : 'TD', vertical: !/rankdir\s*=\s*LR/i.test(s), nodes: [...nodes.values()], edges };
}

export function renderDot(code) {
  const src = String(code == null ? '' : code).trim();
  if (!src) return { ok: false, error: 'code 不能为空' };
  try {
    const g = parseDot(src);
    if (!g) return { ok: false, error: '需要 digraph/graph { ... }' };
    return { ok: true, svg: renderFlow(g), kind: 'dot' };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
