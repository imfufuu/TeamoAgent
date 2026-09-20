// ─── 真实网关系统测试（可选，默认跳过）─────────────────────────────────
// 用法：TEAMO_API_KEY=sk-teamo-xxx node tests/live-check.mjs
// 未设置 key 时直接跳过，因此不会干扰离线单测与 CI。
//
// 覆盖此前线上报错的两条路径：
//   1) 模型名归一：LLM 传显示名（"2.5 Sunburst"）不再被原样发给网关（实测 400）
//   2) 响应解析：任何异常都带上下文（HTTP 码 / 响应字段 / 原始片段），不再是「缺少 data[0]」
// 外加：三模型出图、图片编辑、多张候选、webp/透明底、真实 Agent 工具循环。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const KEY = process.env.TEAMO_API_KEY || '';
const CHAT_MODEL = process.env.TEAMO_CHAT_MODEL || 'claude-sonnet-5';
const OUT_DIR = process.env.TEAMO_LIVE_OUT || '/tmp/teamo-live';

if (!KEY) {
  console.log('⏭  tests/live-check.mjs 跳过：未设置 TEAMO_API_KEY（真实网关测试需显式提供 key）');
  process.exit(0);
}
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
fs.mkdirSync(OUT_DIR, { recursive: true });

const { executeTool } = await import('../js/tools.js');
const { createFS } = await import('../js/sandbox.js');
const { createStore } = await import('../js/state.js');
const { createAgent } = await import('../js/agent.js');
const { generateImage, sniffImage } = await import('../js/api.js');
const cfg = await import('../js/config.js');

let pass = 0;
let total = 0;
const results = [];
const t0all = Date.now();

function magicOk(dataUrl, ext) {
  const comma = dataUrl.indexOf(',');
  const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  const head = bytes.subarray(0, 4).toString('latin1');
  const sig = { png: '\x89PNG', jpg: '\xff\xd8\xff\xe0', jpeg: '\xff\xd8\xff\xe0', webp: 'RIFF' }[ext === 'jpg' ? 'jpg' : ext];
  const ok = ext.startsWith('jp') ? bytes[0] === 0xff && bytes[1] === 0xd8 : head.startsWith(sig);
  return { ok, bytes: bytes.length, sniff: sniffImage(bytes) };
}

