#!/usr/bin/env node
// ─── 生成管理员密钥的密封常量 ───────────────────────────────────────────
// 用法：node tools/seal-admin.mjs <口令> [管理员密钥]
//   只给口令 → 打印 PW_HASH（换口令用）
//   给两个参数 → 打印 PW_HASH 与 SEALED（换密钥用）
// 把输出替换进 js/adminkey.js 的两个常量即可。源码里永远不出现明文。
//
// 与 js/adminkey.js 保持完全一致的算法：
//   拉伸：h0 = sha256(pw)，h_{i+1} = sha256(h_i)，共 50000 轮
//   密钥流：k_i = sha256(h ‖ i)（h = 拉伸后的摘要），依次拼接后与密钥字节异或
import crypto from 'node:crypto';

const ROUNDS = 50000;
const sha = (b) => crypto.createHash('sha256').update(b).digest();

function stretch(pw) {
  let h = sha(Buffer.from(pw, 'utf8'));
  for (let i = 1; i < ROUNDS; i++) h = sha(h);
  return h;
}
function keystream(h, len) {          // h = 拉伸后的 32 字节摘要
  const out = [];
  for (let i = 0; out.length < len; i++) out.push(...sha(Buffer.concat([h, Buffer.from(String(i), 'utf8')])));
  return Buffer.from(out.slice(0, len));
}

const [pw, key] = process.argv.slice(2);
if (!pw) {
  console.error('用法：node tools/seal-admin.mjs <口令> [管理员密钥]');
  process.exit(2);
}
const h = stretch(pw);
const hash = h.toString('hex');
console.log(`PW_HASH = '${hash}'`);
if (!key) {
  console.log('（只给了口令：把它换进 js/adminkey.js 的 PW_HASH。换了口令必须重新生成 SEALED，否则解封会失败。）');
  process.exit(0);
}
const kb = Buffer.from(key, 'utf8');
const ks = keystream(h, kb.length);
const sealed = Buffer.alloc(kb.length);
for (let i = 0; i < kb.length; i++) sealed[i] = kb[i] ^ ks[i];
console.log(`SEALED  = '${sealed.toString('base64')}'`);
console.log(`\n自检：口令解封 → ${Buffer.from(sealed.map((b, i) => b ^ ks[i])).toString('utf8') === key ? '一致 ✅' : '不一致 ❌'}`);
