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
  assert.match(dw, /tdw-rz/, '浮窗应有四角缩放手柄');
  assert.match(dw, /tdw-entry/, '应有常驻快捷入口');
  assert.match(dw, /copySelected|data-act="copy"/, '应支持复制导出');
  assert.match(dw, /transformOrigin/, '关闭应有最小化动画');
  const ui = read('../js/ui.js');
  const state = read('../js/state.js');
  const html = read('../app.html');
  const icons = read('../js/icons.js');
  const css0 = read('../css/styles.css');
  assert.match(ui, /p:debug/, '⌘K 命令面板应有调试浮窗入口');
  // 2026.9.27.18：数学守卫 / system 输出格式化 / 文档页 / 搜索清空
  assert.match(ui, /行内代码先剥离/, '行内代码必须先于数学提取剥离');
  assert.match(ui, /MATH_REJECT/, '数学段守卫应存在');
  assert.match(ui, /mathOk\(x\) \? pushMath/, '单 $ 与 $$ 提取都应过守卫');
  assert.match(ui, /uE000IC/, '行内代码应走占位恢复链');
  assert.match(ui, /function sysReplyHtml/, '/system 回复应有格式化器');
  assert.match(ui, /m\.model === '__system__' \? sysReplyHtml/, 'system 回复应走格式化渲染');
  assert.match(ui, /syncCapLine\(\); \/\/ 能力行/, '进通道应刷新能力行');
  assert.match(ui, /'<span class="dd-item-id mono">system-commands<\/span>'/, '菜单条目应为英文且无图标');
  assert.match(ui, /dd-group-title', '<span>Teamo<\/span>'\)\);/, '分组标题应为 Teamo');
  assert.match(ui, /model-search-clear/, '搜索清空按钮应接线');
  assert.ok(exists('../docs.html'), 'docs.html 文档页应存在');
  const docs = read('../docs.html');
  for (const sec of ['更新日志', '用户协议', '服务条款', '隐私政策', 'V1.0', 'V1.3 β .18']) {
    assert.ok(docs.includes(sec), `docs.html 缺少：${sec}`);
  }
  assert.match(html, /docs\.html/, '应用页应有文档入口');
  // 2026.9.27.17：/system 隔离 / debug 打磨 / 思考流修复 / 状态栏动效
  assert.match(main, /onReasoning: \(m, text\) => ui && ui\.onReasoning/, '思考流事件必须接到 UI（否则不流式）');
  assert.match(ui, /let preSystem/, '/system 通道应有现场隔离');
  assert.match(ui, /applySystemLock/, '通道内应锁定思考/沙箱/会话');
  assert.match(ui, /pre\.textContent = m\.reasoning/, '流式思考应只更新 pre 文本（防逐帧重建）');
  assert.match(ui, /setInterval\(paintElapsed, 100\)/, '状态栏 ticker 只应刷新耗时（不动 DOTS）');
  assert.equal(/sys-gear">⚙/.test(ui), false, '系统图标不应再用 emoji，应使用 ICON.system');
  assert.match(ui, /ICON\.system/, '系统命令识别器应使用专用图标');
  assert.equal(/dd-item-hint/.test(ui), false, '菜单条目应简约（无介绍文案）');
  assert.match(ui, /name === 'cache'/, '/cache 命令应存在');
  assert.match(ui, /name === 'theme'/, '/theme 命令应存在');
  assert.match(ui, /name === 'export'/, '/export 命令应存在');
  assert.match(state, /state\.model === '__system__'\) return/, 'commit 应对 __system__ 跳过（真实会话零写入）');
  assert.match(dw, /wrapNetworkAndGlobals/, '调试浮窗应覆盖 fetch/全局错误');
  assert.match(dw, /pendingLines/, '调试日志应批量上屏（防流式卡顿）');
  assert.match(dw, /已复制/, '复制应有反馈');
  assert.equal(/data-act="collapse"/.test(dw), false, '收起按钮应已删除');
  assert.match(dw, /entryEl\.style\.display = 'none'/, '/debug off 应隐藏调试入口按钮');
  assert.match(icons, /system: ico/, 'icons 应含 system 图标');
  assert.match(css0, /sys-locked/, '锁定态样式应存在');
  // 2026.9.27.16：SW 离线缓存 / 颜色语法 / 思考标题 / /system 通道 / 加密徽章 / 文件行折叠
  assert.ok(exists('../sw.js'), 'sw.js 应随项目存在');
  const sw = read('../sw.js');
  assert.match(sw, /teamo-assets-v1/, 'SW 缓存名应存在');
  assert.match(sw, /assets\/(vendor|moderation)/, 'SW 应覆盖 vendor/moderation');
  assert.match(main, /serviceWorker\.register\('\.\/sw\.js'/, 'main 应注册 SW');
  assert.match(ui, /:::color|COLOR_ALIAS/, '应有 :::color 颜色容器');
  assert.match(ui, /uE000COLOR/, '颜色容器应进恢复链');
  assert.match(ui, /thinkStreaming \? '思考中' : '思考过程'/, '思考中不显示「思考过程」标题');
  assert.match(ui, /observedHiddenThink/, '应自学记录加密思考模型');
  assert.match(ui, /思考链已加密/, '菜单应有加密徽章');
  assert.match(ui, /handleSystemCommand/, '应有 /system 命令执行器');
  assert.match(ui, /'__system__'/, '应支持 __system__ 伪模型');
  assert.match(ui, /node\._userToggle == null\) node\.classList\.toggle\('expanded', !!live\)/, '文件行应流式展开/完成折叠');
  assert.match(css0, /md-c-red/, '调色板应存在');
  assert.match(css0, /badge\.enc/, '加密徽章样式应存在');
  // 2026.9.27.15：缩放柄只留右下角 + 清空同步环形缓冲 + 不记录复制动作
  assert.doesNotMatch(dw, /data-rz="nw"|data-rz="ne"|data-rz="sw"/, '缩放柄应只保留右下角');
  assert.match(dw, /border-bottom-right-radius:100%/, '右下角应为弧线造型');
  assert.match(dw, /__teamoModLog\) globalThis.__teamoModLog.length = 0/, '清空应同步日志环形缓冲');
  assert.doesNotMatch(dw, /debug:copy|debug:select/, '复制/全选不应写日志');
  // 中文快速通道 + 大图压缩 + 状态栏伪装 + 审核消息头部
  assert.match(read('../js/moderation.js'), /text:cjk-fastpath/, 'CJK 快速通道应存在');
  assert.match(read('../js/moderation.js'), /MOD_IMAGE_MAX_DIM = 1280/, '大图应压缩到 1280 再审核');
  assert.match(ui, /moderating: \['连接模型中'/, '审核状态应对用户显示「连接模型中」');
  assert.match(ui, /moderationNotice \|\| !prev \|\| prev.role === 'user'/, '审核消息应强制显示头部（图标+审核员）');
  const mod = read('../js/moderation.js');
  assert.match(mod, /IMAGE_TURN_BUDGET_MS = 90000/, '带图回合预算应为 90s');
  assert.match(mod, /degraded/, '图像模型未就绪应标记 degraded');
  assert.match(mod, /prewarm:fetch/, '预热应逐文件上报下载进度');
  assert.match(main, /__teamoPrewarmImageModeration && globalThis.__teamoPrewarmImageModeration\('startup'\)/, '启动应自动预热');
  assert.match(main, /onModerationFailClosed/, 'main 应接 fail-closed 提示钩子');
  const agent = read('../js/agent.js');
  assert.match(agent, /turn:fail-closed/, '带图回合审核失败应 fail-closed');
});

console.log(results.join('\n'));
console.log(`\n审核资产完整性：${passed} 通过 / ${failed} 失败 ${failed === 0 ? '✅' : '❌'}`);
process.exit(failed === 0 ? 0 : 1);
