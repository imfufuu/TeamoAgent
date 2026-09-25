// ─── 管理员密钥：源码里既没有明文密钥，也没有明文口令 ──────────────────
//
// 需求：在 API Key 输入框里填 `admin-…` 时，实际请求要换成另一把管理员密钥。
// 最直白的写法是 `if (输入 === '管理员口令') return '管理员密钥'` ——
// 那等于把「口令 + 密钥」明文一起放进公开仓库，任何人翻一遍源码就拿到了。这里改成：
//
//   ① 源码只存口令的**拉伸哈希**（50,000 轮 SHA-256）——不可逆，也没有明文字符；
//   ② 管理员密钥用**口令派生的密钥流**异或后以 base64 存放（SEALED）——
//      不知道口令就还原不出密钥，连密钥长什么样都看不出来；
//   ③ 还原只发生在内存：解封后的密钥只存在本模块的变量里，不写 localStorage、
//      不进导出 JSON、不进控制台、不渲染到界面（界面只显示「管理员密钥已启用」）；
//   ④ 50,000 轮拉伸让离线暴力破解的单价抬高 5 万倍。
//      诚实说明：密钥终究是客户端秘密，谁能输入口令谁就能拿到它（这是需求本身），
//      真正做到服务端级隔离需要走中继。README 里如实写了这一点。
//
// 换口令 / 换密钥：`node tools/seal-admin.mjs <口令> <管理员密钥>` 生成新的两个常量。

export const ADMIN_PREFIX = 'admin-';

// 口令哈希（sha256 迭代 50000 轮的十六进制）与密封后的管理员密钥（base64）
const PW_HASH = '2943983159fb5841cd1687984c0b3ce28c39fd85dd64eaabaf42769a5057bb53';
const SEALED = 'Gy+kgayS8peH/L0EijuVwc4vx3ld188XTXgcvZAx1FWvai9tIaPsn0oDhoIC5wF1o58dV6z6VsXD';
const STRETCH_ROUNDS = 50000;

const te = new TextEncoder();
const td = new TextDecoder();

// ── SHA-256：优先用 WebCrypto（走浏览器/Node 的原生实现，快）；不可用时退回纯 JS ──
let subtle = null;
try { subtle = (globalThis.crypto && globalThis.crypto.subtle) || null; } catch { subtle = null; }

async function sha256(bytes) {
  if (subtle) return new Uint8Array(await subtle.digest('SHA-256', bytes));
  return sha256Pure(bytes);
}

// 纯 JS 兜底（非安全上下文 / 老浏览器）。实现为标准 FIPS 180-4。
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
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function b64ToBytes(b64) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 口令拉伸：h0 = sha256(pw)，h_{i+1} = sha256(h_i)，共 STRETCH_ROUNDS 轮 */
async function stretch(pw) {
  let h = await sha256(te.encode(pw));
  for (let i = 1; i < STRETCH_ROUNDS; i++) h = await sha256(h);
  return h;
}

/**
 * 与口令绑定的密钥流：k_i = sha256(h ‖ i)，其中 h 是**拉伸后**的摘要。
 * 关键点：每一段密钥流都要先算出 h，所以「猜一个口令」的代价 = 整整 STRETCH_ROUNDS 轮哈希，
 * 而不是 1 轮（若直接用原始口令做密钥流，拿着仓库的人一秒能试几百万个候选口令）。
 * 合法用户没有额外开销：解封时本来就要算这个 h。
 */
async function keystream(h, length) {
  const out = new Uint8Array(length);
  let off = 0;
  for (let i = 0; off < length; i++) {
    const blk = await sha256(concatBytes(h, te.encode(String(i))));
    const take = Math.min(blk.length, length - off);
    out.set(blk.subarray(0, take), off);
    off += take;
  }
  return out;
}

function concatBytes(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

// 解封后的管理员密钥只留在内存里（不落地、不导出）
let unlocked = null;

export function isAdminAlias(input) { return String(input || '').startsWith(ADMIN_PREFIX); }
export function adminUnlocked() { return !!unlocked; }
/** 只有「当前会话已用正确口令解开」时，管理员别名才会被替换成真密钥 */
export function effectiveApiKey(raw) {
  const s = String(raw || '');
  return isAdminAlias(s) && unlocked ? unlocked : s;
}
export function lockAdminKey() { unlocked = null; }

/**
 * 用输入的口令解封管理员密钥。
 * @returns {Promise<{ok:boolean, reason?:'not-admin'|'bad-password'|'unsupported'}>}
 */
export async function unlockAdminKey(input) {
  const s = String(input || '');
  if (!isAdminAlias(s)) return { ok: false, reason: 'not-admin' };
  if (!PW_HASH || !SEALED) return { ok: false, reason: 'unsupported' };
  const h = await stretch(s);
  const got = hex(h);
  if (got !== PW_HASH) { unlocked = null; return { ok: false, reason: 'bad-password' }; }
  const sealed = b64ToBytes(SEALED);
  const ks = await keystream(h, sealed.length);
  const plain = new Uint8Array(sealed.length);
  for (let i = 0; i < sealed.length; i++) plain[i] = sealed[i] ^ ks[i];
  unlocked = td.decode(plain);
  return { ok: true };
}
