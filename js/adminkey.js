// ─── 管理员密钥：源码里既没有明文密钥，也没有明文口令，还带有效期 ─────────
//
// 需求：在 API Key 输入框里填 `admin-…` 时，实际请求要换成另一把管理员密钥。
// 最直白的写法是 `if (输入 === '管理员口令') return '管理员密钥'` ——
// 那等于把「口令 + 密钥」明文一起放进公开仓库，任何人翻一遍源码就拿到了。这里改成：
//
//   ① 口令经 **scrypt**（RFC 7914，N=2^16 · r=8 · p=1，每次派生需 64 MiB 内存）拉伸成 64 字节：
//      前 32 字节是加密密钥，后 32 字节是校验密钥。scrypt 是内存困难函数——
//      GPU / ASIC / 超算的优势在于并行算力，而每个并行单元都要独占 64 MiB 高速内存，
//      暴力枚举的成本由「算力」变成「内存 × 时间」，比纯哈希迭代贵几个数量级；
//      合法用户只算一次：桌面约 0.3–0.8 秒，手机约 1–2 秒。
//   ② 管理员密钥与有效期打包成 JSON `{k, iat, exp}`，用加密密钥派生的密钥流异或后以 base64 存放（SEALED），
//      再用校验密钥对密文做 HMAC-SHA256（TAG）。校验先于解密：口令不对 → TAG 不匹配 → 直接拒绝，
//      改动密文 / 改动有效期 → TAG 不匹配 → 同样拒绝（有效期藏在密文里，没有口令既看不到也改不了）。
//   ③ **有效期**：解封后若 `now > exp`，即使口令正确也判定过期，密钥不进内存；
//      已解封的会话到期那一刻起 `effectiveApiKey` 不再替换别名（请求会带着别名发出去而被网关拒绝）。
//   ④ 还原只发生在内存：解封后的密钥只存在本模块的变量里，不写 localStorage、
//      不进导出 JSON、不进控制台、不渲染到界面（界面只显示「管理员密钥已启用 · 有效期至 …」）。
//
// 诚实说明：这是客户端秘密，谁有正确口令谁就能拿到它（这是需求本身）。有效期到期后
// 请同时在网关侧作废这把密钥——客户端的到期判断能挡住正常使用，挡不住改代码的人。
//
// 换口令 / 换密钥 / 续期：`node tools/seal-admin.mjs --gen <管理员密钥> [有效天数]`
// 会生成随机口令并打印新的 SALT / SEALED / TAG 常量，替换进下方即可。源码里永远不出现明文。

export const ADMIN_PREFIX = 'admin-';
export const ADMIN_PASSWORD_BODY = 8;          // 口令格式：admin-{8 位数字/字母}
export const SCRYPT_PARAMS = Object.freeze({ N: 65536, r: 8, p: 1, dkLen: 64 });

// 公开常量：盐（随机）、密封后的 JSON（base64）、密文 HMAC（base64）。
const SALT = 'dc+R+m/hKqqXUK5hJwYS7A==';
const SEALED = 'EunFWW0ntNueAwTNbrwgIPoZvu1owDT1ldCbbg7TS5zws1HaDCni7Pmxc/wpMhwwBONpkHUBhAjQsm+KGVgvgNQVy47THcxoWx3IXHoBJn+eN4cJTeS//DggONObSAvm9YC316YwyJ/J';
const TAG = '89eOHjngBpSisLFgjioingxzNwlLlA1AAvRMNxVB40I=';

const te = new TextEncoder();
const td = new TextDecoder();

// ── SHA-256 / HMAC：优先 WebCrypto（原生、快）；非安全上下文退回纯 JS（FIPS 180-4 / RFC 2104）──
let subtle = null;
try { subtle = (globalThis.crypto && globalThis.crypto.subtle) || null; } catch { subtle = null; }

async function hmacSha256(key, data) {
  if (subtle) {
    try {
      const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return new Uint8Array(await subtle.sign('HMAC', k, data));
    } catch { /* 退回纯 JS */ }
  }
  return hmacPure(key, data);
}

function hmacPure(key, data) {
  let k = key.length > 64 ? sha256Pure(key) : key;
  const kp = new Uint8Array(64); kp.set(k);
  const ipad = new Uint8Array(64 + data.length);
  const opad = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) { ipad[i] = kp[i] ^ 0x36; opad[i] = kp[i] ^ 0x5c; }
  ipad.set(data, 64);
  opad.set(sha256Pure(ipad), 64);
  return sha256Pure(opad);
}

