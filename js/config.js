// ─── TeamoRouter 接入配置 ──────────────────────────────────────────────
// 调研自 https://teamorouter.cn/zh/docs/api-integration（2026-09 版）
//   · Base URL: https://api.teamorouter.com
//   · Anthropic 原生协议: POST /v1/messages   (x-api-key + anthropic-version)
//   · OpenAI 兼容协议:    POST /v1/chat/completions (Authorization: Bearer)
//   · 文生图（GPT Image 2 / 2.5）: POST /v1/images/generations (Bearer)，响应 data[].b64_json
//   · 图片编辑（GPT Image）:       POST /v1/images/edits  (multipart/form-data: image + prompt)
//   · 图生文（多模态 / vision）: 各协议原生 content 块（见 api.js 构建逻辑）
//   · 生图模型不作为对话模型直接选择，统一由主智能体通过 generate_image 工具调用
//   · Jev 决策（TypeSafe）: POST /v1/systemone  model="jev"（见 js/jev.js，不是聊天模型）
//   · 模型列表:           GET  /v1/models
//   · 官方建议: Claude 模型务必走 Anthropic 原生协议，其余模型走 OpenAI 兼容协议

// 接入点不在这里写死：运行时由 js/endpoint.js 在 .com / .cn 之间择路（见 GATEWAY_HOSTS）。

// 发布版本号：index.html 用 ?v= 挂在入口样式/脚本上，用来穿透 GitHub Pages 对静态资源
// 的 ~10 分钟缓存。每次改动样式或入口逻辑都要 bump 一次（有单测校验二者一致）。
// 发布版本（正式版标识，界面/文档都读它）与构建戳（每次改动递增，用于 ?v= 缓存击穿）
export const APP_RELEASE = 'V1.0';
export const APP_VERSION = '2026.09.22.20';
export const ANTHROPIC_VERSION = '2023-06-01';
export const MAX_TOKENS = 8192;          // Anthropic 协议必填 max_tokens
export const THINKING_BUDGET = 4096;     // 思考 token 预算（Anthropic budget_tokens）
export const TOOL_LOOP_MAX = 8;          // Agent 工具循环最大迭代次数
export const SUBAGENT_LOOP_MAX = 4;      // 子智能体内部循环上限
export const REQUEST_TIMEOUT_MS = 600000; // 官方服务器最长支持 600s
export const SANDBOX_JS_TIMEOUT_MS = 8000;
export const SANDBOX_PY_TIMEOUT_MS = 120000; // Pyodide 首次加载较慢（运行时常驻，后续执行秒级）
export const STORAGE_KEY = 'teamo-agent-state-v1';

// 兜底模型列表（GET /v1/models 失败时使用，来源：官方文档 2026-09）
export const FALLBACK_MODELS = [
  // Anthropic —— 走 /v1/messages 原生协议
  { id: 'claude-fable-5-1',    provider: 'Anthropic' },
  { id: 'claude-opus-5',       provider: 'Anthropic' },
  { id: 'claude-fable-5',      provider: 'Anthropic' },
  { id: 'claude-sonnet-5',     provider: 'Anthropic' },
  { id: 'claude-opus-4-8',     provider: 'Anthropic' },
  { id: 'claude-opus-4-7',     provider: 'Anthropic' },
  { id: 'claude-opus-4-6',     provider: 'Anthropic' },
  { id: 'claude-sonnet-4-6',   provider: 'Anthropic' },
  { id: 'claude-haiku-4-5',    provider: 'Anthropic' },
  // OpenAI —— 走 /v1/chat/completions
  { id: 'gpt-6-astra',         provider: 'OpenAI' },
  { id: 'gpt-5.6-sol',         provider: 'OpenAI' },
  { id: 'gpt-5.6-terra',       provider: 'OpenAI' },
  { id: 'gpt-5.6-luna',        provider: 'OpenAI' },
  { id: 'gpt-5.5',             provider: 'OpenAI' },
  { id: 'gpt-5.4',             provider: 'OpenAI' },
  { id: 'gpt-5.4-mini',        provider: 'OpenAI' },
  // Google
  { id: 'gemini-3.8-flash',    provider: 'Google' },
  { id: 'gemini-3.7-flash',    provider: 'Google' },
  { id: 'gemini-3.6-flash',    provider: 'Google' },
  { id: 'gemini-3.5-flash',    provider: 'Google' },
  { id: 'gemini-3.5-flash-lite', provider: 'Google' },
  { id: 'gemini-3.1-pro-preview', provider: 'Google' },
  // DeepSeek
  { id: 'deepseek-flash',      provider: 'DeepSeek' },
  { id: 'deepseek-flash-free', provider: 'DeepSeek', free: true },
  { id: 'deepseek-v4-pro',     provider: 'DeepSeek' },
  { id: 'deepseek-v4-flash',   provider: 'DeepSeek' },
  { id: 'deepseek-v4-flash-vision-exp', provider: 'DeepSeek' },  // 多模态（vision）
  { id: 'deepseek-v4-flash-free', provider: 'DeepSeek', free: true },
  // Kimi（月之暗面）——网关 GET /v1/models 已上线 kimi-k3（含 1M 上下文变体）
  { id: 'kimi-k3',             provider: 'Kimi' },
  { id: 'kimi-k3[1M]',         provider: 'Kimi' },
  // GLM（智谱）
  { id: 'glm-5.3-flash',       provider: 'GLM' },
  { id: 'glm-5.3-flash-free',  provider: 'GLM', free: true },
  { id: 'glm-5.3',             provider: 'GLM' },
  { id: 'glm-5.2',             provider: 'GLM' },
  // xAI
  { id: 'grok-4.6',            provider: 'Grok' },
];

