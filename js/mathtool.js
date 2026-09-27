// ─── 纯数学表达式求值（本地，不执行任意 JS）────────────────────────────
// 允许：数字、括号、+ - * / % ^ **、阶乘 !、隐式乘法、常量和白名单函数。
// 禁止：变量赋值、任意标识符、语句。

const MAX_LEN = 4000;
const FN = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sign: Math.sign,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, trunc: Math.trunc,
  exp: Math.exp, log: Math.log, ln: Math.log, log10: Math.log10, log2: Math.log2,
  min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
};
const CONST = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };
const DEG_FN = new Set(['sin', 'cos', 'tan']);
const DEG_INV = new Set(['asin', 'acos', 'atan']);

function fact(n) {
  if (!Number.isInteger(n) || n < 0 || n > 170) throw new Error('阶乘只接受 0–170 的整数');
  let a = 1;
  for (let i = 2; i <= n; i++) a *= i;
  return a;
}

export function evaluateExpression(expression, { degrees = false } = {}) {
  const src = String(expression == null ? '' : expression).trim();
  if (!src) return { ok: false, error: 'expression 不能为空' };
  if (src.length > MAX_LEN) return { ok: false, error: `表达式过长（>${MAX_LEN}）` };
  let i = 0;
  const peek = () => src[i] || '';
  const skip = () => { while (/\s/.test(peek())) i += 1; };
  const fail = (m) => { throw new Error(m); };

  function parseIdent() {
    skip();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!m) return '';
    i += m[0].length;
    return m[0].toLowerCase();
  }
  function parseNumber() {
    skip();
    const m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  }
  function parseArgs() {
    skip();
    if (peek() !== '(') fail('函数缺少 (');
    i += 1;
    const args = [];
    skip();
    if (peek() === ')') { i += 1; return args; }
    for (;;) {
      args.push(parseAdd());
      skip();
      if (peek() === ',') { i += 1; continue; }
      if (peek() === ')') { i += 1; break; }
      fail('函数参数列表语法错误');
    }
    return args;
  }
  function parsePrimary() {
    skip();
    if (peek() === '(') {
      i += 1;
      const v = parseAdd();
      skip();
      if (peek() !== ')') fail('缺少 )');
      i += 1;
      return v;
    }
    if (peek() === '+' || peek() === '-') {
      const s = peek() === '-' ? -1 : 1;
      i += 1;
      return s * parseUnary();
    }
    const num = parseNumber();
    if (num != null) return num;
    const id = parseIdent();
    if (!id) fail(`意外字符「${peek() || 'EOF'}」`);
    if (Object.prototype.hasOwnProperty.call(CONST, id)) return CONST[id];
    if (Object.prototype.hasOwnProperty.call(FN, id)) {
      const args = parseArgs();
      const fn = FN[id];
      if (id === 'atan2' || id === 'min' || id === 'max' || id === 'hypot' || id === 'pow') {
        if (args.length < 2) fail(`${id} 至少需要 2 个参数`);
      } else if (args.length !== 1) fail(`${id} 需要 1 个参数`);
      let a = args.slice();
      if (degrees && DEG_FN.has(id) && a[0] != null) a[0] = a[0] * Math.PI / 180;
      let out = fn(...a);
      if (degrees && DEG_INV.has(id)) out = out * 180 / Math.PI;
      return out;
    }
    fail(`未知标识符「${id}」。可用常数 pi/e/tau/phi，函数 ${Object.keys(FN).join(', ')}`);
  }
  function parseUnary() {
    return parseFact(parsePrimary());
  }
  function parseFact(left) {
    skip();
    while (peek() === '!') {
      i += 1;
      left = fact(left);
      skip();
    }
    // 隐式乘法：2pi、2(1+2)、(1+2)(3)、(1+2)pi、pi(2)
    for (;;) {
      skip();
      if (peek() === '(' || /[A-Za-z.]/.test(peek()) || (/\d/.test(peek()) && /[A-Za-z)]$/.test(src[i - 1] || ''))) {
        if (peek() === '(' || /[A-Za-z]/.test(peek())) {
          left *= parseUnary();
          continue;
        }
      }
      break;
    }
    return left;
  }
  function parsePow() {
    let left = parseUnary();
    skip();
    if (src.slice(i, i + 2) === '**') { i += 2; return left ** parsePow(); }
    if (peek() === '^') { i += 1; return left ** parsePow(); }
    return left;
  }
  function parseMul() {
    let left = parsePow();
    for (;;) {
      skip();
      const c = peek();
      if (c === '*' || c === '/' || c === '%') {
        i += 1;
        const r = parsePow();
        if (c === '*') left *= r;
        else if (c === '/') left /= r;
        else left %= r;
      } else break;
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    for (;;) {
      skip();
      const c = peek();
      if (c === '+' || c === '-') {
        i += 1;
        const r = parseMul();
        left = c === '+' ? left + r : left - r;
      } else break;
    }
    return left;
  }

  try {
    const value = parseAdd();
    skip();
    if (i < src.length) fail(`未能解析剩余「${src.slice(i)}」`);
    if (!Number.isFinite(value)) return { ok: false, error: `结果不是有限数：${value}`, value };
    return { ok: true, value, text: formatNum(value) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function formatNum(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const s = n.toPrecision(14).replace(/\.?0+e/, 'e').replace(/(\.\d*?)0+$/, '$1');
  return s;
}

export function formatMathResult(out, expr) {
  if (!out.ok) return `evaluate_expression 失败：${out.error}`;
  return `expression: ${expr}\nvalue: ${out.text}`;
}