function sha256Pure(bytes) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
    h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const len = bytes.length;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);
  const w = new Uint32Array(64);
  for (let i = 0; i < withPad.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = (rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((x, i) => new DataView(out.buffer).setUint32(i * 4, x, false));
  return out;
}
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

function b64ToBytes(b64) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  if (typeof btoa === 'function') { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
  return Buffer.from(bytes).toString('base64');
}
function concatBytes(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
function ctEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ── scrypt（RFC 7914）：PBKDF2-HMAC-SHA256(c=1) → ROMix(Salsa20/8 BlockMix) → PBKDF2 ──
async function pbkdf2One(pw, salt, dkLen) {
  const blocks = Math.ceil(dkLen / 32);
  const out = new Uint8Array(blocks * 32);
  for (let i = 1; i <= blocks; i++) {
    const msg = new Uint8Array(salt.length + 4);
    msg.set(salt, 0);
    msg[salt.length] = (i >>> 24) & 0xff; msg[salt.length + 1] = (i >>> 16) & 0xff;
    msg[salt.length + 2] = (i >>> 8) & 0xff; msg[salt.length + 3] = i & 0xff;
    out.set(await hmacSha256(pw, msg), (i - 1) * 32);
  }
  return out.subarray(0, dkLen);
}
const R = (a, b) => (a << b) | (a >>> (32 - b));
function salsa8(B, X) {
  for (let i = 0; i < 16; i++) X[i] = B[i];
  for (let i = 0; i < 8; i += 2) {
    X[4] ^= R(X[0] + X[12], 7); X[8] ^= R(X[4] + X[0], 9); X[12] ^= R(X[8] + X[4], 13); X[0] ^= R(X[12] + X[8], 18);
    X[9] ^= R(X[5] + X[1], 7); X[13] ^= R(X[9] + X[5], 9); X[1] ^= R(X[13] + X[9], 13); X[5] ^= R(X[1] + X[13], 18);
    X[14] ^= R(X[10] + X[6], 7); X[2] ^= R(X[14] + X[10], 9); X[6] ^= R(X[2] + X[14], 13); X[10] ^= R(X[6] + X[2], 18);
    X[3] ^= R(X[15] + X[11], 7); X[7] ^= R(X[3] + X[15], 9); X[11] ^= R(X[7] + X[3], 13); X[15] ^= R(X[11] + X[7], 18);
    X[1] ^= R(X[0] + X[3], 7); X[2] ^= R(X[1] + X[0], 9); X[3] ^= R(X[2] + X[1], 13); X[0] ^= R(X[3] + X[2], 18);
    X[6] ^= R(X[5] + X[4], 7); X[7] ^= R(X[6] + X[5], 9); X[4] ^= R(X[7] + X[6], 13); X[5] ^= R(X[4] + X[7], 18);
    X[11] ^= R(X[10] + X[9], 7); X[8] ^= R(X[11] + X[10], 9); X[9] ^= R(X[8] + X[11], 13); X[10] ^= R(X[9] + X[8], 18);
    X[12] ^= R(X[15] + X[14], 7); X[13] ^= R(X[12] + X[15], 9); X[14] ^= R(X[13] + X[12], 13); X[15] ^= R(X[14] + X[13], 18);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i] + X[i]) | 0;
}
function blockMix(B, Y, r, X, T) {
  const last = (2 * r - 1) * 16;
  for (let i = 0; i < 16; i++) T[i] = B[last + i];
  for (let i = 0; i < 2 * r; i++) {
    const o = i * 16;
    for (let k = 0; k < 16; k++) T[k] ^= B[o + k];
    salsa8(T, X);
    const dst = ((i & 1) === 0 ? (i >> 1) : (r + (i >> 1))) * 16;
    for (let k = 0; k < 16; k++) Y[dst + k] = T[k];
  }
}
function roMix(B, o, N, r, V) {
  const len = 32 * r;
  const X = new Uint32Array(16), T = new Uint32Array(16), Y = new Uint32Array(len);
  const Xb = new Uint32Array(len);
  for (let i = 0; i < len; i++) Xb[i] = B[o + i];
  for (let i = 0; i < N; i++) { V.set(Xb, i * len); blockMix(Xb, Y, r, X, T); Xb.set(Y); }
  for (let i = 0; i < N; i++) {
    const j = (Xb[(2 * r - 1) * 16] >>> 0) & (N - 1);
    const vo = j * len;
    for (let k = 0; k < len; k++) Xb[k] ^= V[vo + k];
    blockMix(Xb, Y, r, X, T); Xb.set(Y);
  }
  for (let i = 0; i < len; i++) B[o + i] = Xb[i];
}
/** scrypt(pw, salt) → dkLen 字节。导出以便测试与 Node `crypto.scryptSync` 逐字节比对。 */
export async function scrypt(pw, salt, { N, r, p, dkLen } = SCRYPT_PARAMS) {
  if (!(N > 1 && (N & (N - 1)) === 0)) throw new Error('scrypt N 必须是 2 的幂');
  const Bbytes = await pbkdf2One(pw, salt, p * 128 * r);
  const B = new Uint32Array(p * 32 * r);
  const dv = new DataView(Bbytes.buffer, Bbytes.byteOffset, Bbytes.byteLength);
  for (let i = 0; i < B.length; i++) B[i] = dv.getUint32(i * 4, true);
  const V = new Uint32Array(N * 32 * r);
  for (let i = 0; i < p; i++) roMix(B, i * 32 * r, N, r, V);
  const out = new Uint8Array(B.length * 4);
  const dv2 = new DataView(out.buffer);
  for (let i = 0; i < B.length; i++) dv2.setUint32(i * 4, B[i], true);
  return pbkdf2One(pw, out, dkLen);
}

/** 与加密密钥绑定的密钥流：k_i = HMAC(encKey, i)，依次拼接 */
async function keystream(encKey, length) {
  const out = new Uint8Array(length);
  let off = 0;
  for (let i = 0; off < length; i++) {
    const blk = await hmacSha256(encKey, te.encode(String(i)));
    const take = Math.min(blk.length, length - off);
    out.set(blk.subarray(0, take), off);
    off += take;
  }
  return out;
}

async function deriveKeys(pw, saltB64, params = SCRYPT_PARAMS) {
  const dk = await scrypt(te.encode(pw), b64ToBytes(saltB64), params);
  return { encKey: dk.slice(0, 32), macKey: dk.slice(32, 64) };
}

/**
 * 密封：把 {k, iat, exp} 用口令封起来（tools/seal-admin.mjs 与测试共用，保证算法只有一份）。
 * @returns {Promise<{salt:string, sealed:string, tag:string}>}
 */
export async function sealAdmin(pw, { key, iat = Date.now(), exp, days = 14, salt, params = SCRYPT_PARAMS } = {}) {
  if (!key) throw new Error('缺少管理员密钥');
  const saltBytes = salt ? b64ToBytes(salt) : (() => { const s = new Uint8Array(16); (globalThis.crypto || {}).getRandomValues ? globalThis.crypto.getRandomValues(s) : s.set(te.encode(String(Math.random()).slice(2, 18))); return s; })();
  const saltB64 = bytesToB64(saltBytes);
  const expiry = exp != null ? exp : iat + days * 86400000;
  const plain = te.encode(JSON.stringify({ k: key, iat, exp: expiry }));
  const { encKey, macKey } = await deriveKeys(pw, saltB64, params);
  const ks = await keystream(encKey, plain.length);
  const sealed = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) sealed[i] = plain[i] ^ ks[i];
  const tag = await hmacSha256(macKey, sealed);
  return { salt: saltB64, sealed: bytesToB64(sealed), tag: bytesToB64(tag), exp: expiry, iat };
}

