// ─── 本地实用工具：CSV / 日期计算 / 文本处理 / 单位换算 / 二维码 ─────────────────
// 全部纯函数、零网络、零沙箱：这些是「不值得开 Pyodide」的小事，但模型经常需要。
// 每个 run* 返回 { ok, text, ... }，由 tools.js 统一包装。

const MAX_TEXT = 2 * 1024 * 1024;

function tooBig(s) { return String(s || '').length > MAX_TEXT; }

/* ───────────────────────── CSV ───────────────────────── */

export function parseCsv(text, { delimiter = ',', header = true } = {}) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const d = delimiter === '\\t' || delimiter === 'tab' ? '\t' : (delimiter || ',').slice(0, 1);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === d) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.length > 1 || (r[0] || '').trim() !== '');
  const columns = header && nonEmpty.length ? nonEmpty[0].map((c, i) => (String(c).trim() || `col${i + 1}`)) : (nonEmpty[0] || []).map((_, i) => `col${i + 1}`);
  const body = header ? nonEmpty.slice(1) : nonEmpty;
  return { columns, rows: body, delimiter: d };
}

export function detectDelimiter(text) {
  const head = String(text || '').split(/\r?\n/).slice(0, 5).join('\n');
  const cands = [',', '\t', ';', '|'];
  let best = ',';
  let score = -1;
  for (const c of cands) {
    const n = head.split(c).length - 1;
    if (n > score) { score = n; best = c; }
  }
  return best;
}

function toCsv(columns, rows, d = ',') {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n\t;|]/.test(s) || s.includes(d) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(d), ...rows.map((r) => r.map(esc).join(d))].join('\n');
}

function toMarkdownTable(columns, rows, limit = 50) {
  const esc = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [`| ${columns.map(esc).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`];
  for (const r of rows.slice(0, limit)) lines.push(`| ${columns.map((_, i) => esc(r[i])).join(' | ')} |`);
  if (rows.length > limit) lines.push(`| … 共 ${rows.length} 行，仅显示前 ${limit} 行 |`);
  return lines.join('\n');
}

function numeric(v) {
  if (v == null) return NaN;
  const s = String(v).trim().replace(/[,，]/g, '').replace(/%$/, '');
  if (!s || !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-6 && n !== 0) ? n.toExponential(6) : String(Math.round(n * 1e6) / 1e6);
}

function colIndex(columns, key) {
  if (key == null || key === '') return -1;
  const k = String(key).trim();
  const byName = columns.findIndex((c) => c === k || c.toLowerCase() === k.toLowerCase());
  if (byName >= 0) return byName;
  if (/^\d+$/.test(k)) { const i = Number(k); if (i >= 0 && i < columns.length) return i; }
  return -1;
}

function parseFilter(expr) {
  const m = /^\s*([^<>=!~]+?)\s*(==|=|!=|>=|<=|>|<|~=|contains|startswith)\s*(.+?)\s*$/i.exec(String(expr || ''));
  if (!m) return null;
  let value = m[3];
  if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
  return { key: m[1].trim(), op: m[2].toLowerCase(), value };
}

function passes(cell, f) {
  const a = cell == null ? '' : String(cell);
  const an = numeric(a); const bn = numeric(f.value);
  const both = Number.isFinite(an) && Number.isFinite(bn);
  switch (f.op) {
    case '=': case '==': return both ? an === bn : a === f.value;
    case '!=': return both ? an !== bn : a !== f.value;
    case '>': return both ? an > bn : a > f.value;
    case '<': return both ? an < bn : a < f.value;
    case '>=': return both ? an >= bn : a >= f.value;
    case '<=': return both ? an <= bn : a <= f.value;
    case '~=': case 'contains': return a.toLowerCase().includes(String(f.value).toLowerCase());
    case 'startswith': return a.toLowerCase().startsWith(String(f.value).toLowerCase());
    default: return false;
  }
}

