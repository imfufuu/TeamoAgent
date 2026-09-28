// ─── 审核资产完整性（本地即可跑，无依赖）──────────────────────────────────
// 背景（2026-09-28 事故）：三条本地审核路径（NudeNet/NSFWJS/Toxicity+USE）在线上全部
// 静默失效，而 266 项单测全绿——因为单测 hook 掉了模型层，没人校验「资产本身能不能用」：
//   1. ort.wasm 1.17 在新版 Chromium 上 session 创建静默 abort（裸数字 reject）；
//   2. tf.min.js 内嵌 Function('return this') / Function('r',...) 触发 CSP，bundle 半途死掉，
//      globalThis.tf 变空壳 → loadGraphModel is not a function；
//   3. nsfwjs.load 缺 type:'graph'，用 loadLayersModel 打开 SavedModel → Improper config format；
//   4. text-toxic 的 7 个权重分片在 V1.3.1 入库时就是坏的（5.6KB、非 4 倍数字节）；
//   5. USE 词表无 CJK，中文输入嵌入恒定 → 语义层会拦截所有中文消息。
// 本文件把这些坑钉死：任何一处回退，立刻红灯。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const exists = (rel) => fs.existsSync(new URL(rel, import.meta.url));

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ✓ ${name}`); }
  catch (err) { failed++; results.push(`  ✗ ${name} — ${err.message}`); }
}
const group = (name) => results.push(name);

// ── vendor 运行时 ──
group('审核运行时资产');
await test('ORT 必须是 1.30 系（1.17 在新版 Chromium 静默 abort），且 glue/wasm 三件套同在', () => {
  for (const rel of ['../assets/vendor/ort.min.js', '../assets/vendor/ort-wasm-simd-threaded.mjs', '../assets/vendor/ort-wasm-simd-threaded.wasm']) {
    assert.ok(exists(rel), `${rel} 应随项目存在`);
  }
  const glue = read('../assets/vendor/ort.min.js');
  assert.match(glue, /ONNX Runtime Web v1\.3\d/i, 'glue 应为 1.30+');
  assert.doesNotMatch(glue, /ort-wasm\.min\.js|ort-wasm-simd\.wasm['"]/, '不得再引用 1.17 的 wasm 命名');
  assert.ok(fs.statSync(new URL('../assets/vendor/ort-wasm-simd-threaded.wasm', import.meta.url)).size > 10_000_000, 'wasm 二进制应完整（>10MB）');
});
await test('tf.min.js 是含 converter/layers 的完整版，且已免疫 CSP（无任何 Function 构造调用）', () => {
  const tf = read('../assets/vendor/tf.min.js');
  assert.match(tf, /loadGraphModel/, '缺 tfjs-converter：toxicity/USE 会挂');
  assert.match(tf, /loadLayersModel/, '缺 tfjs-layers：nsfwjs 会挂');
  for (const bad of ['Function("return this")', "Function('return this')", 'Function("r","regeneratorRuntime', /new Function\(/.source]) {
    assert.ok(!tf.includes(bad), `tf.min.js 含 CSP 炸点：${bad}（CSP 下 bundle 半途死掉，globalThis.tf 变空壳）`);
  }
});
await test('nsfwjs / toxicity / use 运行时无 Function 构造调用（CSP 安全）', () => {
  for (const rel of ['../assets/vendor/nsfwjs.min.js', '../assets/vendor/toxicity.local.min.js', '../assets/vendor/use.min.js']) {
    const src = read(rel);
    assert.ok(!src.includes('Function("return this")') && !src.includes("Function('return this')"), `${rel} 含 Function("return this") 炸点`);
  }
});

// ── 模型资产 ──
group('审核模型资产');
await test('NSFWJS mobilenet_v2_mid 为 SavedModel(graph-model)，与 moderation.js 的 type:"graph" 配对', () => {
  const model = JSON.parse(read('../assets/moderation/nsfw-mobilenet-v2-mid/model.json'));
  assert.equal(model.format, 'graph-model');
  const src = read('../js/moderation.js');
  assert.match(src, /type:\s*'graph'/, 'nsfwjs.load 缺 type:"graph" 会走 loadLayersModel → Improper config format');
  const shards = model.weightsManifest.flatMap((w) => w.paths);
  for (const s of shards) assert.ok(exists(`../assets/moderation/nsfw-mobilenet-v2-mid/${s}`), `权重分片缺失：${s}`);
});
await test('text-toxic 权重分片完整且 4 字节对齐（V1.3.1 入库时曾是 5.6KB 坏片）', () => {
  const model = JSON.parse(read('../assets/moderation/text-toxic/model.json'));
  const shards = model.weightsManifest.flatMap((w) => w.paths);
  assert.ok(shards.length >= 7, 'toxicity 应有 7 个分片');
  for (const s of shards) {
    const p = new URL(`../assets/moderation/text-toxic/${s}`, import.meta.url);
    assert.ok(fs.existsSync(p), `分片缺失：${s}`);
    const size = fs.statSync(p).size;
    assert.ok(size % 4 === 0, `分片 ${s} 字节数(${size}) 非 4 的倍数 —— tfjs 加载必炸 RangeError`);
    assert.ok(size > 1_000_000, `分片 ${s}(${size}B) 过小 —— 是坏片，官方分片约 4MB`);
  }
});
await test('text-use 权重分片 4 字节对齐，词表为拉丁词表', () => {
  const model = JSON.parse(read('../assets/moderation/text-use/model.json'));
  for (const s of model.weightsManifest.flatMap((w) => w.paths)) {
    const p = new URL(`../assets/moderation/text-use/${s}`, import.meta.url);
    assert.ok(fs.existsSync(p), `分片缺失：${s}`);
    const size = fs.statSync(p).size;
    assert.ok(size % 4 === 0, `分片 ${s}(${size}B) 非 4 倍数`);
  }
  const vocab = JSON.parse(read('../assets/moderation/text-use/vocab.json'));
  assert.ok(vocab.length >= 7000, 'USE 词表应约 8000 词条');
  const cjk = vocab.filter(([t]) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(t)).length;
  assert.equal(cjk, 0, 'USE 词表不应含 CJK；若换用多语言模型请同步改 semanticTextDecision 的 CJK 跳过逻辑');
});
await test('NudeNet ONNX 随项目存在且非文本损坏（ONX magic / 合理体积）', () => {
  const p = new URL('../assets/moderation/nudenet-320n/model.onnx', import.meta.url);
  assert.ok(fs.existsSync(p));
  const head = fs.readFileSync(p).slice(0, 64);
  assert.ok(head.includes(Buffer.from('onnx')), '不像 ONNX 文件');
  assert.ok(fs.statSync(p).size > 2_000_000, '模型体积异常');
});

// ── 代码层约定 ──
group('审核代码约定');
await test('NudeNet 推理分辨率必须是原生 320（224 会大幅丢召回）', () => {
  const src = read('../js/moderation.js');
  assert.match(src, /NUDENET_INPUT_SIZE = 320/);
  assert.doesNotMatch(src, /NUDENET_INPUT_SIZE = 224/);
});
await test('语义层必须有 CJK 跳过逻辑（否则中文会被恒定嵌入全类别误拦）', () => {
  const src = read('../js/moderation.js');
  assert.match(src, /cjk-unsupported/, 'semanticTextDecision 缺 CJK 跳过');
  const groups = src.slice(src.indexOf('const SEMANTIC_GROUPS'), src.indexOf('];', src.indexOf('const SEMANTIC_GROUPS')));
  assert.doesNotMatch(groups, /[\u3400-\u9fff]/, 'SEMANTIC_GROUPS 里不得再放中文原型短语（恒定嵌入，必误命中）');
});
await test('CSP 允许 wasm-unsafe-eval（ORT 需要），index 页维持最严 CSP', () => {
  const app = read('../app.html');
  assert.match(app, /wasm-unsafe-eval/);
});
await test('.gitattributes 把权重分片与 wasm 标记为 binary，防止再被换行转换毁掉', () => {
  const ga = read('../.gitattributes');
  assert.match(ga, /group\*?\s+binary/);
  assert.match(ga, /\.wasm\s+binary/);
});

// ── β 调试浮窗（2026.9.27.13）──
group('β 调试浮窗');
await test('debugwindow.js 随项目存在，main.js 挂载且入口齐全（?debug=1 / Ctrl+Alt+D / ⌘K 桥）', () => {
  assert.ok(exists('../js/debugwindow.js'), 'js/debugwindow.js 应随项目存在');
  const main = read('../js/main.js');
  assert.match(main, /debugwindow\.js\?v=/, 'main.js 应带 ?v= 引入 debugwindow');
  assert.match(main, /mountDebugWindow\(\)/);
  assert.match(main, /toggleDebug\(\)/);
  const dw = read('../js/debugwindow.js');
  assert.match(dw, /__teamoDebugToggle/, 'debugwindow 应暴露 ⌘K 桥');
  assert.match(dw, /__teamoDebugLog/, 'debugwindow 应暴露日志桥');
  assert.match(dw, /__teamoModSubscribe/, 'debugwindow 应订阅审核日志');
  const ui = read('../js/ui.js');
  assert.match(ui, /p:debug/, '⌘K 命令面板应有调试浮窗入口');
});

console.log(results.join('\n'));
console.log(`\n审核资产完整性：${passed} 通过 / ${failed} 失败 ${failed === 0 ? '✅' : '❌'}`);
process.exit(failed === 0 ? 0 : 1);
