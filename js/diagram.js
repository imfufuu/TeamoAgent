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

const WIDE_CHAR_RE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

function charUnits(ch) {
  if (WIDE_CHAR_RE.test(ch)) return 1.02;
  if (/[A-Z0-9]/.test(ch)) return 0.65;
  return 0.56;
}

function textWidth(s, size = 13) {
  const t = String(s || '');
  let w = 0;
  for (const ch of t) w += charUnits(ch);
  return Math.ceil(w * size + 10);
}

function unquote(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return t.replace(/^\[|\]$/g, '').replace(/^\(|\)$/g, '').replace(/^\{|\}$/g, '');
}

// 将字面量 \n / \l / \r / <br> 切分为多行，并对超长单行做自然断行，避免文本溢出节点框
function splitLabelLines(raw, maxUnits = 20) {
  const text = String(raw == null ? '' : raw)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\[nlr]/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .trim();
  if (!text) return [''];
  const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter((l, i, arr) => l || arr.length === 1);
  const out = [];
  for (const line of rawLines) {
    let units = 0;
    for (const ch of line) units += charUnits(ch);
    if (units <= maxUnits + 2) {
      out.push(line);
      continue;
    }
    // 按自然分隔符或字符视觉宽度自动折行
    let cur = '';
    let curU = 0;
    const tokens = line.split(/(\s+\/\s+|\s+·\s+|\/|，|,|\s+)/).filter(Boolean);
    for (const tok of tokens) {
      let tokU = 0;
      for (const ch of tok) tokU += charUnits(ch);
      if (cur && curU + tokU > maxUnits) {
        out.push(cur.trim());
        cur = tok.replace(/^\s+/, '');
        curU = 0;
        for (const ch of cur) curU += charUnits(ch);
      } else if (tokU > maxUnits * 1.25) {
        for (const ch of tok) {
          const u = charUnits(ch);
          if (cur && curU + u > maxUnits) {
            out.push(cur.trim());
            cur = ch;
            curU = u;
          } else {
            cur += ch;
            curU += u;
          }
        }
      } else {
        cur += tok;
        curU += tokU;
      }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out.length ? out : [''];
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
  const nodePat = /([A-Za-z0-9_-]+)(\[\[.*?\]\]|\[.*?\]|\(\(.*?\)\)|\(.*?\)|\{.*?\})?/;
  const edgePat = new RegExp(
    `^${nodePat.source}\\s*(-->|---|-.->|==>|--x|---|-->)\\s*(?:\\|([^|]+)\\|)?\\s*${nodePat.source}$`,
  );
  for (const line of lines.slice(1)) {
    if (/^subgraph\b|^end$/i.test(line) || /^classDef\b|^style\b|^linkStyle\b|^direction\b/i.test(line)) continue;
    const m = edgePat.exec(line.replace(/\s+/g, ' '));
    if (m) {
      const a = ensure(m[1], m[2] ? unquote(m[2]) : '', m[2] ? shapeOf(m[2]) : '');
      const b = ensure(m[5], m[6] ? unquote(m[6]) : '', m[6] ? shapeOf(m[6]) : '');
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
  const nCount = g.nodes.length;
  const idx = new Map(g.nodes.map((n, i) => [n.id, i]));
  const adj = g.nodes.map(() => []);
  for (let ei = 0; ei < g.edges.length; ei++) {
    const e = g.edges[ei];
    if (!idx.has(e.from) || !idx.has(e.to)) continue;
    const u = idx.get(e.from);
    const v = idx.get(e.to);
    if (u === v) {
      e._back = true;
      continue;
    }
    adj[u].push({ to: v, ei });
  }

  // 1. 使用 DFS 识别环路回边（back-edges），防止反馈闭环把上游主节点推到底部
  const inDegRaw = g.nodes.map(() => 0);
  for (let u = 0; u < nCount; u++) {
    for (const { to } of adj[u]) inDegRaw[to] += 1;
  }
  const order = [];
  for (let i = 0; i < nCount; i++) if (inDegRaw[i] === 0) order.push(i);
  for (let i = 0; i < nCount; i++) if (inDegRaw[i] > 0) order.push(i);

  const state = new Uint8Array(nCount); // 0=unvisited, 1=visiting, 2=visited
  const backEdgeSet = new Set();
  const dfs = (u) => {
    state[u] = 1;
    for (const { to, ei } of adj[u]) {
      if (state[to] === 1) {
        backEdgeSet.add(ei);
        g.edges[ei]._back = true;
      } else if (state[to] === 0) {
        dfs(to);
      }
    }
    state[u] = 2;
  };
  for (const start of order) {
    if (state[start] === 0) dfs(start);
  }

  // 2. 在去环 DAG 上计算拓扑层级（Kahn 最长路径分层）
  const dagIn = g.nodes.map(() => 0);
  const dagOut = g.nodes.map(() => []);
  for (let u = 0; u < nCount; u++) {
    for (const { to, ei } of adj[u]) {
      if (backEdgeSet.has(ei)) continue;
      dagIn[to] += 1;
      dagOut[u].push(to);
    }
  }
  const rank = g.nodes.map(() => 0);
  const q = [];
  for (let i = 0; i < nCount; i++) {
    if (dagIn[i] === 0) q.push(i);
  }
  if (!q.length && nCount > 0) q.push(0);
  const remIn = dagIn.slice();
  const visitedDag = new Set();
  while (q.length) {
    const u = q.shift();
    visitedDag.add(u);
    for (const v of dagOut[u]) {
      if (rank[v] < rank[u] + 1) rank[v] = Math.min(nCount, rank[u] + 1);
      remIn[v] -= 1;
      if (remIn[v] <= 0 && !visitedDag.has(v)) {
        visitedDag.add(v);
        q.push(v);
      }
    }
  }

  // 3. 预计算每个节点的多行文本与真实宽高（严禁把框宽裁到小于文字宽）
  const nodeMeta = new Map();
  for (const n of g.nodes) {
    const lines = splitLabelLines(n.label, 20);
    const maxLineW = Math.max(...lines.map((l) => textWidth(l, 13)));
    const w = Math.max(76, maxLineW + (n.shape === 'diamond' ? 44 : 28));
    const h = Math.max(n.shape === 'diamond' ? 54 : 40, lines.length * 18 + (n.shape === 'diamond' ? 28 : 18));
    nodeMeta.set(n.id, { lines, w, h });
  }

  // 4. 按层级分组，并对单层节点过多（>4 个）的行自动拆分为平衡子行，避免一字排开过宽
  const rawByRank = new Map();
  g.nodes.forEach((n, i) => {
    const r = rank[i];
    if (!rawByRank.has(r)) rawByRank.set(r, []);
    rawByRank.get(r).push(n);
  });
  const sortedRanks = [...rawByRank.keys()].sort((a, b) => a - b);
  const rows = [];
  const MAX_PER_ROW = 4;
  for (const r of sortedRanks) {
    const list = rawByRank.get(r);
    if (list.length <= MAX_PER_ROW) {
      rows.push(list);
    } else {
      const chunks = Math.ceil(list.length / MAX_PER_ROW);
      const perRow = Math.ceil(list.length / chunks);
      for (let c = 0; c < list.length; c += perRow) {
        rows.push(list.slice(c, c + perRow));
      }
    }
  }

  // 5. 逐行排布并居中对齐
  const padX = 36;
  const padY = 32;
  const gapX = 32;
  const gapY = 64;
  const boxes = new Map();
  let curY = padY;
  let maxX = 240;

  rows.forEach((row, ri) => {
    const rowH = Math.max(...row.map((n) => nodeMeta.get(n.id).h));
    let x = padX;
    row.forEach((n) => {
      const m = nodeMeta.get(n.id);
      const y = curY + Math.round((rowH - m.h) / 2);
      boxes.set(n.id, { ...n, lines: m.lines, x, y, w: m.w, h: m.h, row: ri });
      x += m.w + gapX;
    });
    maxX = Math.max(maxX, x - gapX + padX);
    curY += rowH + gapY;
  });

  const maxY = Math.max(160, curY - gapY + padY);

  // 居中每一行
  rows.forEach((row) => {
    if (!row.length) return;
    const first = boxes.get(row[0].id);
    const last = boxes.get(row[row.length - 1].id);
    const rowSpan = (last.x + last.w) - first.x;
    const shift = Math.max(0, Math.round((maxX - rowSpan) / 2 - first.x));
    for (const n of row) {
      boxes.get(n.id).x += shift;
    }
  });

  return { boxes, w: Math.max(maxX, 260), h: maxY };
}

function nodeSvg(b) {
  const tx = b.x + b.w / 2;
  const lines = b.lines && b.lines.length ? b.lines : [b.label];
  const lineH = 18;
  const totalTextH = (lines.length - 1) * lineH;
  const startY = Math.round(b.y + b.h / 2 - totalTextH / 2 + 4.5);
  const tspans = lines
    .map((ln, idx) => `<tspan x="${tx}" y="${startY + idx * lineH}">${esc(ln)}</tspan>`)
    .join('');
  const label = `<text x="${tx}" y="${startY}" text-anchor="middle" font-size="13" fill="${C.text}" font-family="ui-sans-serif,system-ui,sans-serif">${tspans}</text>`;
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

function edgeSvg(e, boxes, ei = 0) {
  const a = boxes.get(e.from);
  const b = boxes.get(e.to);
  if (!a || !b) return '';
  let d = '';
  let lx = 0;
  let ly = 0;

  if (a.id === b.id) {
    // 自环边
    const x1 = a.x + a.w * 0.7;
    const y1 = a.y;
    const x2 = a.x + a.w;
    const y2 = a.y + a.h * 0.5;
    d = `M ${x1} ${y1} C ${x1 + 28} ${y1 - 28}, ${x2 + 28} ${y2 - 18}, ${x2} ${y2}`;
    lx = x2 + 22;
    ly = y1 - 8;
  } else if (a.row === b.row) {
    // 同一行节点：左右直连或上方弧线连接
    const leftToRight = a.x < b.x;
    const x1 = leftToRight ? a.x + a.w : a.x;
    const y1 = a.y + a.h / 2;
    const x2 = leftToRight ? b.x : b.x + b.w;
    const y2 = b.y + b.h / 2;
    const dist = Math.abs(x2 - x1);
    if (dist <= 64) {
      d = `M ${x1} ${y1} L ${x2} ${y2}`;
      lx = (x1 + x2) / 2;
      ly = y1 - 8;
    } else {
      const arcY = Math.min(a.y, b.y) - 24;
      d = `M ${a.x + a.w / 2} ${a.y} C ${a.x + a.w / 2} ${arcY}, ${b.x + b.w / 2} ${arcY}, ${b.x + b.w / 2} ${b.y}`;
      lx = (a.x + a.w / 2 + b.x + b.w / 2) / 2;
      ly = arcY + 4;
    }
  } else if (b.y > a.y) {
    // 标准自上而下有向边
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const midy = (y1 + y2) / 2;
    d = `M ${x1} ${y1} C ${x1} ${midy}, ${x2} ${midy}, ${x2} ${y2}`;
    const t = 0.44 + ((ei % 3) - 1) * 0.1;
    lx = Math.round(x1 * (1 - t) + x2 * t);
    ly = Math.round(y1 * (1 - t) + y2 * t) - 4;
  } else {
    // 反馈回边（下层指向上层）：走侧翼弧线，避免穿过节点文字
    const goRight = a.x + a.w / 2 >= b.x + b.w / 2;
    const x1 = goRight ? a.x + a.w : a.x;
    const y1 = a.y + a.h / 2;
    const x2 = goRight ? b.x + b.w : b.x;
    const y2 = b.y + b.h / 2;
    const ctrlX = goRight ? Math.max(x1, x2) + 36 : Math.min(x1, x2) - 36;
    d = `M ${x1} ${y1} C ${ctrlX} ${y1}, ${ctrlX} ${y2}, ${x2} ${y2}`;
    lx = Math.round((x1 + x2) / 2 + (goRight ? 24 : -24));
    ly = Math.round((y1 + y2) / 2) + ((ei % 2) ? -8 : 8);
  }

  const dash = e._back ? ' stroke-dasharray="5 4"' : '';
  let lab = '';
  if (e.label) {
    const cleanLab = splitLabelLines(e.label, 18).join(' ');
    const lw = textWidth(cleanLab, 11) + 6;
    lab = `<rect x="${Math.round(lx - lw / 2)}" y="${ly - 11}" width="${lw}" height="15" rx="4" fill="${C.bg}" fill-opacity="0.88"/>`
      + `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="11" fill="${C.accent}" font-family="ui-sans-serif,system-ui,sans-serif">${esc(cleanLab)}</text>`;
  }
  return `<path d="${d}" fill="none" stroke="${C.edge}" stroke-width="1.3"${dash} marker-end="url(#arr)"/>${lab}`;
}

function renderFlow(g) {
  const { boxes, w, h } = layoutFlow(g);
  const edges = g.edges.map((e, i) => edgeSvg(e, boxes, i)).join('');
  const nodes = [...boxes.values()].map(nodeSvg).join('');
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

function mapDotShape(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('diamond')) return 'diamond';
  if (s === 'circle' || s === 'doublecircle' || s === 'point') return 'circle';
  if (s === 'ellipse' || s === 'oval' || s === 'mrecord' || s.includes('round')) return 'round';
  return 'rect';
}

function parseDotAttrs(raw) {
  const o = {};
  if (!raw) return o;
  const re = /([A-Za-z_][\w]*)\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;\]"]+)/g;
  let m;
  while ((m = re.exec(String(raw)))) {
    o[m[1].toLowerCase()] = unquote(m[2]);
  }
  return o;
}

// 切分 DOT 语句：忽略引号与方括号内部的 ; / 换行，并将 subgraph { ... } 展开为内部语句
function splitDotStatements(src) {
  // 剥离 /* ... */ 与 // ... 注释（注意不误伤引号内的 http://）
  let cleaned = '';
  let inQuote = false;
  let quoteCh = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1] || '';
    if (inQuote) {
      cleaned += ch;
      if (ch === '\\' && i + 1 < src.length) {
        cleaned += src[++i];
      } else if (ch === quoteCh) {
        inQuote = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteCh = ch;
      cleaned += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      cleaned += '\n';
      continue;
    }
    cleaned += ch;
  }

  // 将外层 graph/digraph/subgraph 的花括号转化为空格分隔符（方括号和引号内的保留）
  let flat = '';
  let bracketDepth = 0;
  inQuote = false;
  quoteCh = '';
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inQuote) {
      flat += ch;
      if (ch === '\\' && i + 1 < cleaned.length) {
        flat += cleaned[++i];
      } else if (ch === quoteCh) {
        inQuote = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteCh = ch;
      flat += ch;
      continue;
    }
    if (ch === '[') { bracketDepth++; flat += ch; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); flat += ch; continue; }
    if ((ch === '{' || ch === '}') && bracketDepth === 0) {
      flat += '\n';
      continue;
    }
    flat += ch;
  }

  // 按顶层 ; 或 \n 切分语句
  const stmts = [];
  let cur = '';
  bracketDepth = 0;
  inQuote = false;
  quoteCh = '';
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    if (inQuote) {
      cur += ch;
      if (ch === '\\' && i + 1 < flat.length) {
        cur += flat[++i];
      } else if (ch === quoteCh) {
        inQuote = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteCh = ch;
      cur += ch;
      continue;
    }
    if (ch === '[') { bracketDepth++; cur += ch; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); cur += ch; continue; }
    if ((ch === ';' || ch === '\n' || ch === '\r') && bracketDepth === 0) {
      const t = cur.trim();
      if (t) stmts.push(t);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

function parseDot(src) {
  const s = String(src);
  if (!/\b(di)?graph\b/i.test(s)) return null;
  const nodes = new Map();
  const edges = [];
  const ensure = (id, label, shape) => {
    const k = unquote(id).replace(/:.*$/, '').trim();
    if (!k) return null;
    if (!nodes.has(k)) {
      nodes.set(k, { id: k, label: label || k, shape: shape || 'rect' });
    } else {
      if (label) nodes.get(k).label = label;
      if (shape) nodes.get(k).shape = shape;
    }
    return nodes.get(k);
  };

  const stmts = splitDotStatements(s);
  const idPat = `(?:"(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|[A-Za-z0-9_\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff:.-]*)`;
  const attrBlockRe = /\[((?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\]])*)\]/g;

  for (let rawStmt of stmts) {
    let stmt = rawStmt
      .replace(/^(?:strict\s+)?(?:di)?graph\s+(?:"(?:\\.|[^"])*"|[A-Za-z0-9_\u4e00-\u9fff][\w\u4e00-\u9fff-]*)?\s*/i, '')
      .replace(/^subgraph\s+(?:"(?:\\.|[^"])*"|[A-Za-z0-9_\u4e00-\u9fff][\w\u4e00-\u9fff-]*)?\s*/i, '')
      .trim();
    if (!stmt) continue;
    // 跳过全局属性与默认样式声明
    if (/^(graph|node|edge)\s*\[/i.test(stmt)) continue;
    if (/^[A-Za-z_][\w]*\s*=/.test(stmt) && !stmt.includes('->') && !stmt.includes('--') && !stmt.includes('[')) continue;

    // 检查是否包含边操作符（引号/方括号之外的 -> 或 --）
    let hasEdgeOp = false;
    let inQ = false, qCh = '', bDepth = 0;
    for (let i = 0; i < stmt.length - 1; i++) {
      const c = stmt[i];
      if (inQ) {
        if (c === '\\') i++;
        else if (c === qCh) inQ = false;
        continue;
      }
      if (c === '"' || c === "'") { inQ = true; qCh = c; continue; }
      if (c === '[') { bDepth++; continue; }
      if (c === ']') { bDepth = Math.max(0, bDepth - 1); continue; }
      if (bDepth === 0 && ((c === '-' && stmt[i + 1] === '>') || (c === '-' && stmt[i + 1] === '-'))) {
        hasEdgeOp = true;
        break;
      }
    }

    if (hasEdgeOp) {
      // 提取边的属性块（绝不当作节点属性覆盖目标节点 label！）
      let edgeAttrs = {};
      const withoutAttrs = stmt.replace(attrBlockRe, (_, inner) => {
        edgeAttrs = { ...edgeAttrs, ...parseDotAttrs(inner) };
        return ' ';
      });
      const parts = withoutAttrs.split(/\s*(?:->|--)\s*/).map((p) => p.trim()).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        ensure(parts[i]);
        if (i + 1 < parts.length) {
          const fromNode = ensure(parts[i]);
          const toNode = ensure(parts[i + 1]);
          if (fromNode && toNode) {
            edges.push({ from: fromNode.id, to: toNode.id, label: edgeAttrs.label || '' });
          }
        }
      }
      continue;
    }

    // 节点定义语句：NodeID [label="...", shape="..."]
    const nodeMatch = new RegExp(`^(${idPat})\\s*(?:\\[([\\s\\S]*)\\])?$`).exec(stmt);
    if (nodeMatch) {
      const rawId = unquote(nodeMatch[1]);
      if (['graph', 'digraph', 'node', 'edge', 'subgraph', 'strict'].includes(rawId.toLowerCase())) continue;
      let nodeAttrs = {};
      if (nodeMatch[2] != null) {
        stmt.replace(attrBlockRe, (_, inner) => {
          nodeAttrs = { ...nodeAttrs, ...parseDotAttrs(inner) };
          return '';
        });
      }
      const shape = nodeAttrs.shape ? mapDotShape(nodeAttrs.shape) : (nodeAttrs.style && /rounded/i.test(nodeAttrs.style) ? 'round' : undefined);
      ensure(rawId, nodeAttrs.label, shape);
    }
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