export function runCsv(args = {}) {
  const action = String(args.action || 'preview').toLowerCase();
  const text = args.text == null ? '' : String(args.text);
  if (tooBig(text)) return { ok: false, error: 'CSV 过大（>2MB），请改用 execute_python' };
  if (!text.trim()) return { ok: false, error: 'text 为空（也可用 path 从沙箱读取）' };
  const delimiter = args.delimiter || detectDelimiter(text);
  const header = args.header !== false;
  const { columns, rows } = parseCsv(text, { delimiter, header });
  if (!columns.length) return { ok: false, error: '没有解析到任何列' };
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));
  const headline = `${rows.length} 行 × ${columns.length} 列（分隔符 ${delimiter === '\t' ? 'TAB' : JSON.stringify(delimiter)}）`;

  if (action === 'preview' || action === 'head') {
    return { ok: true, text: `${headline}\n\n${toMarkdownTable(columns, rows, Math.min(limit, 20))}` };
  }
  if (action === 'stats' || action === 'describe') {
    const lines = [headline, '', '| 列 | 类型 | 非空 | 唯一 | 最小 | 最大 | 均值 | 中位数 |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
    columns.forEach((c, i) => {
      const vals = rows.map((r) => r[i]).filter((v) => v != null && String(v).trim() !== '');
      const nums = vals.map(numeric).filter(Number.isFinite);
      const isNum = vals.length && nums.length >= vals.length * 0.8;
      const uniq = new Set(vals.map(String)).size;
      if (isNum && nums.length) {
        const sorted = [...nums].sort((a, b) => a - b);
        const mean = nums.reduce((s, v) => s + v, 0) / nums.length;
        const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
        lines.push(`| ${c} | 数值 | ${vals.length} | ${uniq} | ${fmtNum(sorted[0])} | ${fmtNum(sorted[sorted.length - 1])} | ${fmtNum(mean)} | ${fmtNum(med)} |`);
      } else {
        const top = [...vals.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map()).entries()].sort((a, b) => b[1] - a[1])[0];
        lines.push(`| ${c} | 文本 | ${vals.length} | ${uniq} | — | — | 最常见：${top ? `${top[0]}（${top[1]}）` : '—'} | — |`);
      }
    });
    return { ok: true, text: lines.join('\n') };
  }
  if (action === 'select' || action === 'filter' || action === 'sort' || action === 'query') {
    let out = rows;
    let cols = columns;
    const filters = [].concat(args.where || args.filter || []).filter(Boolean).map(parseFilter);
    if (filters.some((f) => !f)) return { ok: false, error: 'where 语法：列 运算符 值，例如 "price > 100" / "name contains 张"。运算符：= != > < >= <= contains startswith' };
    for (const f of filters) {
      const i = colIndex(columns, f.key);
      if (i < 0) return { ok: false, error: `找不到列 ${f.key}；可用列：${columns.join(', ')}` };
      out = out.filter((r) => passes(r[i], f));
    }
    if (args.sort) {
      const desc = /^-/.test(String(args.sort)) || String(args.order || '').toLowerCase() === 'desc';
      const i = colIndex(columns, String(args.sort).replace(/^-/, ''));
      if (i < 0) return { ok: false, error: `找不到排序列 ${args.sort}` };
      out = [...out].sort((a, b) => {
        const an = numeric(a[i]); const bn = numeric(b[i]);
        const c = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : String(a[i] ?? '').localeCompare(String(b[i] ?? ''), 'zh');
        return desc ? -c : c;
      });
    }
    let idx = columns.map((_, i) => i);
    if (args.columns && (Array.isArray(args.columns) ? args.columns.length : String(args.columns).trim())) {
      const wanted = Array.isArray(args.columns) ? args.columns : String(args.columns).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      idx = wanted.map((w) => colIndex(columns, w));
      const bad = wanted.filter((_, k) => idx[k] < 0);
      if (bad.length) return { ok: false, error: `找不到列：${bad.join(', ')}；可用列：${columns.join(', ')}` };
      cols = idx.map((i) => columns[i]);
      out = out.map((r) => idx.map((i) => r[i]));
    }
    const shown = out.slice(0, limit);
    const format = String(args.format || 'markdown').toLowerCase();
    const body = format === 'csv' ? toCsv(cols, shown) : format === 'json' ? JSON.stringify(shown.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]]))), null, 2) : toMarkdownTable(cols, shown, limit);
    return { ok: true, text: `匹配 ${out.length} 行${out.length > limit ? `（显示前 ${limit} 行）` : ''}\n\n${body}`, csv: format === 'csv' ? body : null, rows: out.length };
  }
  if (action === 'aggregate' || action === 'group') {
    const by = colIndex(columns, args.by || args.group_by);
    const vi = colIndex(columns, args.value || args.column);
    if (vi < 0) return { ok: false, error: `aggregate 需要 value（数值列）；可用列：${columns.join(', ')}` };
    const fn = String(args.fn || 'sum').toLowerCase();
    const groups = new Map();
    for (const r of rows) {
      const k = by >= 0 ? String(r[by] ?? '') : '全部';
      if (!groups.has(k)) groups.set(k, []);
      const n = numeric(r[vi]);
      if (Number.isFinite(n)) groups.get(k).push(n);
      else if (fn === 'count') groups.get(k).push(NaN);
    }
    const agg = (arr) => {
      const nums = arr.filter(Number.isFinite);
      switch (fn) {
        case 'count': return arr.length;
        case 'avg': case 'mean': return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : NaN;
        case 'min': return nums.length ? Math.min(...nums) : NaN;
        case 'max': return nums.length ? Math.max(...nums) : NaN;
        default: return nums.reduce((s, v) => s + v, 0);
      }
    };
    const outRows = [...groups.entries()].map(([k, arr]) => [k, fmtNum(agg(arr))]).sort((a, b) => numeric(b[1]) - numeric(a[1]));
    return { ok: true, text: `${fn}(${columns[vi]})${by >= 0 ? ` by ${columns[by]}` : ''}：${outRows.length} 组\n\n${toMarkdownTable([by >= 0 ? columns[by] : '组', `${fn}(${columns[vi]})`], outRows, limit)}` };
  }
  if (action === 'to_json') {
    const objs = rows.slice(0, limit).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
    return { ok: true, text: JSON.stringify(objs, null, 2), json: objs };
  }
  if (action === 'to_markdown') return { ok: true, text: toMarkdownTable(columns, rows, limit) };
  return { ok: false, error: `未知 action ${action}；支持 preview / stats / select / aggregate / to_json / to_markdown` };
}

/* ───────────────────────── 日期计算 ───────────────────────── */

const DAY_MS = 86400000;
const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function parseDateInput(input, now = new Date()) {
  if (input == null || input === '' || /^(now|today|今天|现在)$/i.test(String(input).trim())) {
    const d = new Date(now);
    return { date: d, dateOnly: /^(today|今天)$/i.test(String(input || '').trim()) };
  }
  const s = String(input).trim();
  if (/^(tomorrow|明天)$/i.test(s)) return { date: new Date(now.getTime() + DAY_MS), dateOnly: true };
  if (/^(yesterday|昨天)$/i.test(s)) return { date: new Date(now.getTime() - DAY_MS), dateOnly: true };
  if (/^\d{10}$/.test(s)) return { date: new Date(Number(s) * 1000), dateOnly: false };
  if (/^\d{13}$/.test(s)) return { date: new Date(Number(s)), dateOnly: false };
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    if (Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1) return { error: `无效日期 ${s}` };
    return { date: d, dateOnly: !m[4] };
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const d = new Date(now); d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    return { date: d, dateOnly: false };
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { error: `无法识别日期 "${s}"（支持 YYYY-MM-DD、YYYY-MM-DD HH:mm、ISO 8601、时间戳、today/tomorrow）` };
  return { date: d, dateOnly: /^\d{4}-\d{2}-\d{2}$/.test(s) };
}

