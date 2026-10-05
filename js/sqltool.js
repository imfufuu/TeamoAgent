// ─── 会话内 SQLite 方言（纯 JS，不执行任意代码）────────────────────────
// CREATE / DROP / INSERT / SELECT / UPDATE / DELETE；WHERE / ORDER / LIMIT / GROUP BY / 聚合。
// 库文件以 JSON 落在沙箱（默认 data/app.db）。不做 JOIN / 子查询。

const MAX_SQL = 80000;
const MAX_ROWS_OUT = 500;

function tok(sql) {
  const s = String(sql || '');
  const out = [];
  let i = 0;
  const push = (kind, value, raw) => out.push({ kind, value, raw: raw != null ? raw : value });
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '\'' || c === '"') {
      const q = c;
      i += 1;
      let t = '';
      while (i < s.length) {
        if (s[i] === q && s[i + 1] === q) { t += q; i += 2; continue; }
        if (s[i] === q) { i += 1; break; }
        t += s[i]; i += 1;
      }
      push(q === '"' ? 'ident' : 'string', t);
      continue;
    }
    if (/[0-9.]/.test(c) && !(c === '.' && !/[0-9]/.test(s[i + 1] || ''))) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
      if (m) { push('number', Number(m[0]), m[0]); i += m[0].length; continue; }
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      const raw = m[0];
      const up = raw.toUpperCase();
      push('ident', up === raw || KEY.has(up) ? up : raw, raw);
      i += raw.length;
      continue;
    }
    if ('(),*;=<>!'.includes(c)) {
      if ((c === '<' || c === '>' || c === '!' || c === '=') && s[i + 1] === '=') {
        push('op', c + '=', c + '='); i += 2; continue;
      }
      if (c === '<' && s[i + 1] === '>') { push('op', '<>', '<>'); i += 2; continue; }
      push(c === '*' ? 'star' : 'op', c, c);
      i += 1;
      continue;
    }
    throw new Error(`无法识别的字符「${c}」`);
  }
  push('eof', '');
  return out;
}

const KEY = new Set('SELECT FROM WHERE INSERT INTO VALUES CREATE TABLE DROP UPDATE SET DELETE AND OR NOT NULL LIKE IN IS AS ORDER BY LIMIT GROUP HAVING IF EXISTS PRIMARY KEY INTEGER INT TEXT REAL BLOB DEFAULT DISTINCT COUNT SUM AVG MIN MAX ASC DESC'.split(' '));

function identName(t) {
  if (!t || (t.kind !== 'ident' && t.kind !== 'star')) return '';
  return String(t.raw || t.value);
}

export function emptyDb() {
  return { v: 1, kind: 'teamo-sql', tables: {} };
}

export function parseDb(raw) {
  if (raw == null || raw === '') return emptyDb();
  const s = String(raw);
  if (/^data:/i.test(s)) throw new Error('这是二进制库文件，当前引擎读写 JSON 格式的 data/app.db');
  let obj;
  try { obj = JSON.parse(s); } catch { throw new Error('库文件不是 JSON，无法打开'); }
  if (!obj || obj.kind !== 'teamo-sql' || !obj.tables || typeof obj.tables !== 'object') {
    throw new Error('库文件格式不对（需要 Dubhe Agent SQL JSON）');
  }
  return obj;
}

function serialize(db) {
  return JSON.stringify({ v: 1, kind: 'teamo-sql', tables: db.tables });
}

function colOf(table, name) {
  const n = String(name);
  const i = table.cols.findIndex((c) => c.name.toLowerCase() === n.toLowerCase());
  return i;
}

function truthy(v) {
  return !(v == null || v === 0 || v === '' || v === false);
}

