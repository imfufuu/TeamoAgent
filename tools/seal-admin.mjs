#!/usr/bin/env node
// ─── 生成 / 续期管理员密钥的密封常量 ──────────────────────────────────────
// 用法：
//   node tools/seal-admin.mjs --gen <管理员密钥> [有效天数=14]     随机生成 admin-{8 位数字/字母} 口令并密封
//   node tools/seal-admin.mjs <口令> <管理员密钥> [有效天数=14]    用指定口令密封（口令必须 admin- 开头）
// 输出 SALT / SEALED / TAG 三个常量，替换进 js/adminkey.js；口令只打印一次，自己收好。
// 算法与 js/adminkey.js 完全同源（直接 import sealAdmin），并用 Node 原生 scrypt 做一次交叉自检。
import crypto from 'node:crypto';
import { sealAdmin, unlockAdminKey, scrypt, SCRYPT_PARAMS, ADMIN_PREFIX, ADMIN_PASSWORD_BODY } from '../js/adminkey.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // 去掉 0/O/1/l/I，避免抄错
function genPassword() {
  const bytes = crypto.randomBytes(ADMIN_PASSWORD_BODY * 4);
  let s = '';
  for (let i = 0; s.length < ADMIN_PASSWORD_BODY; i++) {
    const v = bytes.readUInt32LE(i * 4);
    if (v < Math.floor(0x100000000 / ALPHABET.length) * ALPHABET.length) s += ALPHABET[v % ALPHABET.length];
  }
  return ADMIN_PREFIX + s;
}

const argv = process.argv.slice(2);
let pw, key, days;
if (argv[0] === '--gen') { pw = genPassword(); key = argv[1]; days = Number(argv[2] || 14); }
else { [pw, key] = argv; days = Number(argv[2] || 14); }
if (!pw || !key) {
  console.error('用法：node tools/seal-admin.mjs --gen <管理员密钥> [有效天数]\n      node tools/seal-admin.mjs <口令> <管理员密钥> [有效天数]');
  process.exit(2);
}
if (!pw.startsWith(ADMIN_PREFIX)) { console.error(`口令必须以 ${ADMIN_PREFIX} 开头`); process.exit(2); }
if (!(days > 0)) { console.error('有效天数必须 > 0'); process.exit(2); }

// 交叉自检：纯 JS scrypt 与 Node 原生 scrypt 必须逐字节一致
const salt = crypto.randomBytes(16);
const ours = await scrypt(Buffer.from(pw, 'utf8'), salt, SCRYPT_PARAMS);
const ref = crypto.scryptSync(pw, salt, SCRYPT_PARAMS.dkLen, { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: 512 * 1024 * 1024 });
if (!Buffer.from(ours).equals(ref)) { console.error('scrypt 自检失败：JS 实现与 Node 不一致'); process.exit(1); }

const t0 = performance.now();
const out = await sealAdmin(pw, { key, days, salt: salt.toString('base64') });
const sealMs = Math.round(performance.now() - t0);
const t1 = performance.now();
const check = await unlockAdminKey(pw, { bundle: { salt: out.salt, sealed: out.sealed, tag: out.tag } });
const verifyMs = Math.round(performance.now() - t1);
const bad = await unlockAdminKey(pw.slice(0, -1) + (pw.endsWith('x') ? 'y' : 'x'), { bundle: { salt: out.salt, sealed: out.sealed, tag: out.tag } });
const expired = await unlockAdminKey(pw, { bundle: { salt: out.salt, sealed: out.sealed, tag: out.tag }, now: out.exp + 1 });

console.log(`口令（只显示这一次）：${pw}`);
console.log(`有效期：${new Date(out.iat).toISOString()} → ${new Date(out.exp).toISOString()}（${days} 天）`);
console.log('');
console.log(`const SALT = '${out.salt}';`);
console.log(`const SEALED = '${out.sealed}';`);
console.log(`const TAG = '${out.tag}';`);
console.log('');
console.log(`自检：正确口令解封 ${check.ok ? '✅' : '❌'}（${verifyMs}ms） · 错口令拒绝 ${bad.ok === false && bad.reason === 'bad-password' ? '✅' : '❌'} · 过期拒绝 ${expired.reason === 'expired' ? '✅' : '❌'} · 密封耗时 ${sealMs}ms`);