export function parseDuration(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return null;
  const out = { years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
  const re = /([-+]?\d+(?:\.\d+)?)\s*(years?|yrs?|y|年|months?|mo|个月|月|weeks?|wks?|w|周|星期|days?|d|天|日|hours?|hrs?|h|小时|时|minutes?|mins?|m|分钟|分|seconds?|secs?|s|秒)(?![A-Za-z])/gi;
  let any = false;
  let m;
  while ((m = re.exec(s))) {
    any = true;
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    if (/^(years?|yrs?|y|年)$/.test(u)) out.years += n;
    else if (/^(months?|mo|个月|月)$/.test(u)) out.months += n;
    else if (/^(weeks?|wks?|w|周|星期)$/.test(u)) out.weeks += n;
    else if (/^(days?|d|天|日)$/.test(u)) out.days += n;
    else if (/^(hours?|hrs?|h|小时|时)$/.test(u)) out.hours += n;
    else if (/^(minutes?|mins?|m|分钟|分)$/.test(u)) out.minutes += n;
    else out.seconds += n;
  }
  return any ? out : null;
}

function addDuration(date, dur, sign = 1) {
  const d = new Date(date.getTime());
  if (dur.years || dur.months) {
    const total = d.getMonth() + sign * (dur.years * 12 + dur.months);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(total);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  }
  const ms = sign * ((dur.weeks * 7 + dur.days) * DAY_MS + dur.hours * 3600000 + dur.minutes * 60000 + dur.seconds * 1000);
  return new Date(d.getTime() + ms);
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d, dateOnly) {
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return dateOnly ? `${base}（${WEEKDAYS_ZH[d.getDay()]}）` : `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}（${WEEKDAYS_ZH[d.getDay()]}）`;
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t - yearStart) / DAY_MS + 1) / 7) };
}
function dayOfYear(d) { return Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(d.getFullYear(), 0, 1)) / DAY_MS) + 1; }
function businessDays(a, b) {
  let from = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  let to = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  let sign = 1;
  if (from > to) { [from, to] = [to, from]; sign = -1; }
  let n = 0;
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
    const wd = new Date(t).getDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return sign * n;
}
function humanDiff(ms) {
  const abs = Math.abs(ms);
  const parts = [];
  const units = [['天', DAY_MS], ['小时', 3600000], ['分钟', 60000], ['秒', 1000]];
  let rest = abs;
  for (const [name, size] of units) {
    const v = Math.floor(rest / size);
    if (v) { parts.push(`${v} ${name}`); rest -= v * size; }
  }
  return parts.length ? parts.join(' ') : '0 秒';
}

export function runDateCalc(args = {}, now = new Date()) {
  const action = String(args.action || (args.add || args.subtract ? 'add' : args.to ? 'diff' : 'info')).toLowerCase();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const a = parseDateInput(args.date ?? args.from, now);
  if (a.error) return { ok: false, error: a.error };
  if (action === 'add' || action === 'subtract') {
    const durText = args.add || args.subtract || args.duration || args.amount;
    const dur = parseDuration(durText);
    if (!dur) return { ok: false, error: 'add/subtract 需要时长，例如 "3 days"、"2周"、"1y 2mo"、"90 minutes"' };
    const sign = action === 'subtract' || args.subtract ? -1 : 1;
    const r = addDuration(a.date, dur, sign);
    const dateOnly = a.dateOnly && !dur.hours && !dur.minutes && !dur.seconds;
    return {
      ok: true,
      text: `${fmtDate(a.date, a.dateOnly)} ${sign > 0 ? '+' : '−'} ${String(durText).trim()} = ${fmtDate(r, dateOnly)}\nISO：${r.toISOString()}（时区 ${tz}）`,
      iso: r.toISOString(),
    };
  }
  if (action === 'diff' || action === 'between') {
    const b = parseDateInput(args.to ?? args.end, now);
    if (b.error) return { ok: false, error: b.error };
    const ms = b.date - a.date;
    const days = ms / DAY_MS;
    const months = (b.date.getFullYear() - a.date.getFullYear()) * 12 + (b.date.getMonth() - a.date.getMonth()) - (b.date.getDate() < a.date.getDate() ? 1 : 0);
    const lines = [
      `从 ${fmtDate(a.date, a.dateOnly)} 到 ${fmtDate(b.date, b.dateOnly)}`,
      `相差：${humanDiff(ms)}${ms < 0 ? '（目标早于起点）' : ''}`,
      `= ${fmtNum(days)} 天 = ${fmtNum(days / 7)} 周 ≈ ${Math.trunc(Math.abs(months) / 12)} 年 ${Math.abs(months) % 12} 个月`,
      `工作日（周一至周五，不含节假日）：${businessDays(a.date, b.date)} 天`,
      `总秒数：${Math.round(ms / 1000)}`,
    ];
    return { ok: true, text: lines.join('\n'), ms };
  }
  if (action === 'info' || action === 'format' || action === 'parse') {
    const d = a.date;
    const w = isoWeek(d);
    const q = Math.floor(d.getMonth() / 3) + 1;
    const leap = (d.getFullYear() % 4 === 0 && d.getFullYear() % 100 !== 0) || d.getFullYear() % 400 === 0;
    const lines = [
      `本地：${fmtDate(d, a.dateOnly)}（时区 ${tz}）`,
      `ISO 8601：${d.toISOString()}`,
      `Unix 时间戳：${Math.floor(d.getTime() / 1000)}（毫秒 ${d.getTime()}）`,
      `ISO 周：${w.year}-W${pad(w.week)} · 第 ${dayOfYear(d)} 天 · Q${q} · ${leap ? '闰年' : '平年'}`,
      `当月天数：${new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()} · 距今：${humanDiff(d - now)}${d < now ? '前' : '后'}`,
    ];
    if (args.format) {
      try {
        const loc = args.locale || 'zh-CN';
        lines.push(`格式化（${loc}）：${new Intl.DateTimeFormat(loc, { dateStyle: 'full', timeStyle: a.dateOnly ? undefined : 'medium' }).format(d)}`);
      } catch { /* ignore */ }
    }
    return { ok: true, text: lines.join('\n'), iso: d.toISOString() };
  }
  if (action === 'weekday') return { ok: true, text: `${fmtDate(a.date, true)}` };
  return { ok: false, error: `未知 action ${action}；支持 info / add / subtract / diff / weekday` };
}

