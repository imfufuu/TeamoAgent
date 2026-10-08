// Dubhe Agent · JS 沙箱运行时垫片（.35，Helix 3.0「寒武」能力扩展）
// 被 worker-js.js 在 lockdown 之后、用户代码之前装配。目标：让「Node 风格」「浏览器风格」的常见代码片段
// 不改一行就能在隔离 Worker 里跑起来，同时**不**放宽安全边界：
//   · require()：fs（映射到 files 虚拟文件系统）/ path / buffer / util / events / crypto（纯 JS sha1·sha256·md5 + WebCrypto 随机数）/ os / process / assert / url / timers
//   · Buffer / process / module / exports / __dirname / __filename 全局
//   · document.createElement('canvas') → OffscreenCanvas（画图、导出 PNG 到 files），其它标签明确报错
//   · fetch / importScripts：只在宿主放行（顶栏联网开 + 中继可用）时可用，经 MessageChannel 让主线程走中继抓取——
//     Worker 自己依然没有任何出网原语；GET-only、次数与字节上限由主线程执行
//   · 仍然没有：真实 DOM、XMLHttpRequest（请用 fetch）、WebSocket（中继是 HTTP，做不了）、Node 原生模块（child_process / net / http 等）
//
// 这个文件是普通脚本（非 ESM），由 worker-js.js 通过 importScripts 在 lockdown **之前**加载（lockdown 会删掉 importScripts）。

