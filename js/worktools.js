// ─── 本地工作台工具：搜文件 / 差分 / JSON / 复制删除 ───────────────────
// 纯函数，浏览器与 Node 都能跑。不碰网关、不执行任意代码。

const MAX_HAY = 400000;
const MAX_HITS = 80;
const MAX_HIT_LEN = 240;
const MAX_DIFF_LINES = 2000;

function clip(s, n) {
  const t = String(s == null ? '' : s);
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

export function searchFiles(fs, { pattern, flags = '', prefix = '' } = {}) {
  if (!pattern) return { ok: false, error: 'pattern 不能为空' };
  let re;
  try { re = new RegExp(pattern, flags || ''); }
  catch (e) { return { ok: false, error: `非法正则：${e.message}` }; }
  const pre = String(prefix || '');
  const hits = [];
  for (const f of fs.list()) {
    if (pre && !f.path.startsWith(pre)) continue;
    let raw;
    try { raw = String(fs.read(f.path)); } catch { continue; }
    if (raw.startsWith('data:')) continue;
    const text = raw.length > MAX_HAY ? raw.slice(0, MAX_HAY) : raw;
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) continue;
    const line = text.slice(0, m.index).split('\n').length;
    hits.push({ path: f.path, line, snippet: clip(text.slice(Math.max(0, m.index - 40), m.index + MAX_HIT_LEN), MAX_HIT_LEN) });
    if (hits.length >= MAX_HITS) break;
  }
  return { ok: true, hits, truncated: hits.length >= MAX_HITS };
}

function lcsBack(A, B) {
  const n = A.length, m = B.length;
  if (n * m > 250000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) { out.push({ t: ' ', s: A[i - 1] }); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { out.push({ t: '-', s: A[i - 1] }); i--; }
    else { out.push({ t: '+', s: B[j - 1] }); j--; }
  }
  while (i > 0) { out.push({ t: '-', s: A[i - 1] }); i--; }
  while (j > 0) { out.push({ t: '+', s: B[j - 1] }); j--; }
  return out.reverse();
}

export function diffText(left, right, { from = 'a', to = 'b' } = {}) {
  const A = String(left == null ? '' : left).split('\n').slice(0, MAX_DIFF_LINES);
  const B = String(right == null ? '' : right).split('\n').slice(0, MAX_DIFF_LINES);
  const ops = lcsBack(A, B);
  const lines = [`--- ${from}`, `+++ ${to}`];
  if (!ops) {
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i++) {
      if (A[i] === B[i]) lines.push(` ${A[i] ?? ''}`);
      else {
        if (i < A.length) lines.push(`-${A[i]}`);
        if (i < B.length) lines.push(`+${B[i]}`);
      }
    }
  } else {
    for (const o of ops) lines.push(`${o.t}${o.s}`);
  }
  const plus = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const minus = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return { ok: true, plus, minus, text: lines.join('\n') };
}

function getPath(obj, path) {
  const parts = String(path || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const k of parts) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

export function jsonTool({ action = 'pretty', text, path } = {}) {
  let data;
  try { data = JSON.parse(String(text == null ? '' : text)); }
  catch (e) { return { ok: false, error: `JSON 解析失败：${e.message}` }; }
  const act = action || 'pretty';
  if (act === 'parse' || act === 'pretty') {
    return { ok: true, text: JSON.stringify(data, null, act === 'parse' ? 0 : 2) };
  }
  if (act === 'keys') {
    const keys = data && typeof data === 'object' ? Object.keys(data) : [];
    return { ok: true, text: keys.join('\n') || '(无键)' };
  }
  if (act === 'get') {
    const v = getPath(data, path);
    return { ok: true, text: v === undefined ? '(路径不存在)' : JSON.stringify(v, null, 2) };
  }
  return { ok: false, error: `未知 action: ${act}` };
}

export function formatSearch(r) {
  if (!r.ok) return r.error;
  if (!r.hits.length) return '没有匹配。';
  const lines = r.hits.map((h) => `${h.path}:${h.line}: ${h.snippet.replace(/\s+/g, ' ')}`);
  return `匹配 ${r.hits.length} 处${r.truncated ? '（已截断）' : ''}\n${lines.join('\n')}`;
}