/* ───────────────────────── 文本工具 ───────────────────────── */

function wordStats(text) {
  const chars = [...text].length;
  const charsNoSpace = [...text.replace(/\s/g, '')].length;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latinWords = (text.match(/[A-Za-z0-9_'’-]+/g) || []).length;
  const words = cjk + latinWords;
  const lines = text ? text.split(/\r?\n/).length : 0;
  const paragraphs = text.split(/\r?\n\s*\r?\n/).filter((p) => p.trim()).length;
  const sentences = (text.match(/[.!?。！？]+(?:\s|$)/g) || []).length || (text.trim() ? 1 : 0);
  const bytes = new TextEncoder().encode(text).length;
  return { chars, charsNoSpace, cjk, latinWords, words, lines, paragraphs, sentences, bytes, readMin: Math.max(1, Math.round(words / 300)) };
}

function slugify(s) {
  return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
}
const caseFns = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  title: (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase()),
  sentence: (s) => s.toLowerCase().replace(/(^\s*[a-z])|([.!?]\s+[a-z])/g, (m) => m.toUpperCase()),
  camel: (s) => s.trim().split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(''),
  pascal: (s) => s.trim().split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(''),
  snake: (s) => s.trim().split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase()).join('_'),
  kebab: (s) => s.trim().split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase()).join('-'),
  constant: (s) => s.trim().split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((w) => w.toUpperCase()).join('_'),
  slug: slugify,
};

