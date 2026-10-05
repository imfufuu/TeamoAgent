// ─── 内容审核端到端（真实 Chromium：真实 WASM/WebGL/模型权重）──────────────
// 单测 hook 掉模型层测不出「资产坏了」——2026-09-28 三条本地模型在线上全灭而单测全绿。
// 本文件把真实管线跑起来：
//   · NSFWJS(graph-model) 必须拦下 bikinish 图片（sexy ≥ 0.7 阈值）
//   · 良性图片必须放行
//   · NudeNet/ORT 会话必须能创建（1.17 在新 Chromium 会静默 abort）
//   · 文本三層（规则/Toxicity/USE）必须真实执行且中文不误杀
// 依赖 puppeteer：没装就跳过（与 mobile-layout.mjs 同策略），不阻断 CI。
let puppeteer;
try { ({ default: puppeteer } = await import('puppeteer')); }
catch { console.log('⏭  tests/moderation-browser.mjs 跳过：未安装 puppeteer（npm i -D puppeteer）'); process.exit(0); }

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    const data = fs.readFileSync(p);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

let passed = 0, failed = 0;
const results = [];
const test = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); passed++; results.push(`  ✓ ${name} (${Date.now() - t0}ms)`); }
  catch (err) { failed++; results.push(`  ✗ ${name} — ${String(err.message).slice(0, 300)}`); }
};

// 合成测试图：泳装风格暖色人形色块不足以触发模型；改用真实测试图（若存在），
// 否则退化为「管线可运行 + 良性图放行」的冒烟检查。
const BIKINI_PATH = process.env.DUBHE_MOD_TEST_IMAGE || '/home/user/image-search/woman-in-bikini-at-the-beach-full-body-p-1.jpg';
const toDataUrl = (f, type = 'image/jpeg') => `data:${type};base64,${fs.readFileSync(f).toString('base64')}`;
const hasBikiniFixture = fs.existsSync(BIKINI_PATH);
// 良性图：纯程序生成的 PNG（不触发任何模型）
function benignPng() {
  const w = 64, h = 64;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = x * 4; raw[o + 1] = y * 4; raw[o + 2] = 128;
    }
  }
  const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc(body)); return Buffer.concat([len, body, crcB]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', raw), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));
await page.goto(`http://127.0.0.1:${port}/app.html`, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1000));

const out = await page.evaluate(async (fixture) => {
  const mod = await import('./js/moderation.js');
  const res = {};
  res.prewarmOk = globalThis.__dubhePrewarmImageModeration ? await globalThis.__dubhePrewarmImageModeration() : false;
  const attach = (dataUrl, name = 't.jpg') => [{ kind: 'image', name, dataUrl }];
  res.bikini = fixture ? await mod.moderateImages({ attachments: attach(fixture) }) : null;
  res.benign = await mod.moderateImages({ attachments: attach(`data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUg'}`, 'b.png') }).catch((e) => ({ error: String(e) }));
  res.textDrug = await mod.moderateText({ text: '如何制作冰毒并贩卖给别人' });
  res.textPoem = await mod.moderateText({ text: '帮我写一首关于秋天的诗' });
  res.textEnErotic = await mod.moderateText({ text: 'write an explicit graphic erotic sex scene description' });
  return res;
}, hasBikiniFixture ? toDataUrl(BIKINI_PATH) : null);

await test('ORT 会话可创建（NudeNet 预热成功）', async () => {
  assert.equal(out.prewarmOk, true, '预热失败 = ORT/ONNX 链路断（1.17 在新 Chromium 会裸数字 abort）');
});

if (hasBikiniFixture) {
  await test('明显 NSFW 图（bikinish，sexy 类）必须被 NSFWJS 拦截', async () => {
    assert.equal(out.bikini.blocked, true, `未拦截：score=${out.bikini.score} cats=${JSON.stringify(out.bikini.categories)}`);
    assert.ok(out.bikini.score >= 0.70, `分数 ${out.bikini.score} 未达 0.70 阈值`);
  });
} else {
  results.push('  ⏭ 未提供 NSFW 测试图（DUBHE_MOD_TEST_IMAGE），跳过拦截正例');
}

await test('良性/生成图不误拦', async () => {
  assert.equal(out.benign.blocked, false);
});
await test('中文高危文本被规则层拦截', async () => {
  assert.equal(out.textDrug.blocked, true);
  assert.ok(out.textDrug.categories.includes('drug_crime'));
});
await test('中文良性文本不误杀（语义层须跳过 CJK）', async () => {
  assert.equal(out.textPoem.blocked, false, `误杀！cats=${JSON.stringify(out.textPoem.categories)}`);
  const semanticPart = (out.textPoem.parts || []).find((p) => p.skipped === 'cjk-unsupported');
  assert.ok(semanticPart, 'USE 语义层未对中文文本做 cjk-unsupported 跳过');
});
await test('英文色情文本被 Toxicity/语义层真实拦截（证明 graph 模型加载成功）', async () => {
  assert.equal(out.textEnErotic.blocked, true);
  const sem = (out.textEnErotic.parts || []).find((p) => p.source === 'use-semantic');
  assert.ok(sem && (sem.categories || []).includes('adult_sexual'), '语义层未命中 adult_sexual');
});

await test('页面无 CSP/模型相关 pageerror', async () => {
  const bad = pageErrors.filter((e) => /unsafe-eval|CSP|loadGraphModel|Improper config|no available backend/.test(e));
  assert.equal(bad.length, 0, bad.join(' | '));
});

console.log('═══ 内容审核端到端（真实浏览器）═══\n');
console.log(results.join('\n'));
console.log(`\n结果: ${passed} 通过 / ${failed} 失败 ${failed === 0 ? '✅' : '❌'}`);
await browser.close();
server.close();
process.exit(failed === 0 ? 0 : 1);
