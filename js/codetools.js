// ─── 本地代码小工具：正则 / 哈希 / 编解码 / Unicode ─────────────────────
// 浏览器与 Node 都能跑（Web Crypto + 自带 MD5/CRC）。不碰网关、不执行任意代码。

import { crc32 } from './zip.js';

const MAX_TEXT = 400000;
const MAX_MATCHES = 250;
const MAX_UNICODE = 400;
const MAX_PATTERN = 4000;

const enc = new TextEncoder();
const dec = new TextDecoder();

function clip(s, n = MAX_TEXT) {
  const t = String(s == null ? '' : s);
  if (t.length <= n) return { text: t, truncated: false };
  return { text: t.slice(0, n), truncated: true, total: t.length };
}

function hexOf(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let out = '';
  for (let i = 0; i < u.length; i++) out += u[i].toString(16).padStart(2, '0');
  return out;
}

function b64Of(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64ToBytes(s, urlSafe) {
  let t = String(s || '').replace(/\s+/g, '');
  if (urlSafe) t = t.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4;
  if (pad) t += '='.repeat(4 - pad);
  const bin = atob(t);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function hexToBytes(s) {
  const t = String(s || '').replace(/[\s:_-]/g, '');
  if (!t.length || t.length % 2) throw new Error('hex 长度须为偶数');
  if (!/^[0-9a-fA-F]+$/.test(t)) throw new Error('hex 含非十六进制字符');
  const u = new Uint8Array(t.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  return u;
}

// ── MD5（RFC 1321，用于文件指纹；安全场景请用 SHA-256）────────────────
function md5(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const n = u.length;
  const add = (((n + 8) >> 6) + 1) * 16;
  const w = new Uint32Array(add);
  for (let i = 0; i < n; i++) w[i >> 2] |= u[i] << ((i % 4) * 8);
  w[n >> 2] |= 0x80 << ((n % 4) * 8);
  w[add - 2] = (n * 8) >>> 0;
  w[add - 1] = Math.floor(n / 0x20000000);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const rot = (x, s) => (x << s) | (x >>> (32 - s));
  const F = [
    (x, y, z) => (x & y) | (~x & z),
    (x, y, z) => (x & z) | (y & ~z),
    (x, y, z) => x ^ y ^ z,
    (x, y, z) => y ^ (x | ~z),
  ];
  const S = [
    [7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21],
  ];
  const T = new Uint32Array(64);
  for (let i = 0; i < 64; i++) T[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  const idx = (r, i) => (r === 0 ? i : r === 1 ? (5 * i + 1) % 16 : r === 2 ? (3 * i + 5) % 16 : (7 * i) % 16);
  for (let off = 0; off < add; off += 16) {
    let A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      const r = i >> 4;
      const f = (F[r](B, C, D) + A + T[i] + w[off + idx(r, i)]) >>> 0;
      A = D; D = C; C = B; B = (B + rot(f, S[r][i % 4])) >>> 0;
    }
    a = (a + A) >>> 0; b = (b + B) >>> 0; c = (c + C) >>> 0; d = (d + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const words = [a, b, c, d];
  for (let i = 0; i < 4; i++) {
    out[i * 4] = words[i] & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}

function fail(msg) { return { ok: false, error: msg, text: msg }; }
function ok(text) { return { ok: true, text }; }

// ── 正则 ──────────────────────────────────────────────────────────────
const FLAG_OK = /^[gimsuvyd]*$/;

function compileRe(pattern, flags) {
  const p = String(pattern == null ? '' : pattern);
  if (!p) throw new Error('缺少 pattern');
  if (p.length > MAX_PATTERN) throw new Error(`pattern 超过 ${MAX_PATTERN} 字符`);
  let f = String(flags == null ? '' : flags);
  if (f.startsWith('/')) f = '';
  if (!FLAG_OK.test(f)) throw new Error(`非法 flags「${f}」，仅允许 g i m s u v y d`);
  if (f.includes('u') && f.includes('v')) throw new Error('flags 不能同时含 u 与 v');
  return new RegExp(p, f);
}

export function runRegex(args = {}) {
  const action = String(args.action || 'match').toLowerCase();
  let re;
  try { re = compileRe(args.pattern, args.flags); }
  catch (e) { return fail(`正则编译失败：${e.message}`); }

  if (action === 'explain' || action === 'validate') {
    const src = re.source;
    const named = [...src.matchAll(/\(\?<([A-Za-z_]\w*)>/g)].map((m) => m[1]);
    const caps = (src.match(/\((?!\?)/g) || []).length;
    const lines = [
      `[regex explain] /${src}/${re.flags}`,
      `- flags：${re.flags || '（无）'}  global=${re.global} ignoreCase=${re.ignoreCase} multiline=${re.multiline} dotAll=${!!re.dotAll} unicode=${re.unicode} sticky=${re.sticky}`,
      `- 捕获组：${caps}  命名组：${named.length ? named.join(', ') : '无'}`,
      `- 前瞻/后顾：${/\(\?[=!]/.test(src) ? '含前瞻' : '无前瞻'} / ${/\(\?<[=!]/.test(src) ? '含后顾' : '无后顾'}`,
      `- 建议：匹配大量文本时加 g；Unicode 属性用 \\p{…} 并带 u 或 v；避免 (a+)+$ 这类嵌套量词。`,
    ];
    return ok(lines.join('\n'));
  }

  const raw = args.text == null ? '' : String(args.text);
  if (!raw && action !== 'explain') return fail('regex 需要 text（或 path 指向沙箱文件）');
  const { text, truncated, total } = clip(raw);
  const limit = Math.min(MAX_MATCHES, Math.max(1, Number(args.limit) || MAX_MATCHES));

  try {
    if (action === 'test') {
      const hit = re.test(text);
      return ok(`[regex test] /${re.source}/${re.flags} → ${hit ? '匹配' : '不匹配'}${truncated ? `（输入截到 ${text.length}/${total}）` : ''}`);
    }
    if (action === 'split') {
      const parts = text.split(re).slice(0, limit + 1);
      const more = parts.length > limit;
      const body = (more ? parts.slice(0, limit) : parts).map((p, i) => `${i}\t${JSON.stringify(p)}`).join('\n');
      return ok(`[regex split] ${Math.min(parts.length, limit)} 段${more ? '（已截断）' : ''}${truncated ? '；输入已截断' : ''}\n${body}`);
    }
    if (action === 'replace') {
      const repl = args.replacement == null ? '' : String(args.replacement);
      const out = text.replace(re, repl);
      return ok(`[regex replace] /${re.source}/${re.flags}${truncated ? '；输入已截断' : ''}\n${out}`);
    }
    // match（默认）
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const dFlags = flags.includes('d') ? flags : flags + (typeof re.hasIndices === 'boolean' ? 'd' : '');
    let rx;
    try { rx = new RegExp(re.source, dFlags); }
    catch { rx = new RegExp(re.source, flags); }
    const rows = [];
    let m; let guard = 0;
    rx.lastIndex = 0;
    while ((m = rx.exec(text))) {
      guard += 1;
      if (guard > limit) break;
      if (m[0] === '' && rx.global) rx.lastIndex += 1;
      const span = m.indices && m.indices[0] ? `[${m.indices[0][0]}:${m.indices[0][1]}]` : `index=${m.index}`;
      const g = [];
      for (let i = 1; i < m.length; i++) {
        if (m[i] === undefined) continue;
        g.push(`    $${i}=${JSON.stringify(m[i])}`);
      }
      if (m.groups) {
        for (const [k, v] of Object.entries(m.groups)) {
          if (v !== undefined) g.push(`    $<${k}>=${JSON.stringify(v)}`);
        }
      }
      rows.push(`${guard}  ${span}  ${JSON.stringify(m[0])}${g.length ? `\n${g.join('\n')}` : ''}`);
      if (!rx.global) break;
    }
    const head = `[regex match] /${re.source}/${re.flags || '(无)'}  ${rows.length} 处${guard > limit ? '（达到 limit）' : ''}${truncated ? `；输入截到 ${text.length}/${total}` : ''}`;
    return ok(rows.length ? `${head}\n${rows.join('\n')}` : `${head}\n（无匹配）`);
  } catch (e) {
    return fail(`正则执行失败：${e.message}`);
  }
}

// ── 哈希 ──────────────────────────────────────────────────────────────
const HASH_ALG = {
  md5: 'md5', sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512', crc32: 'crc32',
  'sha-1': 'SHA-1', 'sha-256': 'SHA-256', 'sha-384': 'SHA-384', 'sha-512': 'SHA-512',
};

export async function runHash(args = {}) {
  const algoKey = String(args.algorithm || 'sha256').toLowerCase().replace(/_/g, '-');
  const algo = HASH_ALG[algoKey];
  if (!algo) return fail(`不支持的算法「${args.algorithm}」。可选 md5 / sha1 / sha256 / sha384 / sha512 / crc32`);
  let bytes = args.bytes;
  if (!(bytes instanceof Uint8Array)) {
    bytes = enc.encode(String(args.text == null ? '' : args.text));
  }
  if (bytes.length > 8 * 1024 * 1024) return fail('输入超过 8MB');
  let digest;
  try {
    if (algo === 'md5') digest = md5(bytes);
    else if (algo === 'crc32') {
      const v = crc32(bytes);
      const hex = v.toString(16).padStart(8, '0');
      return ok(`[hash crc32] ${bytes.length} bytes${args.label ? `  ${args.label}` : ''}\nhex: ${hex}\nuint32: ${v}`);
    } else {
      const subtle = globalThis.crypto && globalThis.crypto.subtle;
      if (!subtle) return fail('当前环境没有 Web Crypto，无法计算 SHA');
      digest = new Uint8Array(await subtle.digest(algo, bytes));
    }
  } catch (e) {
    return fail(`哈希失败：${e.message}`);
  }
  const name = algo === 'md5' ? 'md5' : algo.toLowerCase();
  return ok(`[hash ${name}] ${bytes.length} bytes → ${digest.length} bytes${args.label ? `  ${args.label}` : ''}\nhex: ${hexOf(digest)}\nbase64: ${b64Of(digest)}`);
}

// ── 编解码 ────────────────────────────────────────────────────────────
const HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HTML_REV = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function htmlEncode(s) { return String(s).replace(/[&<>"']/g, (c) => HTML_MAP[c]); }
function htmlDecode(s) {
  return String(s)
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (_, ent) => {
      if (ent[0] === '#') {
        const n = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : _;
      }
      return HTML_REV[ent] || _;
    });
}

function b64urlOf(bytes) {
  return b64Of(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function runCodec(args = {}) {
  const action = String(args.action || 'encode').toLowerCase();
  if (action === 'uuid') {
    const c = globalThis.crypto;
    if (!c || typeof c.getRandomValues !== 'function') return fail('当前环境不能生成 UUID');
    const u = c.getRandomValues(new Uint8Array(16));
    u[6] = (u[6] & 0x0f) | 0x40;
    u[8] = (u[8] & 0x3f) | 0x80;
    const h = hexOf(u);
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    return ok(`[uuid v4]\n${id}`);
  }
  const format = String(args.format || 'base64').toLowerCase().replace(/_/g, '');
  const raw = args.text == null ? '' : String(args.text);
  if (!raw && format !== 'jwt') return fail('codec 需要 text（或 path）');
  const { text, truncated, total } = clip(raw, format === 'jwt' ? 20000 : MAX_TEXT);
  const note = truncated ? `\n（输入截到 ${text.length}/${total}）` : '';
  try {
    if (format === 'jwt') {
      const parts = text.trim().split('.');
      if (parts.length < 2) return fail('不是 JWT（需要 header.payload[.sig]）');
      const decodePart = (p, label) => {
        const json = dec.decode(b64ToBytes(p, true));
        try { return `${label}: ${JSON.stringify(JSON.parse(json), null, 2)}`; }
        catch { return `${label}（非 JSON）: ${json}`; }
      };
      const lines = ['[jwt decode]', decodePart(parts[0], 'header'), decodePart(parts[1], 'payload')];
      if (parts[2]) lines.push(`signature: ${parts[2].slice(0, 32)}${parts[2].length > 32 ? '…' : ''}（未校验）`);
      return ok(lines.join('\n') + note);
    }
    if (action === 'decode') {
      let out;
      if (format === 'base64') out = dec.decode(b64ToBytes(text, false));
      else if (format === 'base64url') out = dec.decode(b64ToBytes(text, true));
      else if (format === 'hex') out = dec.decode(hexToBytes(text));
      else if (format === 'url') out = decodeURIComponent(text.replace(/\+/g, '%20'));
      else if (format === 'html') out = htmlDecode(text);
      else return fail(`不支持的 format「${args.format}」。可选 base64 / base64url / hex / url / html / jwt`);
      return ok(`[codec decode ${format}] ${out.length} chars${note}\n${out}`);
    }
    // encode
    const bytes = enc.encode(text);
    let out;
    if (format === 'base64') out = b64Of(bytes);
    else if (format === 'base64url') out = b64urlOf(bytes);
    else if (format === 'hex') out = hexOf(bytes);
    else if (format === 'url') out = encodeURIComponent(text);
    else if (format === 'html') out = htmlEncode(text);
    else return fail(`不支持的 format「${args.format}」。可选 base64 / base64url / hex / url / html / jwt`);
    return ok(`[codec encode ${format}] ${bytes.length} bytes → ${out.length} chars${note}\n${out}`);
  } catch (e) {
    return fail(`编解码失败：${e.message}`);
  }
}

// ── Unicode ───────────────────────────────────────────────────────────
const GC = ['Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Mn', 'Mc', 'Me', 'Nd', 'Nl', 'No', 'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po', 'Sm', 'Sc', 'Sk', 'So', 'Zs', 'Zl', 'Zp', 'Cc', 'Cf', 'Cs', 'Co', 'Cn'];
const SCRIPTS = ['Latin', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Cyrillic', 'Greek', 'Arabic', 'Hebrew', 'Devanagari', 'Thai', 'Common', 'Inherited'];

function gcOf(ch) {
  for (const g of GC) {
    try { if (new RegExp(`^\\p{gc=${g}}$`, 'u').test(ch)) return g; } catch { /* 环境不支持 */ }
  }
  return '?';
}
function scriptOf(ch) {
  for (const s of SCRIPTS) {
    try { if (new RegExp(`^\\p{Script=${s}}$`, 'u').test(ch)) return s; } catch { /* */ }
  }
  return '?';
}
function blockHint(cp) {
  if (cp <= 0x7f) return 'ASCII';
  if (cp <= 0xff) return 'Latin-1';
  if (cp >= 0x4e00 && cp <= 0x9fff) return 'CJK Unified Ideograph';
  if (cp >= 0x3400 && cp <= 0x4dbf) return 'CJK Ext-A';
  if (cp >= 0x20000 && cp <= 0x2a6df) return 'CJK Ext-B';
  if (cp >= 0x3040 && cp <= 0x309f) return 'Hiragana';
  if (cp >= 0x30a0 && cp <= 0x30ff) return 'Katakana';
  if (cp >= 0xac00 && cp <= 0xd7af) return 'Hangul Syllable';
  if (cp >= 0x1f300 && cp <= 0x1faff) return 'Emoji / Pictograph';
  if (cp >= 0x2190 && cp <= 0x21ff) return 'Arrows';
  if (cp >= 0x2000 && cp <= 0x206f) return 'General Punctuation';
  if (cp >= 0xff00 && cp <= 0xffef) return 'Half/Fullwidth';
  return '';
}
function utf8Of(cp) {
  return hexOf(enc.encode(String.fromCodePoint(cp))).replace(/(..)/g, '$1 ').trim();
}

function parseCodes(s) {
  const out = [];
  const re = /U\+([0-9a-fA-F]{1,8})|\\u\{([0-9a-fA-F]{1,8})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|0x([0-9a-fA-F]{1,8})|&#x([0-9a-fA-F]+);|&#(\d+);|\b(\d{2,7})\b/g;
  let m;
  while ((m = re.exec(String(s || '')))) {
    const raw = m[1] || m[2] || m[3] || m[4] || m[5] || m[6] || (m[7] != null ? Number(m[7]).toString(16) : null) || (m[8] != null ? Number(m[8]).toString(16) : null);
    const cp = parseInt(raw, 16);
    if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) out.push(cp);
  }
  return out;
}

function inspectText(text) {
  const cps = [];
  for (const ch of text) cps.push(ch.codePointAt(0));
  const shown = cps.slice(0, MAX_UNICODE);
  const lines = [`[unicode inspect] ${cps.length} code points${cps.length > MAX_UNICODE ? `（列出前 ${MAX_UNICODE}）` : ''}`];
  let i = 0;
  for (const cp of shown) {
    i += 1;
    const ch = String.fromCodePoint(cp);
    const vis = /[\p{Cc}\p{Cf}\p{Zs}]/u.test(ch) ? '·' : ch;
    const cat = gcOf(ch);
    const sc = scriptOf(ch);
    const hint = blockHint(cp);
    lines.push(`${String(i).padStart(3)}  ${vis}  U+${cp.toString(16).toUpperCase().padStart(cp > 0xffff ? 5 : 4, '0')}  utf8 ${utf8Of(cp)}  ${cat}/${sc}${hint ? `  ${hint}` : ''}`);
  }
  const nfc = text.normalize('NFC');
  const nfd = text.normalize('NFD');
  lines.push(`NFC ${nfc === text ? '=' : '≠'} input（${nfc.length} chars）  NFD ${nfd.length} chars`);
  return lines.join('\n');
}

export function runUnicode(args = {}) {
  const action = String(args.action || 'inspect').toLowerCase();
  const raw = args.text == null ? '' : String(args.text);
  try {
    if (action === 'from_codes' || action === 'from') {
      const src = raw || String(args.codes || '');
      const cps = parseCodes(src);
      if (!cps.length) return fail('from_codes 需要 U+XXXX / 0xNN / 十进制码位');
      const s = String.fromCodePoint(...cps);
      return ok(`[unicode from_codes] ${cps.length} 个码位\n${s}\n${cps.map((c) => 'U+' + c.toString(16).toUpperCase()).join(' ')}`);
    }
    if (action === 'normalize') {
      const form = String(args.form || 'NFC').toUpperCase();
      if (!['NFC', 'NFD', 'NFKC', 'NFKD'].includes(form)) return fail('form 只能是 NFC / NFD / NFKC / NFKD');
      if (!raw) return fail('normalize 需要 text');
      const out = raw.normalize(form);
      return ok(`[unicode normalize ${form}] ${raw.length} → ${out.length} chars\n${out}`);
    }
    if (action === 'escape') {
      if (!raw) return fail('escape 需要 text');
      let out = '';
      for (const ch of raw) {
        const cp = ch.codePointAt(0);
        out += cp <= 0x7f && ch !== '\\' ? ch : cp <= 0xffff ? `\\u${cp.toString(16).padStart(4, '0')}` : `\\u{${cp.toString(16)}}`;
      }
      return ok(`[unicode escape]\n${out}`);
    }
    if (action === 'unescape') {
      if (!raw) return fail('unescape 需要 text');
      const out = raw.replace(/\\u\{([0-9a-fA-F]{1,8})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\n|\\t|\\r|\\\\/g, (m, a, b, c) => {
        if (m === '\\n') return '\n';
        if (m === '\\t') return '\t';
        if (m === '\\r') return '\r';
        if (m === '\\\\') return '\\';
        const cp = parseInt(a || b || c, 16);
        return String.fromCodePoint(cp);
      });
      return ok(`[unicode unescape]\n${out}`);
    }
    if (!raw) return fail('unicode 需要 text（或 path）');
    const { text, truncated, total } = clip(raw, 20000);
    const body = inspectText(text);
    return ok(truncated ? `${body}\n（输入截到 ${text.length}/${total}）` : body);
  } catch (e) {
    return fail(`Unicode 失败：${e.message}`);
  }
}