export function runTextTool(args = {}) {
  const action = String(args.action || 'stats').toLowerCase();
  const text = args.text == null ? '' : String(args.text);
  if (tooBig(text)) return { ok: false, error: '文本过大（>2MB）' };
  const lines = text.split(/\r?\n/);
  switch (action) {
    case 'stats': case 'count': {
      const s = wordStats(text);
      return {
        ok: true, stats: s,
        text: `字符 ${s.chars}（不含空白 ${s.charsNoSpace}）· 词 ${s.words}（中日韩字 ${s.cjk} + 拉丁词 ${s.latinWords}）· 句 ${s.sentences} · 行 ${s.lines} · 段 ${s.paragraphs} · UTF-8 ${s.bytes} 字节 · 约 ${s.readMin} 分钟读完`,
      };
    }
    case 'case': {
      const mode = String(args.mode || 'upper').toLowerCase();
      const fn = caseFns[mode];
      if (!fn) return { ok: false, error: `未知 mode ${mode}；支持 ${Object.keys(caseFns).join(' / ')}` };
      return { ok: true, text: fn(text) };
    }
    case 'trim': return { ok: true, text: lines.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/^\s*\n|\n\s*$/g, '') };
    case 'dedupe': case 'unique': {
      const seen = new Set();
      const out = lines.filter((l) => { const k = args.ignore_case ? l.toLowerCase() : l; if (seen.has(k)) return false; seen.add(k); return true; });
      return { ok: true, text: out.join('\n'), removed: lines.length - out.length };
    }
    case 'sort': {
      const desc = String(args.order || '').toLowerCase() === 'desc';
      const num = !!args.numeric;
      const out = [...lines].sort((a, b) => {
        const c = num ? (numeric(a) || 0) - (numeric(b) || 0) : a.localeCompare(b, 'zh', { numeric: true, sensitivity: args.ignore_case ? 'base' : 'variant' });
        return desc ? -c : c;
      });
      return { ok: true, text: out.join('\n') };
    }
    case 'reverse': return { ok: true, text: args.lines ? [...lines].reverse().join('\n') : [...text].reverse().join('') };
    case 'number': return { ok: true, text: lines.map((l, i) => `${String(i + 1).padStart(String(lines.length).length, ' ')}  ${l}`).join('\n') };
    case 'wrap': {
      const width = Math.max(10, Math.min(500, Number(args.width) || 80));
      const out = [];
      for (const para of text.split(/\r?\n/)) {
        let line = '';
        for (const word of para.split(/(\s+)/)) {
          if (/^\s+$/.test(word)) { line += ' '; continue; }
          if ([...line].length + [...word].length > width && line.trim()) { out.push(line.replace(/\s+$/, '')); line = ''; }
          line += word;
        }
        out.push(line.replace(/\s+$/, ''));
      }
      return { ok: true, text: out.join('\n') };
    }
    case 'extract': {
      const what = String(args.what || 'urls').toLowerCase();
      const res = {
        urls: /https?:\/\/[^\s<>"')\]]+/g,
        emails: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
        numbers: /[-+]?\d+(?:[.,]\d+)*(?:e[-+]?\d+)?%?/gi,
        hashtags: /#[\p{L}\p{N}_]+/gu,
        mentions: /@[A-Za-z0-9_]{2,}/g,
        ips: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
        dates: /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\d{4}年\d{1,2}月\d{1,2}日/g,
        phones: /(?:\+?\d{1,3}[-\s]?)?(?:\(?\d{2,4}\)?[-\s]?)?\d{3,4}[-\s]?\d{4}\b/g,
      };
      const re = res[what];
      if (!re) return { ok: false, error: `未知 what ${what}；支持 ${Object.keys(res).join(' / ')}` };
      const found = [...new Set(text.match(re) || [])];
      return { ok: true, text: found.length ? `${found.length} 个 ${what}：\n${found.join('\n')}` : `没有找到 ${what}`, items: found };
    }
    case 'frequency': case 'freq': {
      const top = Math.max(1, Math.min(200, Number(args.top) || 20));
      const tokens = args.by === 'char' ? [...text.replace(/\s/g, '')] : (text.toLowerCase().match(/[a-z0-9_'’-]+|[\u3400-\u9fff]/g) || []);
      const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'that', 'for', 'on', 'with', 'as', 'at', 'by', 'be', '的', '了', '是', '在', '和', '我', '有', '不', '这', '也']);
      const counts = new Map();
      for (const t of tokens) { if (!args.keep_stopwords && stop.has(t)) continue; counts.set(t, (counts.get(t) || 0) + 1); }
      const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([t, n]) => [t, n, `${(100 * n / Math.max(1, tokens.length)).toFixed(1)}%`]);
      return { ok: true, text: `${tokens.length} 个词元，${counts.size} 个唯一\n\n${toMarkdownTable(['词', '次数', '占比'], rows, top)}` };
    }
    case 'replace': {
      if (args.find == null) return { ok: false, error: 'replace 需要 find' };
      let count = 0;
      let out;
      if (args.regex) {
        let re;
        try { re = new RegExp(String(args.find), `g${args.ignore_case ? 'i' : ''}${args.multiline ? 'm' : ''}`); } catch (e) { return { ok: false, error: `正则无效：${e.message}` }; }
        out = text.replace(re, (...m) => { count++; return String(args.replacement ?? '').replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? ''); });
      } else {
        const f = String(args.find);
        const parts = args.ignore_case ? text.split(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) : text.split(f);
        count = parts.length - 1;
        out = parts.join(String(args.replacement ?? ''));
      }
      return { ok: true, text: out, count };
    }
    case 'truncate': {
      const n = Math.max(1, Number(args.length) || 200);
      const arr = [...text];
      return { ok: true, text: arr.length > n ? `${arr.slice(0, n).join('')}…` : text };
    }
    case 'escape': {
      const mode = String(args.mode || 'html').toLowerCase();
      if (mode === 'html') return { ok: true, text: text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
      if (mode === 'json') return { ok: true, text: JSON.stringify(text) };
      if (mode === 'regex') return { ok: true, text: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
      if (mode === 'shell') return { ok: true, text: `'${text.replace(/'/g, `'\\''`)}'` };
      return { ok: false, error: `未知 mode ${mode}；支持 html / json / regex / shell` };
    }
    case 'unescape': {
      const mode = String(args.mode || 'html').toLowerCase();
      if (mode === 'html') return { ok: true, text: text.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' }[k])) };
      if (mode === 'json') { try { return { ok: true, text: String(JSON.parse(text)) }; } catch (e) { return { ok: false, error: `不是合法 JSON 字符串：${e.message}` }; } }
      return { ok: false, error: `未知 mode ${mode}` };
    }
    case 'lorem': {
      const n = Math.max(1, Math.min(50, Number(args.paragraphs) || 1));
      const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat'.split(' ');
      let seed = 7;
      const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      const paras = [];
      for (let p = 0; p < n; p++) {
        const sentences = [];
        for (let s = 0; s < 4 + Math.floor(rnd() * 3); s++) {
          const len = 8 + Math.floor(rnd() * 8);
          const ws = Array.from({ length: len }, () => words[Math.floor(rnd() * words.length)]);
          sentences.push(ws[0][0].toUpperCase() + ws.join(' ').slice(1) + '.');
        }
        paras.push(sentences.join(' '));
      }
      return { ok: true, text: paras.join('\n\n') };
    }
    default:
      return { ok: false, error: `未知 action ${action}；支持 stats / case / trim / dedupe / sort / reverse / number / wrap / extract / frequency / replace / truncate / escape / unescape / lorem` };
  }
}

/* ───────────────────────── 单位换算 ───────────────────────── */

// 每个量纲以 SI 基准单位为 1，value 为换算到基准的倍率；temperature 单独处理。
const UNITS = {
  length: { m: 1, meter: 1, metre: 1, 米: 1, km: 1000, 千米: 1000, 公里: 1000, cm: 0.01, 厘米: 0.01, mm: 0.001, 毫米: 0.001, um: 1e-6, μm: 1e-6, nm: 1e-9, mi: 1609.344, mile: 1609.344, 英里: 1609.344, yd: 0.9144, yard: 0.9144, 码: 0.9144, ft: 0.3048, foot: 0.3048, feet: 0.3048, 英尺: 0.3048, in: 0.0254, inch: 0.0254, 英寸: 0.0254, nmi: 1852, 海里: 1852, 里: 500, 丈: 10 / 3, 尺: 1 / 3, 寸: 1 / 30, ly: 9.4607e15, au: 1.495978707e11 },
  mass: { kg: 1, 千克: 1, 公斤: 1, g: 0.001, 克: 0.001, mg: 1e-6, 毫克: 1e-6, t: 1000, ton: 1000, tonne: 1000, 吨: 1000, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, 磅: 0.45359237, oz: 0.028349523125, ounce: 0.028349523125, 盎司: 0.028349523125, 斤: 0.5, 两: 0.05, st: 6.35029318, stone: 6.35029318 },
  time: { s: 1, sec: 1, second: 1, 秒: 1, ms: 0.001, 毫秒: 0.001, us: 1e-6, μs: 1e-6, ns: 1e-9, min: 60, minute: 60, 分钟: 60, 分: 60, h: 3600, hr: 3600, hour: 3600, 小时: 3600, 时: 3600, d: 86400, day: 86400, 天: 86400, 日: 86400, wk: 604800, week: 604800, 周: 604800, 星期: 604800, mo: 2629746, month: 2629746, 月: 2629746, 个月: 2629746, y: 31556952, yr: 31556952, year: 31556952, 年: 31556952 },
  area: { 'm2': 1, 'm^2': 1, 平方米: 1, 'km2': 1e6, 'km^2': 1e6, 平方千米: 1e6, 平方公里: 1e6, 'cm2': 1e-4, 'cm^2': 1e-4, 'mm2': 1e-6, ha: 1e4, hectare: 1e4, 公顷: 1e4, 亩: 2000 / 3, acre: 4046.8564224, 英亩: 4046.8564224, 'ft2': 0.09290304, 'ft^2': 0.09290304, sqft: 0.09290304, 平方英尺: 0.09290304, 'in2': 0.00064516, 'mi2': 2589988.110336 },
  volume: { l: 0.001, L: 0.001, liter: 0.001, litre: 0.001, 升: 0.001, ml: 1e-6, mL: 1e-6, 毫升: 1e-6, 'm3': 1, 'm^3': 1, 立方米: 1, 'cm3': 1e-6, cc: 1e-6, gal: 0.003785411784, gallon: 0.003785411784, 加仑: 0.003785411784, qt: 0.000946352946, pt: 0.000473176473, cup: 0.0002365882365, 杯: 0.0002365882365, floz: 2.95735295625e-5, 'fl oz': 2.95735295625e-5, tbsp: 1.478676478125e-5, 汤匙: 1.478676478125e-5, tsp: 4.92892159375e-6, 茶匙: 4.92892159375e-6, bbl: 0.158987294928, 桶: 0.158987294928 },
  speed: { 'm/s': 1, mps: 1, 'km/h': 1 / 3.6, kmh: 1 / 3.6, kph: 1 / 3.6, 'mph': 0.44704, 'mi/h': 0.44704, kn: 0.514444, knot: 0.514444, 节: 0.514444, 'ft/s': 0.3048, mach: 340.29, 马赫: 340.29, c: 299792458 },
  data: { b: 0.125, bit: 0.125, B: 1, byte: 1, 字节: 1, kb: 1000, KB: 1000, kib: 1024, KiB: 1024, mb: 1e6, MB: 1e6, mib: 1048576, MiB: 1048576, gb: 1e9, GB: 1e9, gib: 1073741824, GiB: 1073741824, tb: 1e12, TB: 1e12, tib: 1099511627776, TiB: 1099511627776, pb: 1e15, PB: 1e15, pib: 1125899906842624, PiB: 1125899906842624, kbit: 125, mbit: 125000, gbit: 1.25e8, Mbps: 125000, Gbps: 1.25e8, Kbps: 125 },
  energy: { j: 1, J: 1, 焦: 1, 焦耳: 1, kj: 1000, kJ: 1000, cal: 4.184, 卡: 4.184, kcal: 4184, 千卡: 4184, 大卡: 4184, wh: 3600, Wh: 3600, kwh: 3.6e6, kWh: 3.6e6, 度: 3.6e6, 度电: 3.6e6, ev: 1.602176634e-19, eV: 1.602176634e-19, btu: 1055.05585262, BTU: 1055.05585262 },
  power: { w: 1, W: 1, 瓦: 1, kw: 1000, kW: 1000, 千瓦: 1000, mw: 1e6, MW: 1e6, hp: 745.699872, 马力: 745.699872, ps: 735.49875, 'btu/h': 0.29307107 },
  pressure: { pa: 1, Pa: 1, 帕: 1, kpa: 1000, kPa: 1000, mpa: 1e6, MPa: 1e6, bar: 1e5, mbar: 100, hpa: 100, hPa: 100, atm: 101325, 标准大气压: 101325, psi: 6894.757293168, mmhg: 133.322387415, mmHg: 133.322387415, torr: 133.322368421 },
  angle: { rad: 1, 弧度: 1, deg: Math.PI / 180, '°': Math.PI / 180, 度: Math.PI / 180, grad: Math.PI / 200, turn: 2 * Math.PI, 圈: 2 * Math.PI, arcmin: Math.PI / 10800, arcsec: Math.PI / 648000 },
  frequency: { hz: 1, Hz: 1, 赫兹: 1, khz: 1e3, kHz: 1e3, mhz: 1e6, MHz: 1e6, ghz: 1e9, GHz: 1e9, rpm: 1 / 60, bpm: 1 / 60 },
  fuel: { 'l/100km': 1, 'L/100km': 1, 升每百公里: 1 }, // mpg 另算
};
const TEMP = new Set(['c', 'C', '°c', '°C', 'celsius', '摄氏度', 'f', 'F', '°f', '°F', 'fahrenheit', '华氏度', 'k', 'K', 'kelvin', '开尔文']);

function normUnit(u) { return String(u == null ? '' : u).trim().replace(/\s+/g, ' ').replace(/^per\s+/i, '/'); }
function findUnit(u) {
  const key = normUnit(u);
  if (!key) return null;
  for (const [dim, table] of Object.entries(UNITS)) {
    if (Object.prototype.hasOwnProperty.call(table, key)) return { dim, factor: table[key], key };
  }
  const lower = key.toLowerCase();
  for (const [dim, table] of Object.entries(UNITS)) {
    const hit = Object.keys(table).find((k) => k.toLowerCase() === lower || `${k.toLowerCase()}s` === lower);
    if (hit) return { dim, factor: table[hit], key: hit };
  }
  return null;
}
function tempTo(value, unit) {
  const u = unit.toLowerCase().replace('°', '');
  if (u.startsWith('c') || u === '摄氏度') return value + 273.15;
  if (u.startsWith('f') || u === '华氏度') return (value - 32) * 5 / 9 + 273.15;
  return value;
}
function tempFrom(k, unit) {
  const u = unit.toLowerCase().replace('°', '');
  if (u.startsWith('c') || u === '摄氏度') return k - 273.15;
  if (u.startsWith('f') || u === '华氏度') return (k - 273.15) * 9 / 5 + 32;
  return k;
}

export function runConvertUnits(args = {}) {
  let value = args.value;
  let from = args.from;
  let to = args.to;
  if ((value == null || from == null) && args.text) {
    const m = /^\s*([-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?)\s*([^\s]+(?: [^\s]+)?)\s+(?:to|in|->|→|=|转|换成|换算成|到)\s+([^\s]+(?: [^\s]+)?)\s*$/i.exec(String(args.text));
    if (!m) return { ok: false, error: '无法解析，示例："5 km to mi"、"72 F to C"、"3 斤 to kg"' };
    value = m[1].replace(',', '.'); from = m[2]; to = m[3];
  }
  const v = Number(value);
  if (!Number.isFinite(v)) return { ok: false, error: 'value 必须是数字' };
  from = normUnit(from); to = normUnit(to);
  if (!from || !to) return { ok: false, error: '需要 from 与 to 两个单位' };
  // 温度
  if (TEMP.has(from) && TEMP.has(to)) {
    const r = tempFrom(tempTo(v, from), to);
    return { ok: true, value: r, text: `${fmtNum(v)} ${from} = ${fmtNum(r)} ${to}` };
  }
  // 油耗 mpg ↔ L/100km
  const mpgRe = /^(mpg|英里每加仑)$/i; const l100 = /^(l\/100km|升每百公里)$/i;
  if (mpgRe.test(from) && l100.test(to)) { const r = 235.214583 / v; return { ok: true, value: r, text: `${fmtNum(v)} mpg(US) = ${fmtNum(r)} L/100km` }; }
  if (l100.test(from) && mpgRe.test(to)) { const r = 235.214583 / v; return { ok: true, value: r, text: `${fmtNum(v)} L/100km = ${fmtNum(r)} mpg(US)` }; }
  const a = findUnit(from); const b = findUnit(to);
  if (!a) return { ok: false, error: `不认识单位 "${from}"。支持量纲：${Object.keys(UNITS).join(' / ')} / temperature` };
  if (!b) return { ok: false, error: `不认识单位 "${to}"。支持量纲：${Object.keys(UNITS).join(' / ')} / temperature` };
  if (a.dim !== b.dim) return { ok: false, error: `量纲不同：${from} 是 ${a.dim}，${to} 是 ${b.dim}` };
  const r = v * a.factor / b.factor;
  const precision = Math.max(0, Math.min(12, Number(args.precision) || 6));
  const shown = Math.abs(r) >= 1e15 || (Math.abs(r) < 1e-6 && r !== 0) ? r.toExponential(precision) : String(Number(r.toFixed(precision)));
  return { ok: true, value: r, dimension: a.dim, text: `${fmtNum(v)} ${a.key} = ${shown} ${b.key}（${a.dim}）` };
}

/* ───────────────────────── 二维码（纯 JS 编码器，Byte 模式，EC=M/L/Q/H，版本 1–20） ───────────────────────── */

const EC_LEVELS = { L: 1, M: 0, Q: 3, H: 2 };
// [version] -> { L:[ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data], M:..., Q:..., H:... }
const EC_TABLE = [
  null,
  { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
  { L: [20, 4, 81, 0, 0], M: [30, 1, 50, 4, 51], Q: [28, 4, 22, 4, 23], H: [24, 3, 12, 8, 13] },
  { L: [24, 2, 92, 2, 93], M: [22, 6, 36, 2, 37], Q: [26, 4, 20, 6, 21], H: [28, 7, 14, 4, 15] },
  { L: [26, 4, 107, 0, 0], M: [22, 8, 37, 1, 38], Q: [24, 8, 20, 4, 21], H: [22, 12, 11, 4, 12] },
  { L: [30, 3, 115, 1, 116], M: [24, 4, 40, 5, 41], Q: [20, 11, 16, 5, 17], H: [24, 11, 12, 5, 13] },
  { L: [22, 5, 87, 1, 88], M: [24, 5, 41, 5, 42], Q: [30, 5, 24, 7, 25], H: [24, 11, 12, 7, 13] },
  { L: [24, 5, 98, 1, 99], M: [28, 7, 45, 3, 46], Q: [24, 15, 19, 2, 20], H: [30, 3, 15, 13, 16] },
  { L: [28, 1, 107, 5, 108], M: [28, 10, 46, 1, 47], Q: [28, 1, 22, 15, 23], H: [28, 2, 14, 17, 15] },
  { L: [30, 5, 120, 1, 121], M: [26, 9, 43, 4, 44], Q: [28, 17, 22, 1, 23], H: [28, 2, 14, 19, 15] },
  { L: [28, 3, 113, 4, 114], M: [26, 3, 44, 11, 45], Q: [26, 17, 21, 4, 22], H: [26, 9, 13, 16, 14] },
  { L: [28, 3, 107, 5, 108], M: [26, 3, 41, 13, 42], Q: [30, 15, 24, 5, 25], H: [28, 15, 15, 10, 16] },
];
const ALIGN_POS = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);
function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= gfMul(g[j], GF_EXP[i]); }
    g = next;
  }
  return g;
}
function rsEncode(data, n) {
  const gen = rsGenerator(n);
  const res = new Array(n).fill(0);
  for (const b of data) {
    const factor = b ^ res.shift();
    res.push(0);
    if (factor) for (let j = 0; j < n; j++) res[j] ^= gfMul(gen[j + 1], factor);
  }
  return res;
}

function dataCapacity(version, ec) {
  const [ecc, g1, d1, g2, d2] = EC_TABLE[version][ec];
  return g1 * d1 + g2 * d2;
}

export function encodeQrMatrix(text, { ecLevel = 'M', minVersion = 1 } = {}) {
  const ec = String(ecLevel || 'M').toUpperCase();
  if (!(ec in EC_LEVELS)) throw new Error('ec 只能是 L / M / Q / H');
  const bytes = new TextEncoder().encode(String(text == null ? '' : text));
  if (!bytes.length) throw new Error('内容为空');
  let version = 0;
  for (let v = Math.max(1, minVersion | 0); v <= 20; v++) {
    const bits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= dataCapacity(v, ec) * 8) { version = v; break; }
  }
  if (!version) throw new Error(`内容过长（${bytes.length} 字节），EC=${ec} 下最多约 ${dataCapacity(20, ec) - 3} 字节`);
  const size = version * 4 + 17;
  const [ecc, g1, d1, g2, d2] = EC_TABLE[version][ec];
  const totalData = g1 * d1 + g2 * d2;
  // ── 位流：模式(0100) + 长度 + 数据 + 终止 + 补齐
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, totalData * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < totalData; pad ^= 0xec ^ 0x11) data.push(pad);
  // ── 分块 + RS + 交织
  const blocks = [];
  let off = 0;
  for (let i = 0; i < g1 + g2; i++) {
    const len = i < g1 ? d1 : d2;
    const chunk = data.slice(off, off + len); off += len;
    blocks.push({ data: chunk, ec: rsEncode(chunk, ecc) });
  }
  const out = [];
  const maxD = Math.max(d1, d2);
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecc; i++) for (const b of blocks) out.push(b.ec[i]);
  // ── 矩阵与功能图形
  const m = Array.from({ length: size }, () => new Array(size).fill(null)); // null = 未定（数据区）
  const set = (r, c, v) => { if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = v ? 1 : 0; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const on = (r >= 0 && r <= 6 && c >= 0 && c <= 6) && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(r0 + r, c0 + c, on);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const ap = ALIGN_POS[version];
  for (const r of ap) for (const c of ap) {
    // 只避开三个寻像图形（定位图形允许与定时图形重叠）
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // 预留格式信息位
  for (let i = 0; i < 8; i++) { set(8, i < 6 ? i : i + 1, 0); set(i < 6 ? i : i + 1, 8, 0); set(8, size - 1 - i, 0); set(size - 1 - i, 8, 0); }
  set(8, 8, 0); set(size - 8, 8, 1); // dark module
  if (version >= 7) {
    const vinfo = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vinfo >> i) & 1;
      set(Math.floor(i / 3), size - 11 + (i % 3), bit);
      set(size - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }
  // ── 数据放置（蛇形）
  const isFunc = m.map((row) => row.map((v) => v !== null));
  let bitIdx = 0;
  const totalBits = out.length * 8;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let k = 0; k < size; k++) {
      const r = up ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (isFunc[r][c]) continue;
        const bit = bitIdx < totalBits ? (out[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1 : 0;
        m[r][c] = bit; bitIdx++;
      }
    }
    up = !up;
  }
  // ── 掩码选择
  const MASKS = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const cand = m.map((row, r) => row.map((v, c) => (isFunc[r][c] ? v : v ^ (MASKS[mask](r, c) ? 1 : 0))));
    writeFormat(cand, size, EC_LEVELS[ec], mask);
    const pen = penalty(cand, size);
    if (!best || pen < best.pen) best = { pen, mask, matrix: cand };
  }
  return { matrix: best.matrix, size, version, ecLevel: ec, mask: best.mask, bytes: bytes.length };
}

function bchFormat(data) {
  let v = data << 10;
  for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= 0x537 << (i - 10);
  return ((data << 10) | v) ^ 0x5412;
}
function versionBits(version) {
  let v = version << 12;
  for (let i = 17; i >= 12; i--) if ((v >> i) & 1) v ^= 0x1f25 << (i - 12);
  return (version << 12) | v;
}
function writeFormat(m, size, ecBits, mask) {
  const f = bchFormat((ecBits << 3) | mask);
  const bit = (i) => (f >> i) & 1;
  // 第一份：左上角绕行；第二份：右上横排 + 左下竖排（ISO 18004 图 25）
  for (let i = 0; i < 6; i++) { m[8][i] = bit(14 - i); m[i][8] = bit(i); }
  m[8][7] = bit(8); m[8][8] = bit(7); m[7][8] = bit(6);
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
  for (let i = 0; i < 7; i++) m[size - 1 - i][8] = bit(14 - i);
  m[size - 8][8] = 1;
}
function penalty(m, size) {
  let score = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        const cur = j < size ? (pass ? m[j][i] : m[i][j]) : -1;
        const prev = pass ? m[j - 1][i] : m[i][j - 1];
        if (cur === prev) run++; else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
    }
  }
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c]; if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]; const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r++) for (let c = 0; c <= size - 11; c++) {
    let a = true, b = true, a2 = true, b2 = true;
    for (let k = 0; k < 11; k++) {
      if (m[r][c + k] !== pat1[k]) a = false; if (m[r][c + k] !== pat2[k]) b = false;
      if (m[c + k][r] !== pat1[k]) a2 = false; if (m[c + k][r] !== pat2[k]) b2 = false;
    }
    score += (a ? 40 : 0) + (b ? 40 : 0) + (a2 ? 40 : 0) + (b2 ? 40 : 0);
  }
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

export function qrToSvg(matrix, { module = 8, margin = 4, fg = '#0a0a0a', bg = '#ffffff' } = {}) {
  const size = matrix.length;
  const total = (size + margin * 2) * module;
  let d = '';
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!matrix[r][c]) { c++; continue; }
      let w = 1;
      while (c + w < size && matrix[r][c + w]) w++;
      d += `M${(c + margin) * module} ${(r + margin) * module}h${w * module}v${module}h${-w * module}z`;
      c += w;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${bg}"/><path d="${d}" fill="${fg}"/></svg>`;
}

export function qrToAscii(matrix) {
  const size = matrix.length;
  const lines = [];
  for (let r = 0; r < size; r += 2) {
    let line = '';
    for (let c = 0; c < size; c++) {
      const top = matrix[r][c]; const bot = r + 1 < size ? matrix[r + 1][c] : 0;
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function runQrCode(args = {}) {
  const text = args.text == null ? '' : String(args.text);
  if (!text) return { ok: false, error: 'text 不能为空' };
  if (text.length > 2000) return { ok: false, error: '内容过长（>2000 字符）' };
  try {
    const q = encodeQrMatrix(text, { ecLevel: args.ec || 'M' });
    const svg = qrToSvg(q.matrix, { module: Math.max(2, Math.min(32, Number(args.module) || 8)), fg: /^#[0-9a-f]{3,8}$/i.test(args.fg || '') ? args.fg : '#0a0a0a', bg: /^#[0-9a-f]{3,8}$/i.test(args.bg || '') ? args.bg : '#ffffff' });
    return { ok: true, svg, size: q.size, version: q.version, ecLevel: q.ecLevel, mask: q.mask, bytes: q.bytes, ascii: args.ascii ? qrToAscii(q.matrix) : '' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