// 解封后的管理员密钥只留在内存里（不落地、不导出）
let unlocked = null;     // 真密钥
let unlockedExp = 0;     // 到期时间（ms）

export function isAdminAlias(input) { return String(input || '').startsWith(ADMIN_PREFIX); }
export function adminUnlocked() { return !!unlocked && Date.now() <= unlockedExp; }
/** 已解封时返回到期时间（ms），否则 0 */
export function adminExpiresAt() { return unlocked ? unlockedExp : 0; }
/** 只有「当前会话已用正确口令解开且未过期」时，管理员别名才会被替换成真密钥 */
export function effectiveApiKey(raw) {
  const s = String(raw || '');
  if (!isAdminAlias(s) || !unlocked) return s;
  if (Date.now() > unlockedExp) { lockAdminKey(); return s; }   // 到期即失效，不等刷新
  return unlocked;
}
export function lockAdminKey() { unlocked = null; unlockedExp = 0; }

/**
 * 用输入的口令解封管理员密钥。
 * @param {string} input 用户输入（admin-…）
 * @param {{now?:number, bundle?:{salt:string, sealed:string, tag:string, params?:object}}} [opts] 测试注入
 * @returns {Promise<{ok:boolean, reason?:'not-admin'|'bad-password'|'unsupported'|'expired', exp?:number}>}
 */
export async function unlockAdminKey(input, opts = {}) {
  const s = String(input || '');
  if (!isAdminAlias(s)) return { ok: false, reason: 'not-admin' };
  const bundle = opts.bundle || { salt: SALT, sealed: SEALED, tag: TAG };
  if (!bundle.salt || !bundle.sealed || !bundle.tag || /^__/.test(bundle.sealed)) return { ok: false, reason: 'unsupported' };
  const now = opts.now != null ? opts.now : Date.now();
  let encKey, macKey;
  try { ({ encKey, macKey } = await deriveKeys(s, bundle.salt, bundle.params || SCRYPT_PARAMS)); }
  catch { return { ok: false, reason: 'unsupported' }; }
  const sealed = b64ToBytes(bundle.sealed);
  const tag = await hmacSha256(macKey, sealed);
  if (!ctEqual(tag, b64ToBytes(bundle.tag))) { lockAdminKey(); return { ok: false, reason: 'bad-password' }; }
  const ks = await keystream(encKey, sealed.length);
  const plain = new Uint8Array(sealed.length);
  for (let i = 0; i < sealed.length; i++) plain[i] = sealed[i] ^ ks[i];
  let obj;
  try { obj = JSON.parse(td.decode(plain)); } catch { lockAdminKey(); return { ok: false, reason: 'unsupported' }; }
  const exp = Number(obj && obj.exp) || 0;
  if (!obj || typeof obj.k !== 'string' || !exp) { lockAdminKey(); return { ok: false, reason: 'unsupported' }; }
  if (now > exp) { lockAdminKey(); plain.fill(0); return { ok: false, reason: 'expired', exp }; }
  unlocked = obj.k;
  unlockedExp = exp;
  plain.fill(0);
  return { ok: true, exp };
}