async function step(name, fn) {
  total++;
  const t0 = Date.now();
  try {
    const info = await fn();
    pass++;
    results.push({ name, ok: true, ms: Date.now() - t0, ...info });
    console.log(`  ✓ ${name}（${((Date.now() - t0) / 1000).toFixed(1)}s）${info && info.line ? ' — ' + info.line : ''}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.message || e) });
    console.log(`  ✗ ${name}\n      ${String(e && e.message || e).slice(0, 400)}`);
    process.exitCode = 1;
  }
}

function ctxFor(fsObj, imageModel) {
  const events = [];
  return { ctx: { fs: fsObj, apiKey: KEY, imageModel, onUi: (p) => events.push(p), signal: undefined }, events };
}

console.log('真实网关系统测试（POST /v1/images/*）');

// ── 1. 三个生图模型逐个出图（用户报错的第一现场）──
const sandboxes = {};
for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
  await step(`生成：${model}`, async () => {
    const fsObj = createFS();
    sandboxes[model] = fsObj;
    const { ctx } = ctxFor(fsObj, model);
    const res = await executeTool('generate_image', { prompt: '一只在键盘上打字的橘猫，扁平插画风格', size: '1024x1024', quality: 'low' }, ctx);
    assert.ok(!/调用失败/.test(res), `工具返回失败：${res.slice(0, 240)}`);
    const path = /outputs\/image-\d{3}\.\w+/.exec(res)?.[0];
    assert.ok(path, `返回文案未包含沙箱路径：${res.slice(0, 200)}`);
    const dataUrl = fsObj.read(path);
    assert.match(dataUrl, /^data:image\//, '沙箱内应为图片 data URL');
    const { ok, bytes, sniff } = magicOk(dataUrl, path.split('.').pop());
    assert.ok(ok, `字节魔数与扩展名不符：${path}`);
    assert.ok(sniff.width === 1024 && sniff.height === 1024, `实际尺寸应为 1024x1024，实测 ${sniff.width}x${sniff.height}`);
    fs.writeFileSync(`${OUT_DIR}/${model}.png`, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    return { line: `${path} · ${(bytes / 1024).toFixed(0)}KB · ${sniff.width}x${sniff.height}`, bytes, dims: `${sniff.width}x${sniff.height}` };
  });
}

// ── 2. 显示名归一（复现 "模型 '2.5 Sunburst' 暂不可用"）──
await step('生成：LLM 误传显示名 "2.5 Sunburst" → 自动纠正后成功', async () => {
  const fsObj = createFS();
  const { ctx } = ctxFor(fsObj, 'gpt-image-2');
  const res = await executeTool('generate_image', { prompt: '一颗红色立方体，白底', quality: 'low', size: '1024x1024', model: '2.5 Sunburst' }, ctx);
  assert.ok(!/调用失败/.test(res), `仍失败：${res.slice(0, 300)}`);
  assert.match(res, /gpt-image-2\.5-sunburst/, '应说明已解析为真实 ID');
  assert.match(res, /解析为/, '应把纠正过程回灌给模型');
  return { line: '纠正为 gpt-image-2.5-sunburst' };
});

await step('未知模型名（"图片模型Pro"）→ 退回会话模型而非透传 400', async () => {
  const fsObj = createFS();
  const { ctx } = ctxFor(fsObj, 'gpt-image-2');
  const res = await executeTool('generate_image', { prompt: '一颗蓝色球体', quality: 'low', size: '1024x1024', model: '图片模型Pro' }, ctx);
  assert.ok(!/调用失败/.test(res), `失败：${res.slice(0, 300)}`);
  assert.match(res, /不是合法的生图模型 ID/, '应提示模型名非法');
  return { line: '已退回 gpt-image-2 并告知模型改用 ID' };
});

// ── 3. 图片编辑（/v1/images/edits）：以第 1 步产物为原图 ──
await step('编辑：reference_paths 指向沙箱内上一轮产物', async () => {
  const src = 'gpt-image-2';
  const fsObj = sandboxes[src];
  const before = fsObj.list().length;
  const { ctx } = ctxFor(fsObj, src);
  const res = await executeTool('generate_image', { prompt: '把画面整体改成夜晚霓虹配色，其余保持不变', reference_paths: ['outputs/image-001.png'], quality: 'low' }, ctx);
  assert.ok(!/调用失败/.test(res), `编辑失败：${res.slice(0, 300)}`);
  assert.match(res, /图像编辑完成/);
  assert.ok(fsObj.list().length === before + 1, '编辑结果应新增一个沙箱文件');
  const dataUrl = fsObj.read('outputs/image-002.png');
  const { ok, bytes } = magicOk(dataUrl, 'png');
  assert.ok(ok, '编辑结果字节非 PNG');
  fs.writeFileSync(`${OUT_DIR}/edited.png`, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  return { line: `outputs/image-002.png · ${(bytes / 1024).toFixed(0)}KB` };
});

// ── 4. 格式 / 透明底 / 多张 ──
await step('webp + 透明底 + n=2：全部落盘且魔数一致', async () => {
  const fsObj = createFS();
  const { ctx } = ctxFor(fsObj, 'gpt-image-2');
  const res = await executeTool('generate_image', { prompt: '一个绿色圆锥体，无背景', size: '1024x1024', quality: 'low', output_format: 'webp', background: 'transparent', n: 2 }, ctx);
  assert.ok(!/调用失败/.test(res), `失败：${res.slice(0, 300)}`);
  const pngs = fsObj.list().filter((f) => f.path.startsWith('outputs/'));
  assert.equal(pngs.length, 2, `n=2 应写入两张，实际 ${pngs.length}`);
  assert.match(res, /共 2 张/);
  for (const f of pngs) {
    const url = fsObj.read(f.path);
    const { ok, sniff } = magicOk(url, f.path.split('.').pop());
    assert.ok(ok, `${f.path} 魔数与扩展名不符`);
    assert.ok(sniff.width === 1024 && sniff.height === 1024, `${f.path} 尺寸异常`);
    fs.writeFileSync(`${OUT_DIR}/multi-${f.path.split('/').pop()}`, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  }
  return { line: pngs.map((p) => p.path).join('、') };
});

// ── 5. 错误可读性：非法模型 ID 必须带上下文，而不是「缺少 data[0]」──
await step('错误可读性：未知 ID 的报错包含网关原文与 HTTP 码', async () => {
  await assert.rejects(
    () => generateImage({ model: 'gpt-image-9', apiKey: KEY, prompt: 'x', size: '1024x1024', quality: 'low' }),
    (e) => {
      assert.match(e.message, /HTTP 400/);
      assert.match(e.message, /暂不可用/);
      assert.equal(/缺少 data/.test(e.message), false, '不应再退化成「缺少 data[0]」');
      return true;
    },
  );
  return { line: 'HTTP 400 + 模型不可用原文' };
});

// ── 6. 真实 Agent 工具循环（对话模型自己选生图模型）──
await step('Agent 循环：用户用中文说「用 2.5 Flare 画…」，工具调用应命中真实 ID', async () => {
  const store = createStore();
  store.state.apiKey = KEY;
  store.state.model = CHAT_MODEL;
  store.state.imageModel = 'gpt-image-2';
  store.state.settings = { ...store.state.settings, sandboxEnabled: true };
  const calls = [];
  const agent = createAgent(store, {
    onToolStart: (c) => calls.push({ name: c.name, args: { ...(c.args || {}) } }),
    onToolEvent: (c, p) => { if (p && p.imagePath) calls.push({ imagePath: p.imagePath, width: p.width, height: p.height }); },
  });
  await agent.send('用 2.5 Flare 这个生图模型画一张图：一杯冒热气的咖啡，扁平插画风格。尺寸 1024x1024，质量 low。直接把图放进沙箱即可，不用长篇解释。');
  const gen = calls.find((c) => c.name === 'generate_image');
  assert.ok(gen, `模型未调用 generate_image（工具调用：${calls.map((c) => c.name || c.imagePath).join(', ') || '无'}）`);
  const sent = String(gen.args.model || store.state.imageModel);
  const resolved = cfg.resolveImageModel(sent).id;
  assert.ok(cfg.isImageGenModel(resolved), `最终模型 ID 非法：${sent} → ${resolved}`);
  const shot = calls.find((c) => c.imagePath);
  assert.ok(shot, '应有一张图写入沙箱');
  const dataUrl = store.state.files[shot.imagePath];
  assert.ok(/^data:image\//.test(String(dataUrl || '')), '沙箱内应能读到图片 data URL');
  return { line: `args.model=${gen.args.model === undefined ? '（缺省，沿用会话 gpt-image-2）' : gen.args.model} → ${resolved} · ${shot.imagePath}` };
});

// ── 7. 探测（不判定）：网关目录里的 gemini-3.1-flash-image 是否兼容 Images 端点 ──
await step('探测：gemini-3.1-flash-image 走 /v1/images/generations 的支持情况', async () => {
  try {
    const out = await generateImage({ model: 'gemini-3.1-flash-image', apiKey: KEY, prompt: '一个红色立方体', size: '1024x1024', quality: 'low' });
    assert.ok(out.dataUrl.startsWith('data:image/'));
    return { line: '可用（可考虑并入 IMAGE_MODELS）' };
  } catch (e) {
    return { line: `不可用：${String(e.message).slice(0, 120)}（保持不接入，符合预期）` };
  }
});

console.log(`\n真实网关测试完成：${pass}/${total} 通过，总耗时 ${((Date.now() - t0all) / 1000).toFixed(1)}s，产物在 ${OUT_DIR}`);
fs.writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify({ at: new Date().toISOString(), key: `${KEY.slice(0, 12)}…`, results }, null, 2));