(function installShimsFactory(global) {
  'use strict';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ── 哈希（纯 JS，同步；输入 Uint8Array）──
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256(bytes) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const l = bytes.length; const padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[l] = 0x80;
    const dv = new DataView(padded.buffer); dv.setUint32(padded.length - 4, (l * 8) >>> 0); dv.setUint32(padded.length - 8, Math.floor((l * 8) / 0x100000000));
    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) { const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3); const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0; }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25); const ch = (e & f) ^ (~e & g); const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22); const mj = (a & b) ^ (a & c) ^ (b & c); const t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0; H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    const out = new Uint8Array(32); const ov = new DataView(out.buffer); H.forEach((v, i) => ov.setUint32(i * 4, v)); return out;
  }
  function sha1(bytes) {
    const l = bytes.length; const padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[l] = 0x80;
    const dv = new DataView(padded.buffer); dv.setUint32(padded.length - 4, (l * 8) >>> 0); dv.setUint32(padded.length - 8, Math.floor((l * 8) / 0x100000000));
    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0; const w = new Uint32Array(80);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; } else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; } else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0; e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    const out = new Uint8Array(20); const ov = new DataView(out.buffer); [h0, h1, h2, h3, h4].forEach((v, i) => ov.setUint32(i * 4, v)); return out;
  }
  function md5(bytes) {
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = new Array(64).fill(0).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
    const l = bytes.length; const padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[l] = 0x80;
    const dv = new DataView(padded.buffer); dv.setUint32(padded.length - 8, (l * 8) >>> 0, true); dv.setUint32(padded.length - 4, Math.floor((l * 8) / 0x100000000), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < padded.length; off += 64) {
      const M = new Uint32Array(16); for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0; A = D; D = C; C = B; B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16); const ov = new DataView(out.buffer); [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true)); return out;
  }
  const HASHES = { sha256, sha1, md5 };
  const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const b64encode = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const b64decode = (s) => { const bin = atob(String(s).replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/')); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };

  // ── Buffer（Uint8Array 子类，覆盖最常用的那一小撮 API）──
  class Buffer extends Uint8Array {
    static from(v, encOrOffset, len) {
      if (typeof v === 'string') {
        const e = String(encOrOffset || 'utf8').toLowerCase();
        if (e === 'base64' || e === 'base64url') return new Buffer(b64decode(v));
        if (e === 'hex') { const s = v.replace(/[^0-9a-f]/gi, ''); const u8 = new Uint8Array(s.length >> 1); for (let i = 0; i < u8.length; i++) u8[i] = parseInt(s.substr(i * 2, 2), 16); return new Buffer(u8); }
        if (e === 'latin1' || e === 'binary' || e === 'ascii') { const u8 = new Uint8Array(v.length); for (let i = 0; i < v.length; i++) u8[i] = v.charCodeAt(i) & 0xff; return new Buffer(u8); }
        return new Buffer(enc.encode(v));
      }
      if (v instanceof ArrayBuffer) return new Buffer(new Uint8Array(v, encOrOffset || 0, len == null ? undefined : len));
      if (ArrayBuffer.isView(v)) return new Buffer(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      if (Array.isArray(v)) return new Buffer(Uint8Array.from(v.map((x) => x & 0xff)));
      if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
      throw new TypeError('Buffer.from：不支持的输入类型');
    }
    static alloc(n, fill = 0) { const b = new Buffer(n); if (fill) b.fill(typeof fill === 'string' ? fill.charCodeAt(0) : fill); return b; }
    static allocUnsafe(n) { return new Buffer(n); }
    static isBuffer(x) { return x instanceof Buffer; }
    static byteLength(s, e = 'utf8') { return typeof s === 'string' ? Buffer.from(s, e).length : (s && s.byteLength) || 0; }
    static concat(list, total) { const n = total != null ? total : list.reduce((a, b) => a + b.length, 0); const out = new Buffer(n); let off = 0; for (const b of list) { out.set(b.subarray(0, n - off), off); off += b.length; if (off >= n) break; } return out; }
    static compare(a, b) { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1); }
    toString(e = 'utf8', start = 0, end = this.length) {
      const sub = this.subarray(start, end); const k = String(e || 'utf8').toLowerCase();
      if (k === 'hex') return toHex(sub);
      if (k === 'base64') return b64encode(sub);
      if (k === 'base64url') return b64encode(sub).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (k === 'latin1' || k === 'binary' || k === 'ascii') return Array.from(sub, (c) => String.fromCharCode(c)).join('');
      return dec.decode(sub);
    }
    toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
    equals(o) { return Buffer.compare(this, o) === 0; }
    write(str, offset = 0, length, e = 'utf8') { const src = Buffer.from(str, typeof length === 'string' ? length : e); const n = Math.min(src.length, this.length - offset, typeof length === 'number' ? length : Infinity); this.set(src.subarray(0, n), offset); return n; }
    slice(a, b) { return new Buffer(super.subarray(a, b)); }
    readUInt8(o = 0) { return this[o]; } readUInt16BE(o = 0) { return new DataView(this.buffer, this.byteOffset).getUint16(o); } readUInt16LE(o = 0) { return new DataView(this.buffer, this.byteOffset).getUint16(o, true); }
    readUInt32BE(o = 0) { return new DataView(this.buffer, this.byteOffset).getUint32(o); } readUInt32LE(o = 0) { return new DataView(this.buffer, this.byteOffset).getUint32(o, true); }
    readInt32BE(o = 0) { return new DataView(this.buffer, this.byteOffset).getInt32(o); } readInt32LE(o = 0) { return new DataView(this.buffer, this.byteOffset).getInt32(o, true); }
    writeUInt32BE(v, o = 0) { new DataView(this.buffer, this.byteOffset).setUint32(o, v); return o + 4; } writeUInt32LE(v, o = 0) { new DataView(this.buffer, this.byteOffset).setUint32(o, v, true); return o + 4; }
    writeUInt16BE(v, o = 0) { new DataView(this.buffer, this.byteOffset).setUint16(o, v); return o + 2; } writeUInt16LE(v, o = 0) { new DataView(this.buffer, this.byteOffset).setUint16(o, v, true); return o + 2; }
    writeUInt8(v, o = 0) { this[o] = v & 0xff; return o + 1; }
  }

  // ── path（posix）──
  const path = {
    sep: '/', delimiter: ':',
    normalize(p) { const abs = String(p).startsWith('/'); const out = []; for (const seg of String(p).split('/')) { if (!seg || seg === '.') continue; if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); continue; } out.push(seg); } const s = out.join('/'); return (abs ? '/' : '') + (s || (abs ? '' : '.')); },
    join(...parts) { return path.normalize(parts.filter((x) => x != null && x !== '').join('/')); },
    resolve(...parts) { let r = ''; for (const p of parts) { const s = String(p || ''); r = s.startsWith('/') ? s : (r ? `${r}/${s}` : s); } const n = path.normalize(r || '.'); return n.startsWith('/') ? n : `/${n === '.' ? '' : n}`; },
    isAbsolute(p) { return String(p).startsWith('/'); },
    basename(p, ext) { const b = String(p).replace(/\/+$/, '').split('/').pop() || ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
    dirname(p) { const s = String(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i < 0 ? '.' : (i === 0 ? '/' : s.slice(0, i)); },
    extname(p) { const b = path.basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },
    relative(from, to) { const a = path.resolve(from).split('/').filter(Boolean); const b = path.resolve(to).split('/').filter(Boolean); let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/'); },
    parse(p) { const base = path.basename(p); const ext = path.extname(p); return { root: String(p).startsWith('/') ? '/' : '', dir: path.dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base }; },
    format(o) { return path.join(o.dir || o.root || '', o.base || `${o.name || ''}${o.ext || ''}`); },
  };
  path.posix = path;

  // ── fs（映射到 files 虚拟文件系统：键 = 相对路径；目录是「前缀」概念）──
  function makeFs(files) {
    const norm = (p) => path.normalize(String(p)).replace(/^\/+/, '').replace(/^\.\/+/, '');
    const notFound = (p, syscall = 'open') => { const e = new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`); e.code = 'ENOENT'; e.errno = -2; e.syscall = syscall; e.path = p; return e; };
    const toText = (data, opts) => { const e = typeof opts === 'string' ? opts : (opts && opts.encoding); if (typeof data === 'string') return e === 'base64' ? b64decode(data) && dec.decode(b64decode(data)) : data; if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return dec.decode(ArrayBuffer.isView(data) ? data : new Uint8Array(data)); return String(data); };
    const isDir = (p) => { const pre = p ? `${p}/` : ''; return Object.keys(files).some((k) => k.startsWith(pre)) && !(p in files); };
    const fs = {
      existsSync: (p) => { const k = norm(p); return (k in files) || isDir(k); },
      readFileSync: (p, opts) => { const k = norm(p); if (!(k in files)) throw notFound(k); const e = typeof opts === 'string' ? opts : (opts && opts.encoding); const txt = files[k]; if (!e) return Buffer.from(txt, 'utf8'); if (e === 'base64') return b64encode(enc.encode(txt)); return txt; },
      writeFileSync: (p, data, opts) => { const k = norm(p); if (!k || k.startsWith('..')) throw new Error(`EACCES: 非法路径 '${p}'`); files[k] = toText(data, opts); },
      appendFileSync: (p, data, opts) => { const k = norm(p); files[k] = (files[k] || '') + toText(data, opts); },
      unlinkSync: (p) => { const k = norm(p); if (!(k in files)) throw notFound(k, 'unlink'); delete files[k]; },
      rmSync: (p, o) => { const k = norm(p); if (k in files) { delete files[k]; return; } const pre = `${k}/`; const hit = Object.keys(files).filter((x) => x.startsWith(pre)); if (!hit.length && !(o && o.force)) throw notFound(k, 'rm'); for (const x of hit) delete files[x]; },
      renameSync: (a, b) => { const ka = norm(a); const kb = norm(b); if (!(ka in files)) throw notFound(ka, 'rename'); files[kb] = files[ka]; delete files[ka]; },
      copyFileSync: (a, b) => { const ka = norm(a); if (!(ka in files)) throw notFound(ka, 'copyfile'); files[norm(b)] = files[ka]; },
      mkdirSync: () => undefined, // 目录是前缀概念，无需创建
      readdirSync: (p, opts) => { const k = norm(p); const pre = k && k !== '.' ? `${k}/` : ''; const names = new Set(); for (const key of Object.keys(files)) { if (!key.startsWith(pre)) continue; const rest = key.slice(pre.length); names.add(rest.split('/')[0]); } if (!names.size && pre && !isDir(k)) throw notFound(k, 'scandir'); const arr = [...names].sort(); if (opts && opts.withFileTypes) return arr.map((n) => ({ name: n, isFile: () => (pre + n) in files, isDirectory: () => !((pre + n) in files) })); return arr; },
      statSync: (p) => { const k = norm(p); if (k in files) { const size = enc.encode(files[k]).length; return { size, isFile: () => true, isDirectory: () => false, mtime: new Date(), mtimeMs: Date.now() }; } if (isDir(k) || k === '' || k === '.') return { size: 0, isFile: () => false, isDirectory: () => true, mtime: new Date(), mtimeMs: Date.now() }; throw notFound(k, 'stat'); },
    };
    fs.lstatSync = fs.statSync; fs.accessSync = (p) => { if (!fs.existsSync(p)) throw notFound(norm(p), 'access'); };
    fs.promises = Object.fromEntries(Object.entries(fs).filter(([k]) => k.endsWith('Sync')).map(([k, f]) => [k.replace(/Sync$/, ''), async (...a) => f(...a)]));
    fs.readFile = (p, o, cb) => { if (typeof o === 'function') { cb = o; o = undefined; } try { cb(null, fs.readFileSync(p, o)); } catch (e) { cb(e); } };
    fs.writeFile = (p, d, o, cb) => { if (typeof o === 'function') { cb = o; o = undefined; } try { fs.writeFileSync(p, d, o); cb && cb(null); } catch (e) { cb && cb(e); } };
    return fs;
  }

  // ── util / events / crypto / os / assert ──
  const inspect = (v, depth = 2) => { try { return typeof v === 'string' ? v : JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : (x instanceof Map ? Object.fromEntries(x) : (x instanceof Set ? [...x] : x))), 2); } catch { return String(v); } };
  const util = {
    inspect,
    format(f, ...args) { let i = 0; const s = String(f).replace(/%[sdifjoO%]/g, (m) => { if (m === '%%') return '%'; const a = args[i++]; if (m === '%d' || m === '%i') return String(parseInt(a, 10)); if (m === '%f') return String(parseFloat(a)); if (m === '%j') return JSON.stringify(a); if (m === '%o' || m === '%O') return inspect(a); return String(a); }); return [s, ...args.slice(i).map((a) => (typeof a === 'string' ? a : inspect(a)))].join(' '); },
    promisify: (fn) => (...a) => new Promise((res, rej) => fn(...a, (err, v) => (err ? rej(err) : res(v)))),
    isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    types: { isPromise: (x) => !!x && typeof x.then === 'function', isDate: (x) => x instanceof Date, isRegExp: (x) => x instanceof RegExp },
    TextEncoder, TextDecoder,
  };
  class EventEmitter {
    constructor() { this._ev = new Map(); }
    on(n, f) { if (!this._ev.has(n)) this._ev.set(n, []); this._ev.get(n).push(f); return this; }
    addListener(n, f) { return this.on(n, f); }
    once(n, f) { const w = (...a) => { this.off(n, w); f(...a); }; w._orig = f; return this.on(n, w); }
    off(n, f) { const l = this._ev.get(n) || []; this._ev.set(n, l.filter((x) => x !== f && x._orig !== f)); return this; }
    removeListener(n, f) { return this.off(n, f); }
    removeAllListeners(n) { if (n == null) this._ev.clear(); else this._ev.delete(n); return this; }
    emit(n, ...a) { const l = [...(this._ev.get(n) || [])]; if (n === 'error' && !l.length) throw (a[0] instanceof Error ? a[0] : new Error(String(a[0]))); for (const f of l) f.apply(this, a); return l.length > 0; }
    listenerCount(n) { return (this._ev.get(n) || []).length; }
    listeners(n) { return [...(this._ev.get(n) || [])]; }
    eventNames() { return [...this._ev.keys()]; }
  }
  EventEmitter.EventEmitter = EventEmitter;
  function makeCrypto(webcrypto) {
    const hashOf = (algo) => { const a = String(algo).toLowerCase().replace(/-/g, ''); const fn = HASHES[a]; if (!fn) throw new Error(`crypto.createHash：沙箱支持 sha256 / sha1 / md5，不支持 ${algo}`); return fn; };
    const hmac = (fn, key, data, block) => { let k = key.length > block ? fn(key) : key; const kp = new Uint8Array(block); kp.set(k); const ipad = kp.map((b) => b ^ 0x36); const opad = kp.map((b) => b ^ 0x5c); const inner = fn(Buffer.concat([ipad, data])); return fn(Buffer.concat([opad, inner])); };
    const digester = (compute) => { const chunks = []; const h = { update(d, e) { chunks.push(typeof d === 'string' ? Buffer.from(d, e || 'utf8') : Buffer.from(d)); return h; }, digest(e) { const out = Buffer.from(compute(Buffer.concat(chunks))); return e ? out.toString(e) : out; } }; return h; };
    return {
      createHash: (algo) => { const fn = hashOf(algo); return digester((data) => fn(data)); },
      createHmac: (algo, key) => { const fn = hashOf(algo); const k = typeof key === 'string' ? Buffer.from(key) : Buffer.from(key); return digester((data) => hmac(fn, k, data, 64)); },
      randomBytes: (n) => { const b = new Buffer(n); webcrypto.getRandomValues(b); return b; },
      randomUUID: () => webcrypto.randomUUID(),
      randomInt: (a, b) => { if (b == null) { b = a; a = 0; } const u = new Uint32Array(1); webcrypto.getRandomValues(u); return a + (u[0] % (b - a)); },
      getRandomValues: (arr) => webcrypto.getRandomValues(arr),
      subtle: webcrypto.subtle, webcrypto,
      timingSafeEqual: (a, b) => a.length === b.length && Buffer.compare(a, b) === 0,
    };
  }
  const os = { EOL: '\n', platform: () => 'browser', type: () => 'DubheSandbox', arch: () => 'wasm32', release: () => '1.0', homedir: () => '/', tmpdir: () => '/tmp', hostname: () => 'sandbox', cpus: () => [{ model: 'virtual', speed: 0 }], totalmem: () => 0, freemem: () => 0, uptime: () => Math.floor((global.performance ? global.performance.now() : 0) / 1000), endianness: () => 'LE' };
  function assertFn(v, msg) { if (!v) { const e = new Error(msg || 'Assertion failed'); e.name = 'AssertionError'; throw e; } }
  assertFn.ok = assertFn; assertFn.equal = (a, b, m) => assertFn(a == b, m || `${inspect(a)} == ${inspect(b)}`); assertFn.strictEqual = (a, b, m) => assertFn(a === b, m || `${inspect(a)} === ${inspect(b)}`);
  assertFn.deepStrictEqual = (a, b, m) => assertFn(util.isDeepStrictEqual(a, b), m || `deepStrictEqual 失败：${inspect(a)} vs ${inspect(b)}`); assertFn.deepEqual = assertFn.deepStrictEqual;
  assertFn.notEqual = (a, b, m) => assertFn(a != b, m); assertFn.throws = (fn, m) => { let threw = false; try { fn(); } catch { threw = true; } assertFn(threw, m || '应抛出异常'); }; assertFn.fail = (m) => assertFn(false, m);

  // ── 装配：返回交给用户代码的全局垫片 ──
  // net：{ enabled, rpc(method, params) → Promise }，由 worker-js.js 按主线程授权注入；未授权时 fetch / importScripts 抛出可操作的说明
  global.__dubheInstallShims = function installShims({ files, net, webcrypto, OffscreenCanvasCtor, FileReaderSyncCtor, console }) {
    const fs = makeFs(files);
    const crypto = makeCrypto(webcrypto);
    const process = {
      env: {}, argv: ['node', 'sandbox'], platform: 'browser', arch: 'wasm32', version: 'v0.0.0-dubhe-sandbox', versions: { node: '0.0.0', dubhe: '3.0' }, pid: 1, title: 'dubhe-sandbox',
      cwd: () => '/', exit: (code) => { throw new Error(`process.exit(${code == null ? 0 : code}) 被沙箱拦截：直接 return 结果即可`); }, nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)),
      hrtime: Object.assign((prev) => { const ms = global.performance ? global.performance.now() : Date.now(); const s = Math.floor(ms / 1000); const ns = Math.floor((ms % 1000) * 1e6); if (prev) { let ds = s - prev[0]; let dns = ns - prev[1]; if (dns < 0) { ds -= 1; dns += 1e9; } return [ds, dns]; } return [s, ns]; }, { bigint: () => BigInt(Math.floor((global.performance ? global.performance.now() : Date.now()) * 1e6)) }),
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }), uptime: () => (global.performance ? global.performance.now() : 0) / 1000,
      on: () => process, once: () => process, off: () => process, emit: () => false, stdout: { write: (s) => { console.log(String(s).replace(/\n$/, '')); return true; }, isTTY: false }, stderr: { write: (s) => { console.error(String(s).replace(/\n$/, '')); return true; }, isTTY: false },
    };
    const NET_OFF = () => new Error('沙箱内网络未开启：fetch / importScripts 只有在顶栏「联网」打开且网页中继可用时才会放行（经中继、仅 GET）。现在要抓网页请改用 fetch_url 工具，或让用户开启联网。');
    const toResponse = (r, url) => {
      const text = String(r.text || '');
      const headers = { get: (k) => (String(k).toLowerCase() === 'content-type' ? (r.contentType || '') : null), has: (k) => String(k).toLowerCase() === 'content-type' };
      return { ok: !!r.ok && (r.status || 200) < 400, status: r.status || (r.ok ? 200 : 0), statusText: r.ok ? 'OK' : 'ERROR', url: r.url || url, headers, redirected: !!(r.url && r.url !== url), type: 'basic', bodyUsed: false,
        text: async () => text, json: async () => JSON.parse(text), arrayBuffer: async () => enc.encode(text).buffer, blob: async () => new Blob([text], { type: r.contentType || 'text/plain' }), clone() { return toResponse(r, url); } };
    };
    const fetchShim = async (input, init = {}) => {
      if (!net || !net.enabled) throw NET_OFF();
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') throw new Error(`沙箱内 fetch 只支持 GET（经中继抓取），收到 ${method}。需要提交数据请让用户在页面外完成。`);
      if (!/^https?:\/\//i.test(url)) throw new Error(`沙箱内 fetch 只接受 http(s) 绝对地址，收到：${url}`);
      const r = await net.rpc('fetch', { url, mode: 'raw' });
      if (!r || r.error) throw new Error(`fetch 失败：${(r && r.error) || '中继无响应'}`);
      return toResponse(r, url);
    };
    const importScriptsShim = async (...urls) => {
      if (!net || !net.enabled) throw NET_OFF();
      for (const u of urls) {
        const r = await net.rpc('fetch', { url: String(u), mode: 'raw' });
        if (!r || r.error || !r.ok) throw new Error(`importScripts 失败：${(r && r.error) || `HTTP ${r && r.status}`}（${u}）`);
        (0, eval)(String(r.text || '')); // 间接 eval：在 Worker 全局作用域执行脚本（库会把自己挂到 self 上）
      }
    };
    const document = {
      createElement(tag) {
        const t = String(tag || '').toLowerCase();
        if (t === 'canvas') {
          if (!OffscreenCanvasCtor) throw new Error('当前浏览器的 Worker 没有 OffscreenCanvas，无法在沙箱里画图');
          const c = new OffscreenCanvasCtor(300, 150);
          // DOM 的 toDataURL 是同步的；OffscreenCanvas 只能异步导出 → 这里返回 Promise（await canvas.toDataURL()）
          c.toDataURL = async (type = 'image/png', quality) => { const blob = await c.convertToBlob({ type, quality }); if (FileReaderSyncCtor) return new FileReaderSyncCtor().readAsDataURL(blob); const u8 = new Uint8Array(await blob.arrayBuffer()); return `data:${blob.type};base64,${b64encode(u8)}`; };
          c.toBlob = (cb, type, quality) => c.convertToBlob({ type, quality }).then(cb);
          return c;
        }
        throw new Error(`沙箱没有真实 DOM：document.createElement('${t}') 不可用（只支持 'canvas' → OffscreenCanvas）。要生成 HTML 请直接拼字符串写进 files。`);
      },
      createElementNS(_ns, tag) { return document.createElement(tag); },
      get body() { throw new Error('沙箱没有真实 DOM（document.body 不存在）。要产出页面请把 HTML 字符串写进 files，由用户在文件面板预览。'); },
      querySelector() { throw new Error('沙箱没有真实 DOM（querySelector 不可用）。解析 HTML 文本请用正则或自行写一个小解析器。'); },
      getElementById() { throw new Error('沙箱没有真实 DOM（getElementById 不可用）。'); },
    };
    const modules = {
      fs, 'fs/promises': fs.promises, path, 'path/posix': path, buffer: { Buffer }, util, events: EventEmitter, crypto, os, process, assert: assertFn, 'assert/strict': assertFn,
      url: { URL, URLSearchParams, fileURLToPath: (u) => String(u).replace(/^file:\/\//, ''), pathToFileURL: (p) => new URL(`file://${p}`) },
      querystring: { parse: (s) => Object.fromEntries(new URLSearchParams(s)), stringify: (o) => new URLSearchParams(o).toString(), escape: encodeURIComponent, unescape: decodeURIComponent },
      timers: { setTimeout: global.setTimeout.bind(global), clearTimeout: global.clearTimeout.bind(global), setInterval: global.setInterval.bind(global), clearInterval: global.clearInterval.bind(global), setImmediate: (f, ...a) => global.setTimeout(f, 0, ...a) },
      'timers/promises': { setTimeout: (ms, v) => new Promise((r) => global.setTimeout(() => r(v), ms)) },
      string_decoder: { StringDecoder: class { constructor(e = 'utf8') { this.e = e; this.d = new TextDecoder(); } write(b) { return this.d.decode(b, { stream: true }); } end(b) { return b ? this.d.decode(b) : this.d.decode(); } } },
    };
    const UNSUPPORTED = { http: 'fetch', https: 'fetch', net: '（无）', child_process: '（无：沙箱不能起进程）', worker_threads: '（无）', cluster: '（无）', dgram: '（无）', tls: '（无）', readline: '（无：没有 stdin）', zlib: 'DecompressionStream / CompressionStream（浏览器原生）', stream: 'Web Streams（ReadableStream 等）', vm: 'new Function', sqlite3: 'execute_sql 工具', axios: 'fetch', 'node-fetch': 'fetch' };
    const require = (name) => {
      const n = String(name || '').replace(/^node:/, '');
      if (n in modules) return modules[n];
      if (n in UNSUPPORTED) throw new Error(`沙箱不提供 Node 模块 '${n}'（替代：${UNSUPPORTED[n]}）。可用：${Object.keys(modules).join(', ')}`);
      throw new Error(`Cannot find module '${name}'：沙箱没有 npm，第三方库请用 importScripts('https://cdn.jsdelivr.net/npm/<pkg>@x/dist/<umd>.js')（需联网开启）后从 self 上取。内置模块：${Object.keys(modules).join(', ')}`);
    };
    require.resolve = (n) => (String(n).replace(/^node:/, '') in modules ? `node:${n}` : (() => { throw new Error(`Cannot find module '${n}'`); })());
    const module = { exports: {}, id: '.', filename: '/index.js', loaded: false, children: [] };
    return { require, fs, path, Buffer, process, crypto, document, fetch: fetchShim, importScripts: importScriptsShim, module, exports: module.exports, __dirname: '/', __filename: '/index.js', EventEmitter, util };
  };
})(self);