export const PROVIDER_ORDER = ['Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'GLM', 'Kimi', 'Grok', '其他'];

// ── 生图模型（GPT Image 系列）────────────────────────────────────────────
// 不可作为对话模型直接选择：统一由主智能体通过 generate_image 工具调用，
// 保留 Agent 的工具循环特性（生成→写沙箱→可继续编辑/下载）。
export const IMAGE_MODELS = [
  { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', note: '高质感写实' },
  { id: 'gpt-image-2.5-flare',    label: 'GPT Image 2.5 Flare',    note: '风格化/插画' },
  { id: 'gpt-image-2',            label: 'GPT Image 2',            note: '均衡·默认' },
];
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
export const DEFAULT_CHAT_MODEL = 'claude-sonnet-5';
// 尺寸（宽x高，像素）：最大边 ≤3840、宽高均为 16 的倍数、长宽比 ≤3:1、总像素 655,360–8,294,400
export const IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048'];
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'];
export const IMAGE_FORMATS = ['png', 'jpeg', 'webp'];
export const IMAGE_BACKGROUNDS = ['auto', 'transparent', 'opaque'];
export function isImageGenModel(id) { return IMAGE_MODELS.some((m) => m.id === id); }
export function imageModelLabel(id) {
  const hit = IMAGE_MODELS.find((m) => m.id === id);
  return hit ? hit.label : String(id || '');
}

// ── 生图模型 ID 归一（实测修复）─────────────────────────────────────────
// 网关对无法识别的 model 一律返回 400「模型 'X' 暂不可用」（type=model_not_available），
// 而对话模型很常把「显示名」当 ID 传进 generate_image（如 model="2.5 Sunburst"），
// 结果整次调用在网关侧秒失败。这里本地先把别名解析成真实模型 ID：
//   "2.5 Sunburst" / "GPT Image 2.5 Sunburst" / "sunburst" → gpt-image-2.5-sunburst
// 解析不出来的（形状像 ID 的）透传给网关，便于使用 /v1/models 里的其它生图模型；
// 完全不像 ID 的退回会话选定的生图模型，并在工具结果里告知，避免 LLM 反复犯错。
export function imageModelAliasKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
const IMAGE_MODEL_ALIASES = (() => {
  const map = new Map();
  const put = (k, id) => { if (k && !map.has(k)) map.set(k, id); };
  for (const m of IMAGE_MODELS) {
    const idKey = imageModelAliasKey(m.id);        // gpt image 2.5 sunburst
    const labelKey = imageModelAliasKey(m.label);   // gpt image 2.5 sunburst
    put(String(m.id).toLowerCase(), m.id);          // 精确 ID（含连字符）
    put(idKey, m.id);
    put(labelKey, m.id);
    put(labelKey.replace(/^gpt image /, ''), m.id); // 2.5 sunburst（去掉品牌前缀）
    put(idKey.replace(/^gpt image /, ''), m.id);
    const tail = idKey.split(' ').filter(Boolean).pop();
    if (tail && !/^[\d.]+$/.test(tail)) put(tail, m.id); // sunburst / flare（避免 2 撞车）
  }
  return map;
})();

// 返回 { id, input, corrected, unknown, passthrough }
export function resolveImageModel(raw, fallback = DEFAULT_IMAGE_MODEL) {
  const input = String(raw == null ? '' : raw).trim();
  const fb = isImageGenModel(fallback) ? fallback : DEFAULT_IMAGE_MODEL;
  if (!input) return { id: fb, input, corrected: false, unknown: false };
  const key = imageModelAliasKey(input);
  const hit = IMAGE_MODEL_ALIASES.get(key);
  if (hit) return { id: hit, input, corrected: hit !== input, unknown: false };
  // 形状像网关模型 ID（无空格、含字母）：透传，交给网关判定
  if (/[a-z]/i.test(input) && !/\s/.test(input) && /^[a-z0-9][a-z0-9._[\]-]{1,63}$/i.test(input)) {
    return { id: input, input, corrected: false, unknown: false, passthrough: true };
  }
  return { id: fb, input, corrected: true, unknown: true };
}
// 供工具描述/提示词使用：明确「只能传 ID，不要传显示名」
export const IMAGE_MODEL_IDS = IMAGE_MODELS.map((m) => m.id);

// 根据模型 ID 推断供应商
export function providerOf(modelId) {
  const m = (modelId || '').toLowerCase();
  if (m.startsWith('claude')) return 'Anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('chatgpt')) return 'OpenAI';
  if (m.startsWith('gemini')) return 'Google';
  if (m.startsWith('deepseek')) return 'DeepSeek';
  if (m.startsWith('glm')) return 'GLM';
  if (m.startsWith('kimi') || m.startsWith('moonshot')) return 'Kimi';
  if (m.startsWith('grok')) return 'Grok';
  return '其他';
}

// 协议路由：Claude → anthropic 原生；其余 → openai 兼容（官方 FAQ 建议）
export function protocolOf(modelId) {
  return providerOf(modelId) === 'Anthropic' ? 'anthropic' : 'openai';
}

export function isFreeModel(modelId) {
  const hit = FALLBACK_MODELS.find((m) => m.id === modelId);
  return !!(hit && hit.free) || /-free$/.test(modelId || '');
}

// 多模态（图片输入）支持判断：Claude 全系 / GPT-4o·4.1·5·6 / Gemini 全系 /
// 带 vision·vl·4v·4.5v 字样的型号；其余（如 deepseek-v4、glm-5.x 文本系）不标记
export function supportsVision(_modelId) {
  // 对话通道一律纯文本。识图统一走 analyze_image 工具。
  return false;
}

export function isImageModel(modelId) {
  if (isImageGenModel(modelId)) return true;
  const m = String(modelId || '').toLowerCase();
  // 识图实验模型只给 analyze_image 工具用，不进对话选择器
  if (m === 'deepseek-v4-flash-vision-exp' || /flash-vision/.test(m)) return true;
  return /(^|-)image(-|$)/.test(m);
}

// GPT 系列支持 Fast mode（service_tier: "fast"，2x 计费）
export function supportsFastMode(modelId) {
  return providerOf(modelId) === 'OpenAI';
}

// ── 思考模式参数（按模型家族路由到各自协议的思考字段）──────────────────
// Claude: thinking.budget_tokens（需 max_tokens > budget）
// GPT/Gemini/Grok: reasoning_effort；DeepSeek: reasoning；GLM: thinking.type
// 不支持思考的模型若返回 400，api.js 会自动降级重试并记住该模型
export function thinkingParamsFor(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (m.startsWith('claude')) return { thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET } };
  if (m.startsWith('deepseek')) return { reasoning: true };
  if (m.startsWith('glm')) return { thinking: { type: 'enabled' } };
  if (/^(gpt|o\d|chatgpt|gemini|grok)/.test(m)) return { reasoning_effort: 'medium' };
  return { reasoning_effort: 'medium' }; // 未知模型尽力尝试，失败自动降级
}

// 输出规范：主 Agent 与全部子智能体共用（客户端支持完整 Markdown + KaTeX）
export const OUTPUT_SPEC = [
  '## 输出规范（客户端支持完整 Markdown + KaTeX 渲染，请严格遵守）',
  '- 结构：用 ##/### 标题分节；要点用列表；对比或多字段数据用 Markdown 表格；避免大段无分隔的文字墙。',
  '- 代码：一律用围栏代码块并标注语言（```js / ```python / ```cpp 等）；行内代码用单反引号。',
  '- 数学公式：行内用 $...$，独立公式用 $$...$$（LaTeX 语法，由 KaTeX 渲染），不要用纯文本拼公式。',
  '- 强调：**加粗**标注关键结论，术语/文件名/参数用 `代码样式`；不输出原始 HTML 标签。',
  '- 用与用户相同的语言回复（用户用中文就用中文）；简洁优先，不复述用户问题。',
].join('\n');

export function systemPrompt(now = new Date(), opts = {}) {
  // opts.webEnabled===false 时，工具清单里的联网说明要换成「本轮关闭」，
  // 否则提示词一边说「请求已带上原生搜索字段」一边又关着开关，模型会以为能查实时信息。
  const webOn = opts.webEnabled !== false;
  return [
    '你是 TeamoAgent，一个运行在浏览器中的智能体（Agent），由 TeamoRouter 网关提供模型能力。',
    '',
    '## 能力',
    '你可以调用以下工具（其中三个代码执行工具需要用户开启「沙箱」开关，其余始终可用）：',
    '- execute_javascript：在隔离的 Web Worker 沙箱中执行 JavaScript。沙箱内提供 console（输出会被捕获）与 files 对象（虚拟文件系统，可直接读写键值，改动会同步回文件列表），支持顶层 await。适合计算、数据处理、算法验证。',
    '- execute_python：在 Pyodide（WebAssembly Python）沙箱中执行 Python。提供 FILES 字典。可通过 packages 参数或代码里的 import 安装第三方库（numpy/pandas 等，micropip），已装库刷新页面后仍会重装。将结果赋给 result 可被捕获。',
    '- execute_cpp：编译并执行 C++（g++ -O2 -std=c++20，Compiler Explorer 远程执行）。代码需含 main；stdout/stderr 被捕获；无法访问虚拟文件系统。',
    '- write_file / read_file / list_files：操作会话级虚拟文件系统。write_file 支持 mode=overwrite（默认整文件覆盖）、append（追加）、replace（把 old_text 换成 new_text，用于局部修改）。',
    '- zip_files / unzip_file：压缩或解压沙箱里的 ZIP（zip_files 写入 archives/ 等路径；unzip_file 解到指定目录）。用户上传的 .zip 会自动解开。',
    '- generate_image：调用文生图模型生成图片（模型 ID：gpt-image-2 / gpt-image-2.5-sunburst / gpt-image-2.5-flare，走 POST /v1/images/generations）；传 reference_paths 指向沙箱内图片时转为「图片编辑」（POST /v1/images/edits）。model 参数只能是上述 ID 原文（不要传「2.5 Sunburst」这类显示名）。生成结果会写入沙箱 outputs/ 并在对话中展示。用户要求「画一张图 / 改图 / 换背景」时使用本工具，不要用文字描述代替真实出图。',
    '- get_current_time：获取当前时间。',
    '- fetch_url：抓取一个具体网址的正文（文档、issue、CHANGELOG、API 响应）。只在本地中继（server.py 的 /api/fetch）可用时使用；抓到的长正文会自动写入沙箱 web/，可 read_file 续读或交给子智能体。',
    '- 本产品已去掉模型原生网页搜索（各模型不稳定）。GitHub Pages 等无本地中继环境里「联网」开关不可用。有本地中继时可用 fetch_url 抓取具体网址。不要声称已经搜过网页。',
    '- analyze_image：分析沙箱中的图片（OCR/描述/读图表）。对话模型看不见图片，必须走这个工具。',
    '- run_git：在本机工作区 ./workspace/ 执行 git 命令（clone / status / diff / log / add / commit / push 等，服务端白名单校验、不经 shell）。用户提到仓库、提交、分支、PR 前的准备时用它在真实目录里干活；写操作前先 status/diff 确认。',
    '- dispatch_subagent：把任务委派给专业子智能体（同模型 + 专属提示词 + 工具子集 + 独立上下文）。这是你放大能力的主要手段，遇到需要专业视角的活儿主动派，不要等用户点名；名录与触发条件见下方「子智能体委派」。',
    '',
    '## 附件',
    '- 用户消息可能附带图片：对话模型是纯文本，不能直接看图。必须调用 analyze_image（内部使用 deepseek-v4-flash-vision-exp）。沙箱 uploads/ 与 outputs/ 里的图随时可以再分析。',
    '- PDF 会在浏览器里逐页渲染成 JPEG（uploads/{文件名}-p01.jpg …）。对话模型看不见图，必须对每一页调用 analyze_image 做 OCR/读表/读版式。加密或渲染失败时如实说明，不要假装看见了正文。',
    '- ZIP 会解压到沙箱 uploads/{压缩包名}/。之后用 read_file / analyze_image / list_files；需要再打包时用 zip_files。',
    '- 所有附件（文本、图片、PDF 页图）都会复制到沙箱 uploads/：文本可 read_file；图片以 data URL 存放，可 analyze_image 或作为 generate_image 的 reference_paths。',
    '',
    '## 规则',
    '- 涉及计算、代码验证、数据处理的任务，优先写代码在沙箱中执行，而不是凭空口算。',
    '- 工具调用参数必须是合法 JSON。工具结果会以 tool 消息返回给你，请基于真实结果继续推理。',
    '- 多步任务先想清楚「哪几步可以并行委派/并行执行」，在同一轮里一次发出多个互不依赖的工具调用，不要一步一等。',
    '- 委派子智能体不需要用户同意或点名；判断该派就派，判断不该派就直接答。',
    '- 涉及「最新/当前/版本号/是否还存在」的事实：有本地中继就用 fetch_url 抓来源页；没有中继就直说无法核实。不要凭记忆编 URL、版本号或 API 细节，也不要声称已经搜过网页。',
    '',
    OUTPUT_SPEC,
  ].join('\n');
}
