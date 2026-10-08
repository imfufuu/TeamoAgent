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
import { createHash } from 'node:crypto';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
// ui.js 已拆分：源码级断言读 UI 层整体（ui.js + ui-files-panel.js + ui-lightbox.js + quickviz.js）
const readUi = () => ['../js/ui.js', '../js/ui-markdown.js', '../js/ui-model-picker.js', '../js/ui-popovers.js', '../js/ui-command-palette.js', '../js/ui-system-commands.js', '../js/ui-files-panel.js', '../js/ui-lightbox.js', '../js/ui-attachments.js', '../js/ui-capability.js', '../js/quickviz.js'].map(read).join('\n');
// P4：agent.js 已拆出 toolrunner.js（工具执行与记账）/ turnfinalizer.js（回合收尾）；「agent 收尾应做 X」类断言读三者整体
const readAgent = () => ['../js/agent.js', '../js/toolrunner.js', '../js/turnfinalizer.js'].map(read).join('\n');
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
await test('NSFWJS InceptionV3 为 Keras layers 模型（uint8 量化 / 输入 299），与 moderation.js 的 size:299 + type:"layers" 配对', () => {
  const model = JSON.parse(read('../assets/moderation/nsfw-inception-v3/model.json'));
  assert.notEqual(model.format, 'graph-model', 'inception_v3 不是 graph-model：传 type:"graph" 会走 loadGraphModel 直接挂');
  assert.ok(model.modelTopology && model.modelTopology.model_config, 'layers 模型应带 modelTopology.model_config');
  const src = read('../js/moderation.js');
  assert.match(src, /nsfw-inception-v3\/model\.json/);
  assert.match(src, /const NSFW_INPUT_SIZE = 299/);
  assert.match(src, /size: NSFW_INPUT_SIZE, type: 'layers'/, 'nsfwjs.load 必须按 layers 加载并指定 299 输入');
  assert.doesNotMatch(src, /type:\s*'graph'/, '旧 mobilenet 的 type:"graph" 不得残留');
  const shards = model.weightsManifest.flatMap((w) => w.paths);
  assert.equal(shards.length, 6);
  let total = 0;
  for (const s of shards) {
    assert.ok(exists(`../assets/moderation/nsfw-inception-v3/${s}`), `权重分片缺失：${s}`);
    total += fs.statSync(new URL(`../assets/moderation/nsfw-inception-v3/${s}`, import.meta.url)).size;
  }
  assert.ok(total > 22_000_000 && total < 23_000_000, `InceptionV3 权重应约 22.4MB，实际 ${total}`);
  const weights = model.weightsManifest.flatMap((w) => w.weights);
  assert.ok(weights.every((w) => w.quantization && w.quantization.dtype === 'uint8'), '应为 uint8 量化版本（否则 90MB）');
  assert.ok(!exists('../assets/moderation/nsfw-mobilenet-v2-mid/model.json'), '旧 mobilenet_v2_mid 资产应已移除');
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
  assert.match(dw, /__dubheDebugToggle/, 'debugwindow 应暴露 ⌘K 桥');
  assert.match(dw, /__dubheDebugLog/, 'debugwindow 应暴露日志桥');
  assert.match(dw, /__dubheModSubscribe/, 'debugwindow 应订阅审核日志');
  assert.match(dw, /tdw-rz/, '浮窗应有四角缩放手柄');
  assert.match(dw, /tdw-entry/, '应有常驻快捷入口');
  assert.match(dw, /copySelected|data-act="copy"/, '应支持复制导出');
  assert.match(dw, /transformOrigin/, '关闭应有最小化动画');
  const ui = readUi();
  const state = read('../js/state.js');
  const html = read('../app.html');
  const icons = read('../js/icons.js');
  const css0 = read('../css/styles.css');
  assert.match(ui, /p:debug/, '⌘K 命令面板应有调试浮窗入口');
  // 2026.9.27.19：图标入缓存 / Dubhe Agent /system 组图标 / 文档页重设计 / opus-5-5 热门置顶
  const swPre = read('../sw.js');
  assert.match(swPre, /fonts\|icons/, 'SW 范围应覆盖 assets/icons');
  assert.match(swPre, /PRECACHE_ICONS/, 'SW 应在 install 预热厂商图标');
  assert.match(ui, /sys-gear">\$\{ICON\.system\}<\/span><span>Dubhe Agent/, 'Dubhe Agent 分组标题应有图标');
  const cfg = read('../js/config.js');
  assert.match(cfg, /\{ id: 'claude-opus-5-5',\s+provider: 'Anthropic', hot: true \}/, 'opus-5-5 应入表且标热门');
  const idx55 = cfg.indexOf("claude-opus-5-5");
  const idxFable = cfg.indexOf("claude-fable-5-1");
  assert.ok(idx55 >= 0 && idx55 < idxFable, 'opus-5-5 应排在 fable-5-1 之前（组内置顶）');
  const docs2 = read('../docs.html');
  for (const tok of ['--serif', 'timeline', 'legal-card', 'theme-toggle', 'class="glow"', 'data-theme']) {
    assert.ok(docs2.includes(tok), `docs.html 应含主页设计语言标记：${tok}`);
  }
  // 2026.9.27.18：数学守卫 / system 输出格式化 / 文档页 / 搜索清空
  assert.match(ui, /function extractInlineCodeSpans/, '行内代码提取器应感知转义定界符');
  const inlineCodeExtractAt = ui.indexOf('t = extractInlineCodeSpans(t, inlineCodes)');
  const mathGuardAt = ui.indexOf('const MATH_CMD');
  assert.ok(inlineCodeExtractAt >= 0 && inlineCodeExtractAt < mathGuardAt, '行内代码必须先于数学提取剥离');
  assert.match(ui, /MATH_REJECT/, '数学段守卫应存在');
  assert.match(ui, /mathOk\(x\) \? pushMath/, '单 $ 与 $$ 提取都应过守卫');
  assert.match(ui, /uE000IC/, '行内代码应走占位恢复链');
  assert.match(ui, /function sysReplyHtml/, '/system 回复应有格式化器');
  assert.match(ui, /m\.model === '__system__' \? sysReplyHtml/, 'system 回复应走格式化渲染');
  assert.match(ui, /syncCapLine\(\); \/\/ 能力行/, '进通道应刷新能力行');
  assert.match(ui, /'<span class="dd-item-id mono">system-commands<\/span>'/, '菜单条目应为英文且无图标');
  assert.match(ui, /dd-group-title', `<span class="sys-gear">\$\{ICON\.system\}<\/span><span>Dubhe Agent<\/span>`\)\);/, '分组标题应为 Dubhe Agent（带图标）');
  assert.match(ui, /model-search-clear/, '搜索清空按钮应接线');
  assert.ok(exists('../docs.html'), 'docs.html 文档页应存在');
  const docs = read('../docs.html');
  for (const sec of ['更新日志', '用户协议', '服务条款', '隐私政策', 'V1.0', 'V1.4']) {
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
  assert.match(sw, /dubhe-assets-v2/, 'SW 缓存名应存在');
  assert.match(sw, /assets\/(vendor|moderation)/, 'SW 应覆盖 vendor/moderation');
  assert.match(main, /serviceWorker\.register\('\.\/sw\.js'/, 'main 应注册 SW');
  assert.match(ui, /:::color|COLOR_ALIAS/, '应有 :::color 颜色容器');
  assert.match(ui, /uE000COLOR/, '颜色容器应进恢复链');
  assert.match(ui, /thinkStreaming \? '思考中' : '思考过程'/, '思考中不显示「思考过程」标题');
  // 当前版本不在模型菜单做隐藏思考检测；保留徽章样式仅兼容旧消息状态。
  assert.match(ui, /handleSystemCommand/, '应有 /system 命令执行器');
  assert.match(ui, /'__system__'/, '应支持 __system__ 伪模型');
  assert.match(ui, /node\._userToggle == null\) node\.classList\.toggle\('expanded', !!live\)/, '文件行应流式展开/完成折叠');
  assert.match(css0, /md-c-red/, '调色板应存在');
  assert.match(css0, /badge\.enc/, '加密徽章样式应存在');
  // 2026.9.27.15：缩放柄只留右下角 + 清空同步环形缓冲 + 不记录复制动作
  assert.doesNotMatch(dw, /data-rz="nw"|data-rz="ne"|data-rz="sw"/, '缩放柄应只保留右下角');
  assert.match(dw, /border-bottom-right-radius:100%/, '右下角应为弧线造型');
  assert.match(dw, /__dubheModLog\) globalThis.__dubheModLog.length = 0/, '清空应同步日志环形缓冲');
  assert.doesNotMatch(dw, /debug:copy|debug:select/, '复制/全选不应写日志');
  // 中文快速通道 + 大图压缩 + 状态栏伪装 + 审核消息头部
  assert.match(read('../js/moderation.js'), /text:cjk-fastpath/, 'CJK 快速通道应存在');
  assert.match(read('../js/moderation.js'), /MOD_IMAGE_MAX_DIM = 1280/, '大图应压缩到 1280 再审核');
  assert.match(ui, /moderating: \['连接模型中'/, '审核状态应对用户显示「连接模型中」');
  assert.match(ui, /moderationNotice \|\| !prev \|\| prev.role === 'user'/, '审核消息应强制显示头部（图标+审核员）');
  const mod = read('../js/moderation.js');
  assert.match(mod, /IMAGE_TURN_BUDGET_MS = 120000/, '带图回合预算应为 120s（含灰区远程复核）');
  assert.match(mod, /degraded/, '图像模型未就绪应标记 degraded');
  assert.match(mod, /prewarm:fetch/, '预热应逐文件上报下载进度');
  assert.match(main, /__dubhePrewarmImageModeration && globalThis.__dubhePrewarmImageModeration\('startup'\)/, '启动应自动预热');
  assert.match(main, /onModerationFailClosed/, 'main 应接 fail-closed 提示钩子');
  const agent = read('../js/agent.js');
  assert.match(agent, /turn:fail-closed/, '带图回合审核失败应 fail-closed');
});

// ── P1（Dubhe Helix 2.5）：可恢复执行与记忆生命周期的接线钉子 ──
// 这些不是「实现正确性」测试（那在 agent.test.mjs / recovery-kernel-smoke.mjs），
// 而是「混版缓存下不能悄悄丢失」的结构钉子：模块、桥、样式、命令都必须在位。
group('P1 可恢复执行接线（检查点 / 幂等账本 / 确认卡 / 记忆生命周期）');
await test('P1 四个新模块随项目存在，且都以 ?v= 版本化方式被引用', () => {
  for (const rel of ['../js/recovery.js', '../js/idempotency.js', '../js/memorylife.js', '../js/trajectory.js']) {
    assert.ok(exists(rel), `${rel} 应随项目存在`);
  }
  const agent = read('../js/agent.js');
  for (const mod of ['recovery.js', 'idempotency.js', 'memorylife.js', 'trajectory.js']) {
    assert.match(agent, new RegExp(`\\./${mod.replace('.', '\\.')}\\?v=\\d`), `agent.js 应以 ?v= 导入 ${mod}`);
  }
});
await test('确认卡：样式类、UI 渲染、main.js 桥、agent.resolveConfirmation 四处齐备', () => {
  const css = read('../css/styles.css');
  const ui = readUi();
  const main = read('../js/main.js');
  const agent = read('../js/agent.js');
  for (const cls of ['.confirm-card', '.confirm-title', '.confirm-body', '.confirm-actions', '.confirm-btn', '.confirm-result']) {
    assert.ok(css.includes(cls), `缺少确认卡样式 ${cls}`);
  }
  assert.match(ui, /onConfirmationRequest/, 'UI 应渲染确认请求');
  assert.match(ui, /onConfirmationResolved/, 'UI 应渲染确认结果（超时 / 过期）');
  assert.match(ui, /clearConfirmCards/, '重建消息时应清理确认卡');
  assert.match(ui, /resolveConfirmation/, 'UI 应把用户决定交回 agent');
  assert.match(main, /onConfirmationRequest/, 'main.js 应桥接确认请求钩子');
  assert.match(main, /__dubheConfirmationRequest|onConfirmationRequest/, 'main.js 应暴露混版安全桥');
  assert.match(agent, /resolveConfirmation/, 'agent 应暴露 resolveConfirmation（缓存了旧 UI 时仍可用）');
});
await test('/guard 与 /resume 命令进入 /system 帮助与命令分支，档位默认 observe', () => {
  const ui = readUi();
  assert.match(ui, /\/guard/, '/system 帮助应包含 /guard');
  assert.match(ui, /\/resume/, '/system 帮助应包含 /resume');
  assert.match(ui, /executionGuard/, '档位应写入 settings.executionGuard');
  assert.match(ui, /observe/, '应说明默认 observe 档');
  const ex = read('../js/execution.js');
  assert.match(ex, /strict-l2/, 'strict-l2 档位应存在');
  assert.match(ex, /GUARD_MODES/, '档位集合应集中定义');
});
await test('轨迹级评测：三个负向指标进 /nexus 报告，遥测暴露执行内核字段', () => {
  const nexus = read('../js/nexus.js');
  const agent = read('../js/agent.js');
  const ui = readUi();
  for (const key of ['overRouting', 'underRouting', 'silentFailure']) {
    assert.ok(nexus.includes(key), `报告应覆盖负向指标 ${key}`);
  }
  assert.match(nexus, /轨迹级评测/, '报告应有轨迹级评一节');
  assert.match(ui, /trajectoryTotals/, 'UI 应把轨迹累计传给报告');
  assert.match(agent, /trajectoryLog/, 'agent 应维护轨迹日志');
  assert.match(agent, /auditCompleteness|recoverySuccessRate/, '轨迹汇总应含恢复率与审计完整度');
});

group('P2 策略演进与红队评测接线（策略版本化 / 统一上下文 / 指标 / 审计三层 / 故障注入 / 实验）');
await test('P2 六个新模块随项目存在，且都以 ?v= 版本化方式被引用', () => {
  for (const rel of ['../js/policy.js', '../js/experiments.js', '../js/metrics.js', '../js/faults.js', '../js/audit.js', '../js/executionContext.js']) {
    assert.ok(exists(rel), `${rel} 应随项目存在`);
  }
  const agent = read('../js/agent.js');
  for (const mod of ['policy.js', 'experiments.js', 'metrics.js', 'faults.js', 'audit.js', 'executionContext.js']) {
    assert.match(agent, new RegExp(`\\./${mod.replace('.', '\\.')}\\?v=\\d`), `agent.js 应以 ?v= 导入 ${mod}`);
  }
});
await test('版本号全场一致：所有 ?v= 静态引用与 APP_VERSION 相同（漏升一个就等于混版）', () => {
  const cfg = read('../js/config.js');
  const m = /APP_VERSION\s*=\s*'([0-9.]+)'/.exec(cfg);
  assert.ok(m, 'config.js 应导出 APP_VERSION');
  const ver = m[1];
  const files = ['../js/agent.js', '../js/main.js', '../js/ui.js', '../js/nexus.js', '../js/tools.js', '../app.html', '../index.html', '../docs.html'];
  for (const f of files) {
    const text = read(f);
    for (const hit of text.matchAll(/\?v=(\d[\d.]*)/g)) {
      assert.equal(hit[1], ver, `${f} 里的 ?v=${hit[1]} 与 APP_VERSION ${ver} 不一致`);
    }
  }
});
await test('统一执行上下文：工具表由上下文派生，状态分裂有稳定错误码', () => {
  const ctx = read('../js/executionContext.js');
  for (const fn of ['createTurnExecutionContext', 'deriveToolWhitelist', 'assertExecutionContextConsistency', 'contextAuditFields']) {
    assert.ok(ctx.includes(`export function ${fn}`), `executionContext.js 应导出 ${fn}`);
  }
  assert.match(ctx, /capability-declared-without-tool/, '必须有「声明能力但工具表没有」的分裂码（P2 第 1 条）');
  const agent = read('../js/agent.js');
  assert.match(agent, /deriveToolWhitelist/, 'agent 应以派生工具表为准，而不是自己再算一份');
  assert.match(agent, /assertExecutionContextConsistency/, 'agent 应在开工前做上下文一致性自检');
  assert.match(agent, /context-consistency/, '自检结论要进审计');
});
await test('策略版本化：注册表覆盖 router/tool/memory/risk/prompt/audit/experiment，且可自检漂移', () => {
  const pol = read('../js/policy.js');
  for (const key of ['routerPolicyVersion', 'toolPolicyVersion', 'riskPolicyVersion', 'promptContractVersion', 'auditSchemaVersion', 'memoryPolicyVersion', 'experimentPolicyVersion']) {
    assert.ok(pol.includes(key), `策略注册表应含 ${key}`);
  }
  assert.match(pol, /export async function verifyPolicyRegistry/, '必须有漂移自检（声明 vs 模块实际导出）');
  assert.match(read('../js/agent.js'), /snapshotPolicies|policySnapshot/, '策略快照要随执行记录落盘');
});
await test('审计三层目标：完整性与完备性分开报告，真实性明确不声明', () => {
  const aud = read('../js/audit.js');
  assert.match(aud, /AUDIT_GOALS/, '应集中定义三个审计目标');
  assert.match(aud, /authenticity[\s\S]{0,200}covered: false/, '真实性必须如实标记为不覆盖（需硬件远程证明）');
  assert.match(aud, /reconcileAudit/, '完备性必须靠对账，而不是只验链');
  const agent = readAgent();
  assert.match(agent, /reconcileAudit/, 'agent 收尾应做审计对账');
});
await test('统一指标面板：12 指标 × 7 维切分 + 基线门禁接进 agent', () => {
  const met = read('../js/metrics.js');
  assert.match(met, /METRIC_DEFS/, '指标定义应集中');
  assert.match(met, /METRIC_DIMENSIONS/, '必须有维度切分（只看总分会掩盖某一类退化）');
  assert.match(met, /export function evaluateMetricGate/, '必须有基线门禁');
  const agent = readAgent();
  assert.match(agent, /buildMetricSnapshot/, 'agent 每轮应产出指标快照');
  assert.match(agent, /evaluateMetricGate/, 'agent 应跑指标门禁');
});
await test('故障注入：九类清单 + 五性质验收，且能一键装备（下一轮生效一次）', () => {
  const f = read('../js/faults.js');
  assert.match(f, /FAULT_KINDS/, '九类故障清单应集中定义');
  assert.match(f, /FAULT_PROPERTIES/, '五性质应集中定义');
  for (const k of ['tool-timeout', 'tool-empty-result', 'tool-bad-schema', 'artifact-modified-externally', 'duplicate-tool-call', 'audit-event-missing', 'capability-mask-mismatch', 'memory-instruction-conflict', 'authorization-revoked-midway']) {
    assert.ok(f.includes(k), `故障清单缺 ${k}`);
  }
  assert.match(read('../js/agent.js'), /armFaultInjection/, 'agent 应暴露装备入口');
  assert.match(readUi(), /\/p2 fault|fault/, 'UI 应能列出/装备故障');
});
await test('策略实验：默认关闭灰度、对照语义干净，样本只进实验组', () => {
  const ex = read('../js/experiments.js');
  assert.match(ex, /EXPERIMENT_REGISTRY/, '实验应集中注册');
  assert.match(ex, /enabled: false/, '灰度必须默认关闭（未开启时行为与之前完全一致）');
  const agent = readAgent();
  assert.match(agent, /inExperiment/, '只有真正进入变体才可用实验参数改写行为');
  assert.match(agent, /appendExperimentSample/, '在线样本要落盘');
});
await test('/p2 面板进 /system 帮助与命令分支（策略 / 指标 / 审计 / 故障 / 实验 / 上下文）', () => {
  const ui = readUi();
  assert.match(ui, /name === 'p2'/, '应有 /p2 命令分支');
  assert.match(ui, /\/p2 \[report\|policy\|fault\|exp\]/, '帮助里应列出 /p2 用法');
  assert.match(ui, /getP2ReportLines/, '报告行应由 agent 统一生成（口径单一来源）');
  assert.match(read('../js/nexus.js'), /p2Lines/, '/nexus 报告应拼装 P2 章节');
});
await test('P2 状态键齐备并做形状兜底（坏数据不能让面板与内核崩）', () => {
  const st = read('../js/state.js');
  for (const key of ['policySnapshot', 'experimentAssignments', 'faultInjection', 'metricsSnapshot', 'auditReconcile', 'lastExecutionContext', 'lastFaultReport']) {
    assert.ok(st.includes(key), `state.js 应声明 ${key}`);
  }
  assert.match(st, /normalizeP2State/, '应有 P2 状态兜底');
  assert.match(st, /P2 根级状态/, '体积估算应把 P2 状态算进去');
});

group('P3 编辑直播预览与已移除的自动文件删除功能');
await test('编辑预览模块保持版本化接线', () => {
  assert.ok(exists('../js/editpreview.js'), '编辑预览模块应随项目存在');
  const agent = read('../js/agent.js');
  const ui = readUi();
  assert.match(agent, /\.\/editpreview\.js\?v=\d/, 'agent.js 应以 ?v= 导入 editpreview.js');
  assert.match(ui, /editpreview\.js\?v=\d/, 'ui.js 应以 ?v= 导入 editpreview.js');
  assert.match(ui, /paintEditFold/, '应渲染编辑文件折叠行');
  assert.match(ui, /editPreviewHtml/, '应渲染编辑预览窗');
  assert.match(ui, /EDIT_PREVIEW_REFRESH_MS/, '预览窗必须节流刷新');
  assert.match(agent, /getEditPreview/, 'Agent 应暴露编辑预览数据');
  const css = read('../css/styles.css');
  for (const cls of ['.edit-preview', '.ep-line', '.ep-no', '.ep-caret']) assert.ok(css.includes(cls), `缺少预览样式 ${cls}`);
});
await test('品牌图标静态、连接圈保留旋转；智能路由卡使用原生产品图标', () => {
  const css = read('../css/styles.css');
  const ui = readUi();
  const router = read('../js/smartrouter.js');
  assert.match(css, /\.empty-logo svg \{[^}]*animation:\s*none/);
  assert.doesNotMatch(css, /halfspin/);
  assert.match(css, /\.connect-ring \{[^}]*animation:\s*spin \.8s linear infinite/);
  assert.match(ui, /icon = `<span class=\"router-ico\">\$\{ROUTER_ICON_SVG\}<\/span>`/);
  assert.match(ui, /name = SMART_ROUTER_LABEL;/);
  assert.match(router, /export const ROUTER_ICON_SVG/);
});
await test('相机专用入口自动编辑，保存回用 addFiles，普通附件流程不变', () => {
  const app = read('../app.html');
  const ui = readUi();
  const editor = read('../js/photo-editor.js');
  const css = read('../css/styles.css');
  assert.match(app, /id=\"camera-btn\"/);
  assert.match(app, /id=\"attach-menu-wrap\"[\s\S]*id=\"attach-menu\"[\s\S]*id=\"camera-btn\"[\s\S]*role=\"menuitem\"/);
  assert.match(ui, /setAttachMenuOpen/);
  assert.match(css, /\.attach-menu-wrap/);
  assert.match(css, /\.attach-menu-item/);
  assert.match(app, /id=\"camera-input\"[^>]*accept=\"image\/\*\" capture=\"environment\"/);
  assert.match(ui, /openPhotoEditor\(photo\)/);
  assert.match(ui, /if \(edited\) await addFiles\(\[edited\]\)/);
  assert.match(ui, /fileInput\.addEventListener\('change', \(\) => \{ addFiles\(fileInput\.files\)/);
  for (const action of ['undo', 'rotate-left', 'rotate-right', 'crop', 'apply-crop', 'cancel-crop', 'draw', 'save']) assert.ok(editor.includes(`data-photo-action=\"${action}\"`), `照片编辑器缺少 ${action}`);
  assert.match(editor, /MAX_UNDO_ENTRIES/);
  assert.match(editor, /pushUndoSnapshot/);
  assert.match(editor, /resizeCropRect/);
  assert.match(css, /\.photo-editor-modal/);
  assert.match(css, /\.photo-canvas-wrap/);
});
await test('图表全屏查看器具有显式入口、SVG 固有尺寸和可交互缩放', () => {
  const ui = readUi(); // 图表渲染已拆到 quickviz.js
  const css = read('../css/styles.css');
  const viewer = read('../js/lightbox.js');
  assert.match(ui, /class=\"md-chart-expand\"/);
  assert.match(ui, /width=\"\$\{w\}\" height=\"\$\{h\}\"/);
  assert.match(ui, /zoomLightboxState\(lbState, factor/);
  assert.match(ui, /setAttribute\('width', String\(vb\[2\]\)\)/);
  assert.match(viewer, /LIGHTBOX_MIN_SCALE = 0\.25/);
  assert.match(viewer, /LIGHTBOX_MAX_SCALE = 8/);
  assert.match(css, /\.img-lightbox-toolbar[\s\S]*?z-index:\s*5/);
});
await test('浏览器环境读取只输出粗粒度字段，并提供显式工具与 /env 命令', () => {
  const env = read('../js/browser-env.js');
  const tools = read('../js/tools.js');
  const ui = readUi();
  assert.match(env, /getCoarseBrowserEnvironment/);
  assert.doesNotMatch(env, /document\.cookie|localStorage|sessionStorage|geolocation|navigator\.cookie/);
  assert.match(tools, /name: 'get_browser_environment'/);
  assert.match(tools, /不读取 Cookie、localStorage、IP、GPS/);
  assert.match(ui, /name === 'env' \|\| name === 'environment'/);
  assert.match(ui, /'\/env —— 查看粗略浏览器/);
});
await test('历史分页模块使用双预算并提供“更早的消息”入口', () => {
  const history = read('../js/history.js');
  const ui = readUi();
  assert.match(history, /HISTORY_WINDOW_MAX_MESSAGES/);
  assert.match(history, /HISTORY_WINDOW_MAX_CHARS/);
  assert.match(history, /splitHistoryTurns/);
  assert.match(history, /previousHistoryWindowStart/);
  assert.match(ui, /<span>更早的消息<\/span>/);
  assert.match(ui, /previousHistoryWindowStart/);
});
await test('自动文件删除已彻底退出执行路径与用户界面', () => {
  assert.equal(exists('../js/cleanup.js'), false, '不应再打包自动删除模块');
  const agent = read('../js/agent.js');
  const ui = readUi();
  const main = read('../js/main.js');
  const config = read('../js/config.js');
  const css = read('../css/styles.css');
  assert.doesNotMatch(agent, /runAutoCleanup|cleanupArtifacts|files-cleanup|runCleanupNow|exec\.cleanup/);
  assert.doesNotMatch(ui, /name === 'cleanup'|\/cleanup|自清理|cleanup-fold|onCleanup|CLEANUP_MODES/);
  assert.doesNotMatch(main, /onCleanup/);
  assert.doesNotMatch(config, /收尾自检|自清理/);
  assert.doesNotMatch(css, /\.cleanup-fold|\.cleanup-report|pill\.watch/);
  const st = read('../js/state.js');
  assert.doesNotMatch(st, /cleanupPolicy: 'strip'|cleanupArtifacts:\s*\[|lastCleanupReport:\s*null/);
  assert.match(st, /delete state\.settings\.cleanupPolicy/, '旧快照的过期策略应迁移掉');
  assert.match(st, /delete message\.cleanup/, '旧消息标记应迁移掉');
});

await test('介绍页 / 对话页共享主题色，设置项同步外观并使用应用主题状态', () => {
  const theme = read('../js/theme.js');
  const home = read('../js/home.js');
  const ui = readUi();
  const settings = read('../js/settings.js');
  assert.match(theme, /THEME_STORAGE_KEY = 'dubhe-theme'/);
  assert.match(home, /readThemePreference/);
  assert.match(home, /writeThemePreference\(root\.dataset\.theme\)/);
  assert.match(home, /addEventListener\('storage'/);
  assert.match(ui, /readThemePreference\(store\.state\.settings\.theme/);
  assert.match(ui, /addEventListener\('storage'/);
  assert.match(settings, /writeThemePreference\(v\)/);
});
await test('字号三档实际覆盖固定 px 字号；思考 Off 的强度行可隐藏；本地存储读取 v2 key', () => {
  const css = read('../css/styles.css');
  const settings = read('../js/settings.js');
  const app = read('../app.html');
  assert.match(css, /html\[data-fontsize="small"\]/);
  assert.match(css, /html\[data-fontsize="medium"\]/);
  assert.match(css, /html\[data-fontsize="large"\]/);
  assert.match(css, /font-size: var\(--ui-fs-14px, 14px\)/);
  assert.match(css, /--ui-fs-14px: 12\.6px/);
  assert.match(css, /--ui-fs-14px: 15\.4px/);
  assert.match(settings, /applyFontSizeValue\(v\)/);
  assert.doesNotMatch(settings, /document\.documentElement\.style\.fontSize/);
  assert.match(css, /\.set-row\[hidden\] \{ display: none !important; \}/);
  assert.match(settings, /\$\{STORAGE_KEY\}-v2/);
  assert.match(settings, /store\.state\.sessions/);
  assert.match(app, /id="set-reason-row" hidden/);
});
await test('加载屏使用与 APP_LOGO 同构的原生产品图标，且不会自转', () => {
  const app = read('../app.html');
  const icons = read('../js/icons.js');
  const css = read('../css/styles.css');
  const boot = /<div class="boot-logo"[\s\S]*?<\/div>/.exec(app)?.[0] || '';
  for (const part of ['r="13"', 'stroke-opacity="0.55"', 'cx="16.000" cy="24.000"', 'cx="9.072" cy="12.000"']) {
    assert.ok(boot.includes(part) && icons.includes(part), `启动图标与 APP_LOGO 不一致：${part}`);
  }
  assert.match(css, /\.boot-logo svg \{[^}]*animation: none/);
  assert.doesNotMatch(css, /animation:\s*boot-spin/);
});
await test('启动超时不再自动闪退；挂载成功取消计时且内联脚本 CSP 哈希同步', () => {
  const app = read('../app.html');
  const ui = readUi();
  const script = /<script>([\s\S]*?)<\/script>/.exec(app)?.[1] || '';
  const failure = /function forceReveal\(msg\)\s*\{([\s\S]*?)\n  \}/.exec(script)?.[1] || '';
  assert.ok(script, '启动兜底脚本应存在');
  assert.match(script, /var BOOT_TIMEOUT_MS=90000;/, '慢网容忍窗口应为 90 秒');
  assert.match(script, /启动超过 90 秒仍未完成/);
  assert.doesNotMatch(failure, /setTimeout|boot\.remove/, '失败提示必须留在屏幕上，不能自动闪退');
  assert.match(script, /window\.__dubheBootGuard\s*=\s*\{\s*complete/);
  assert.match(ui, /bootGuard\.complete\(\)/, 'UI 挂载成功时必须同步取消超时');
  const uiObject = ui.indexOf('const ui = {');
  const complete = ui.indexOf('bootGuard.complete()');
  const returned = ui.indexOf('return ui;');
  assert.ok(uiObject >= 0 && complete > uiObject && returned > complete, '关闭加载屏的回调必须在 hooks 返回前可达');
  const digest = `sha256-${createHash('sha256').update(script).digest('base64')}`;
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(app)?.[1] || '';
  assert.ok(csp.includes(digest), `CSP 必须允许当前内联启动脚本（期望 ${digest}）`);
});
await test('启动屏（V1.7.1）：第三方字体不得以解析器外链阻塞脚本；进度按真实阶段上报；慢网/失败有操作入口', () => {
  const app = read('../app.html');
  const main = read('../js/main.js');
  const css = read('../css/styles.css');
  for (const page of ['../app.html', '../index.html', '../docs.html']) {
    const html = read(page);
    assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"[^>]+href="https?:\/\//, `${page}：跨域样式表必须由脚本动态插入（解析器插入会阻塞后续脚本执行，弱网下卡在加载屏直到超时）`);
    assert.doesNotMatch(html, /<link[^>]+href="https?:\/\/[^"]+"[^>]+rel="stylesheet"/, `${page}：跨域样式表必须由脚本动态插入`);
  }
  const script = /<script>([\s\S]*?)<\/script>/.exec(app)?.[1] || '';
  assert.match(script, /fonts\.googleapis\.com\/css2\?family=/, '字体样式表改由启动脚本插入');
  assert.match(script, /document\.createElement\('link'\)[\s\S]*?data-async-font/, '动态插入的 link 需带 data-async-font 标记');
  assert.match(script, /localStorage\.getItem\('dubhe-theme'\)[\s\S]*?setAttribute\('data-theme',th\)/, '启动脚本应提前套用已保存主题');
  assert.match(script, /window\.__dubheBootGuard\s*=\s*\{\s*complete:complete,stage:setStage\}/);
  assert.match(script, /setStage\('assets'\)/);
  assert.doesNotMatch(script, /if\(total>=\d+\) showActions\(\)/, '等待期间不出现重载按钮：只有 90 秒超时 / 真实报错（forceReveal）后才显示');
  assert.equal((script.match(/showActions\(\)/g) || []).length, 2, 'showActions 只有定义 + forceReveal 一处调用');
  assert.match(script, /setHint\(LABEL\[name\]\.replace\('…',''\)\+' · '\+why\+' · 已等待 '\+total\+' 秒'\);/, '慢网那行只写「网速较慢 · 已等待 N 秒」，不再塞文件名');
  assert.match(script, /var why=name==='modules'\|\|name==='assets'\?'网速较慢':'仍在执行';/);
  assert.match(script, /getRegistrations\(\)[\s\S]*?unregister\(\)[\s\S]*?caches\.keys\(\)[\s\S]*?caches\.delete\(k\)/, '「清缓存后重载」需注销 SW 并清空 CacheStorage');
  assert.doesNotMatch(script, /onclick|onload=/, 'CSP 下不得使用内联事件处理器');
  assert.equal((app.match(/<li data-step="/g) || []).length, 4, '启动屏应有 4 个真实阶段');
  const order = ["bootStage('modules')", 'createStore()', "bootStage('kernel')", 'createAgent(store, hooks)', "bootStage('ui')", 'mountUI(store, agent)'];
  let last = -1;
  for (const tok of order) { const i = main.indexOf(tok); assert.ok(i > last, `main.js 阶段上报顺序错误：${tok}`); last = i; }
  assert.match(main, /typeof g\.stage === 'function'/, '阶段上报需容忍旧版 / 测试桩的 guard 没有 stage');
  assert.match(css, /\.boot-actions\[hidden\], \.boot-err\[hidden\] \{ display: none; \}/, 'display:flex 的容器必须显式尊重 hidden 属性');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*html:not\(\[data-motion="on"\]\) \.boot-card, html:not\(\[data-motion="on"\]\) \.boot-ring/, '启动屏动画需在 reduced-motion 下关闭（除非用户在设置里强制开）');
});
console.log(results.join('\n'));
console.log(`\n审核资产完整性：${passed} 通过 / ${failed} 失败 ${failed === 0 ? '✅' : '❌'}`);
process.exit(failed === 0 ? 0 : 1);