function likeToRe(pat) {
  let s = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '%') s += '.*';
    else if (c === '_') s += '.';
    else s += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`, 'i');
}

function cmp(op, a, b) {
  if (op === 'IS') return a == null && b == null;
  if (a == null || b == null) return false;
  if (op === '=' || op === '==') return a == b; // eslint-disable-line eqeqeq
  if (op === '!=' || op === '<>') return a != b; // eslint-disable-line eqeqeq
  if (op === '<') return a < b;
  if (op === '>') return a > b;
  if (op === '<=') return a <= b;
  if (op === '>=') return a >= b;
  return false;
}

function makeParser(tokens) {
  let i = 0;
  const peek = () => tokens[i] || tokens[tokens.length - 1];
  const eat = (kind, value) => {
    const t = peek();
    if (kind && t.kind !== kind && !(kind === 'ident' && t.kind === 'star')) return null;
    if (value != null && String(t.value).toUpperCase() !== String(value).toUpperCase()) return null;
    i += 1;
    return t;
  };
  const need = (kind, value) => {
    const t = eat(kind, value);
    if (!t) throw new Error(`期望 ${value || kind}，遇到 ${peek().raw || peek().kind}`);
    return t;
  };
  const kw = (w) => eat('ident', w);
  return { peek, eat, need, kw, pos: () => i, set: (p) => { i = p; } };
}

function parseValue(p) {
  if (p.kw('NULL')) return null;
  const s = p.eat('string');
  if (s) return s.value;
  const n = p.eat('number');
  if (n) return n.value;
  const id = p.eat('ident');
  if (id) return identName(id);
  throw new Error('期望字面量');
}

function parseExpr(p, table, row) {
  function parseOr() {
    let v = parseAnd();
    while (p.kw('OR')) v = truthy(v) || truthy(parseAnd());
    return v;
  }
  function parseAnd() {
    let v = parseNot();
    while (p.kw('AND')) v = truthy(v) && truthy(parseNot());
    return v;
  }
  function parseNot() {
    if (p.kw('NOT')) return !truthy(parseNot());
    return parseCmp();
  }
  function atom() {
    if (p.eat('op', '(')) {
      const v = parseOr();
      p.need('op', ')');
      return v;
    }
    if (p.kw('NULL')) return null;
    const s = p.eat('string'); if (s) return s.value;
    const n = p.eat('number'); if (n) return n.value;
    const star = p.eat('star'); if (star) return row;
    const id = p.need('ident');
    const name = identName(id);
    if (p.eat('op', '(')) {
      const args = [];
      if (!p.eat('op', ')')) {
        for (;;) {
          if (p.eat('star')) args.push('*');
          else args.push(parseOr());
          if (p.eat('op', ',')) continue;
          p.need('op', ')');
          break;
        }
      }
      return aggOne(name, args, table, row);
    }
    const idx = colOf(table, name);
    if (idx < 0) throw new Error(`未知列 ${name}`);
    return row[idx];
  }
  function parseCmp() {
    const left = atom();
    if (p.kw('IS')) {
      const neg = !!p.kw('NOT');
      p.kw('NULL');
      const v = left == null;
      return neg ? !v : v;
    }
    if (p.kw('LIKE')) {
      const pat = parseValue(p);
      return likeToRe(String(pat)).test(String(left == null ? '' : left));
    }
    if (p.kw('IN')) {
      p.need('op', '(');
      const set = [];
      for (;;) {
        set.push(parseValue(p));
        if (p.eat('op', ',')) continue;
        p.need('op', ')');
        break;
      }
      return set.some((x) => x == left); // eslint-disable-line eqeqeq
    }
    const op = p.eat('op');
    if (op && ['=', '==', '!=', '<>', '<', '>', '<=', '>='].includes(op.value)) {
      const right = atom();
      return cmp(op.value, left, right);
    }
    if (op) throw new Error(`不支持的运算符 ${op.value}`);
    return left;
  }
  return parseOr();
}

function aggOne(name, args, table, row) {
  const n = name.toUpperCase();
  if (n === 'COUNT' && args[0] === '*') return 1;
  const v = args[0];
  if (n === 'COUNT') return v == null ? 0 : 1;
  return v;
}

function parseSelectList(p) {
  const cols = [];
  const AGG = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
  for (;;) {
    if (p.eat('star')) cols.push({ star: true, name: '*' });
    else if (p.peek().kind === 'ident' && AGG.has(String(p.peek().value).toUpperCase())) {
      const fn = String(p.peek().value).toUpperCase();
      p.eat('ident');
      p.need('op', '(');
      let src = '*';
      if (!p.eat('star')) src = identName(p.need('ident'));
      p.need('op', ')');
      let name = fn;
      if (p.kw('AS')) name = identName(p.need('ident'));
      cols.push({ name, fn, src });
    } else {
      const src = identName(p.need('ident'));
      let name = src;
      if (p.kw('AS')) name = identName(p.need('ident'));
      cols.push({ name, src, fn: '' });
    }
    if (p.eat('op', ',')) continue;
    break;
  }
  return cols;
}

function takeWhere(p) {
  if (!p.kw('WHERE')) return null;
  const toks = [];
  let depth = 0;
  while (p.peek().kind !== 'eof') {
    const t = p.peek();
    if (t.kind === 'ident' && !depth && ['ORDER', 'GROUP', 'LIMIT', 'HAVING'].includes(String(t.value).toUpperCase())) break;
    if (t.value === '(') depth += 1;
    if (t.value === ')') depth -= 1;
    toks.push(t);
    p.eat(t.kind);
  }
  return toks;
}

function whereRows(table, whereToks) {
  if (!whereToks) return table.rows.slice();
  return table.rows.filter((row) => {
    try { return !!evalWhere(table, row, whereToks); } catch { return false; }
  });
}

function evalWhere(table, row, tokens) {
  const p = makeParser(tokens.concat([{ kind: 'eof', value: '', raw: '' }]));
  return parseExpr(p, table, row);
}

function attachTokens(p, tokens) {
  p._all = tokens;
}

function orderRows(rows, table, p) {
  if (!p.kw('ORDER')) return rows;
  p.kw('BY');
  const keys = [];
  for (;;) {
    const name = identName(p.need('ident'));
    const dir = p.kw('DESC') ? -1 : 1;
    p.kw('ASC');
    keys.push({ name, dir });
    if (p.eat('op', ',')) continue;
    break;
  }
  return rows.slice().sort((a, b) => {
    for (const k of keys) {
      const i = colOf(table, k.name);
      const av = i < 0 ? null : a[i];
      const bv = i < 0 ? null : b[i];
      if (av == bv) continue; // eslint-disable-line eqeqeq
      if (av == null) return -1 * k.dir;
      if (bv == null) return 1 * k.dir;
      return (av > bv ? 1 : -1) * k.dir;
    }
    return 0;
  });
}

function limitRows(rows, p) {
  if (!p.kw('LIMIT')) return rows;
  const n = p.need('number').value;
  return rows.slice(0, Math.max(0, Number(n) || 0));
}

function runSelect(p, db) {
  p.kw('DISTINCT');
  const list = parseSelectList(p);
  p.need('ident', 'FROM');
  const tname = identName(p.need('ident'));
  const table = db.tables[tname.toLowerCase()];
  if (!table) throw new Error(`表不存在：${tname}`);
  const whereToks = takeWhere(p);
  let rows = whereRows(table, whereToks);
  let outCols = list;
  if (list.length === 1 && list[0].star) {
    outCols = table.cols.map((c) => ({ name: c.name, src: c.name, fn: '' }));
  }
  const grouped = p.kw('GROUP');
  let resultRows;
  let headers = outCols.map((c) => c.name || c.src || '*');
  if (grouped) {
    p.kw('BY');
    const gcols = [];
    for (;;) {
      gcols.push(identName(p.need('ident')));
      if (p.eat('op', ',')) continue;
      break;
    }
    const buckets = new Map();
    for (const row of rows) {
      const key = gcols.map((n) => row[colOf(table, n)]).join('\0');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    resultRows = [];
    for (const group of buckets.values()) resultRows.push(outCols.map((c) => projectCol(c, table, group)));
  } else {
    const hasAgg = outCols.some((c) => c.fn);
    if (hasAgg) {
      resultRows = rows.length
        ? [outCols.map((c) => projectCol(c, table, rows))]
        : [outCols.map((c) => (c.fn === 'COUNT' ? 0 : null))];
    } else {
      rows = orderRows(rows, table, p);
      rows = limitRows(rows, p);
      resultRows = rows.map((row) => outCols.map((c) => {
        const idx = colOf(table, c.src || c.name);
        return idx < 0 ? null : row[idx];
      }));
      return { headers, rows: resultRows };
    }
  }
  const fake = { cols: headers.map((n) => ({ name: n })), rows: resultRows };
  let ordered = orderRows(fake.rows, fake, p);
  ordered = limitRows(ordered, p);
  return { headers, rows: ordered };
}

function projectCol(c, table, group) {
  const fn = (c.fn || '').toUpperCase();
  if (fn === 'COUNT') return group.length;
  const idx = colOf(table, c.src || c.name);
  const vals = group.map((r) => (idx < 0 ? null : r[idx])).filter((v) => v != null);
  if (fn === 'SUM') return vals.reduce((a, b) => a + Number(b), 0);
  if (fn === 'AVG') return vals.length ? vals.reduce((a, b) => a + Number(b), 0) / vals.length : null;
  if (fn === 'MIN') return vals.length ? vals.reduce((a, b) => (a < b ? a : b)) : null;
  if (fn === 'MAX') return vals.length ? vals.reduce((a, b) => (a > b ? a : b)) : null;
  const i = colOf(table, c.src || c.name);
  return i < 0 ? null : group[0][i];
}

function runInsert(p, db) {
  p.need('ident', 'INTO');
  const tname = identName(p.need('ident'));
  const table = db.tables[tname.toLowerCase()];
  if (!table) throw new Error(`表不存在：${tname}`);
  let cols = table.cols.map((c) => c.name);
  if (p.eat('op', '(')) {
    cols = [];
    for (;;) {
      cols.push(identName(p.need('ident')));
      if (p.eat('op', ',')) continue;
      p.need('op', ')');
      break;
    }
  }
  p.need('ident', 'VALUES');
  let n = 0;
  for (;;) {
    p.need('op', '(');
    const vals = [];
    for (;;) {
      vals.push(p.kw('NULL') ? null : (p.eat('string') || p.need('number')).value);
      if (p.eat('op', ',')) continue;
      p.need('op', ')');
      break;
    }
    const row = table.cols.map(() => null);
    cols.forEach((name, i) => {
      const idx = colOf(table, name);
      if (idx < 0) throw new Error(`未知列 ${name}`);
      row[idx] = vals[i] === undefined ? null : vals[i];
    });
    table.rows.push(row);
    n += 1;
    if (p.eat('op', ',')) continue;
    break;
  }
  return { message: `已插入 ${n} 行 → ${tname}` };
}

function runCreate(p, db) {
  p.need('ident', 'TABLE');
  const ifNot = !!(p.kw('IF') && p.kw('NOT') && p.kw('EXISTS'));
  const tname = identName(p.need('ident'));
  const key = tname.toLowerCase();
  if (db.tables[key]) {
    if (ifNot) return { message: `表已存在：${tname}` };
    throw new Error(`表已存在：${tname}`);
  }
  p.need('op', '(');
  const cols = [];
  for (;;) {
    const name = identName(p.need('ident'));
    const typTok = p.eat('ident');
    const type = typTok ? String(typTok.value).toUpperCase() : 'TEXT';
    while (p.kw('PRIMARY') || p.kw('KEY') || p.kw('NOT') || p.kw('NULL') || p.kw('DEFAULT')) {
      if (p.peek().kind === 'number' || p.peek().kind === 'string') p.eat(p.peek().kind);
    }
    cols.push({ name, type });
    if (p.eat('op', ',')) continue;
    p.need('op', ')');
    break;
  }
  db.tables[key] = { name: tname, cols, rows: [] };
  return { message: `已创建表 ${tname}（${cols.map((c) => c.name).join(', ')}）` };
}

function runDrop(p, db) {
  p.need('ident', 'TABLE');
  const ifEx = !!(p.kw('IF') && p.kw('EXISTS'));
  const tname = identName(p.need('ident'));
  const key = tname.toLowerCase();
  if (!db.tables[key]) {
    if (ifEx) return { message: `表不存在：${tname}` };
    throw new Error(`表不存在：${tname}`);
  }
  delete db.tables[key];
  return { message: `已删除表 ${tname}` };
}

function runUpdate(p, db) {
  const tname = identName(p.need('ident'));
  const table = db.tables[tname.toLowerCase()];
  if (!table) throw new Error(`表不存在：${tname}`);
  p.need('ident', 'SET');
  const sets = [];
  for (;;) {
    const col = identName(p.need('ident'));
    p.need('op', '=');
    const val = p.kw('NULL') ? null : (p.eat('string') || p.need('number')).value;
    sets.push({ col, val });
    if (p.eat('op', ',')) continue;
    break;
  }
  const rows = whereRows(table, takeWhere(p));
  for (const row of rows) {
    for (const s of sets) {
      const idx = colOf(table, s.col);
      if (idx < 0) throw new Error(`未知列 ${s.col}`);
      row[idx] = s.val;
    }
  }
  return { message: `已更新 ${rows.length} 行 → ${tname}` };
}

function runDelete(p, db) {
  p.need('ident', 'FROM');
  const tname = identName(p.need('ident'));
  const table = db.tables[tname.toLowerCase()];
  if (!table) throw new Error(`表不存在：${tname}`);
  const whereToks = takeWhere(p);
  if (!whereToks) {
    const n = table.rows.length;
    table.rows = [];
    return { message: `已删除 ${n} 行 → ${tname}` };
  }
  const doomed = new Set(whereRows(table, whereToks));
  const keep = table.rows.filter((row) => !doomed.has(row));
  const n = table.rows.length - keep.length;
  table.rows = keep;
  return { message: `已删除 ${n} 行 → ${tname}` };
}

function splitStatements(sql) {
  const tokens = tok(sql);
  const stmts = [];
  let cur = [];
  for (const t of tokens) {
    if (t.kind === 'eof') {
      if (cur.length) stmts.push(cur.concat([{ kind: 'eof', value: '', raw: '' }]));
      break;
    }
    if (t.kind === 'op' && t.value === ';') {
      if (cur.length) stmts.push(cur.concat([{ kind: 'eof', value: '', raw: '' }]));
      cur = [];
      continue;
    }
    cur.push(t);
  }
  return stmts;
}

export function runSql(sql, rawDb) {
  const src = String(sql == null ? '' : sql).trim();
  if (!src) return { ok: false, error: 'sql 不能为空' };
  if (src.length > MAX_SQL) return { ok: false, error: `SQL 过长（>${MAX_SQL}）` };
  let db;
  try { db = parseDb(rawDb); } catch (err) { return { ok: false, error: err.message }; }
  const logs = [];
  let lastSelect = null;
  try {
    const stmts = splitStatements(src);
    if (!stmts.length) return { ok: false, error: '没有可执行的语句' };
    for (const tokens of stmts) {
      const p = makeParser(tokens);
      attachTokens(p, tokens);
      if (p.kw('SELECT')) lastSelect = runSelect(p, db);
      else if (p.kw('INSERT')) logs.push(runInsert(p, db).message);
      else if (p.kw('CREATE')) logs.push(runCreate(p, db).message);
      else if (p.kw('DROP')) logs.push(runDrop(p, db).message);
      else if (p.kw('UPDATE')) logs.push(runUpdate(p, db).message);
      else if (p.kw('DELETE')) logs.push(runDelete(p, db).message);
      else throw new Error(`不支持的语句：${p.peek().raw || p.peek().kind}（可用 CREATE/INSERT/SELECT/UPDATE/DELETE/DROP）`);
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err), db: serialize(db) };
  }
  return { ok: true, db: serialize(db), logs, select: lastSelect };
}

export function formatSqlResult(out, { dbPath } = {}) {
  if (!out.ok) return `execute_sql 失败：${out.error}`;
  const parts = [];
  if (out.logs && out.logs.length) parts.push(out.logs.join('\n'));
  if (out.select) {
    const { headers, rows } = out.select;
    const shown = rows.slice(0, MAX_ROWS_OUT);
    const width = headers.map((h, i) => Math.min(40, Math.max(String(h).length, ...shown.map((r) => String(r[i] == null ? 'NULL' : r[i]).length))));
    const cell = (v, i) => String(v == null ? 'NULL' : v).slice(0, 40).padEnd(width[i]);
    const line = (arr) => arr.map((v, i) => cell(v, i)).join(' | ');
    parts.push(line(headers));
    parts.push(width.map((w) => '-'.repeat(w)).join('-+-'));
    for (const r of shown) parts.push(line(r));
    parts.push(`（${rows.length} 行${rows.length > MAX_ROWS_OUT ? `，显示前 ${MAX_ROWS_OUT}` : ''}）`);
  }
  if (dbPath) parts.push(`库文件：${dbPath}`);
  if (!parts.length) parts.push('（完成，无输出）');
  return parts.join('\n');
}
