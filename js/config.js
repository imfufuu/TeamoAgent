// ─── TeamoRouter 接入配置 ──────────────────────────────────────────────
// 调研自 https://teamorouter.cn/zh/docs/api-integration（2026-09 版）
//   · Base URL: https://api.teamorouter.com
//   · Anthropic 原生协议: POST /v1/messages   (x-api-key + anthropic-version)
//   · OpenAI 兼容协议:    POST /v1/chat/completions (Authorization: Bearer)
//   · 文生图（GPT Image 2）: POST /v1/images/generations (Bearer)，响应 data[].b64_json
//   · 图生文（多模态 / vision）: 各协议原生 content 块（见 api.js 构建逻辑）
//   · 模型列表:           GET  /v1/models
//   · 官方建议: Claude 模型务必走 Anthropic 原生协议，其余模型走 OpenAI 兼容协议

export const BASE_URL = 'https://api.teamorouter.com';
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
  { id: 'gpt-image-2',          provider: 'OpenAI', image: true },  // 文生图（POST /v1/images/generations）
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
  // GLM（智谱）
  { id: 'glm-5.3-flash',       provider: 'GLM' },
  { id: 'glm-5.3-flash-free',  provider: 'GLM', free: true },
  { id: 'glm-5.3',             provider: 'GLM' },
  { id: 'glm-5.2',             provider: 'GLM' },
  // xAI
  { id: 'grok-4.6',            provider: 'Grok' },
];

export const PROVIDER_ORDER = ['Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'GLM', 'Grok', '其他'];

// 根据模型 ID 推断供应商
export function providerOf(modelId) {
  const m = (modelId || '').toLowerCase();
  if (m.startsWith('claude')) return 'Anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('chatgpt')) return 'OpenAI';
  if (m.startsWith('gemini')) return 'Google';
  if (m.startsWith('deepseek')) return 'DeepSeek';
  if (m.startsWith('glm')) return 'GLM';
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
export function supportsVision(modelId) {
  const id = String(modelId || '').toLowerCase();
  return /^claude-/.test(id) || /^gpt-(4o|4\.1|5|6)/.test(id) || /^gemini-/.test(id)
    || /vision|(^|-)vl(-|$)|4v\b|4\.5v/.test(id);
}

// 文生图模型判断（GPT Image 2 等）：兜底列表标记 image:true，或按 id 模式兜底
export function isImageModel(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (/(^|-)image(-|$)/.test(m)) return true;
  const hit = FALLBACK_MODELS.find((x) => x.id === modelId);
  return !!(hit && hit.image);
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

export function systemPrompt(now = new Date()) {
  return [
    '你是 TeamoAgent，一个运行在浏览器中的智能体（Agent），由 TeamoRouter 网关提供模型能力。',
    '',
    '## 能力',
    '当沙箱开启时，你可以调用以下工具：',
    '- execute_javascript：在隔离的 Web Worker 沙箱中执行 JavaScript。沙箱内提供 console（输出会被捕获）与 files 对象（虚拟文件系统，可直接读写键值），支持顶层 await。适合计算、数据处理、算法验证。',
    '- execute_python：在 Pyodide（WebAssembly Python）沙箱中执行 Python。提供 FILES 字典（虚拟文件系统），将结果赋给全局变量 result 可被捕获。运行时常驻，仅会话首次调用需下载（10-30 秒）。',
    '- execute_cpp：编译并执行 C++（g++ -O2 -std=c++20，Compiler Explorer 远程执行）。代码需含 main；stdout/stderr 被捕获；无法访问虚拟文件系统。',
    '- write_file / read_file / list_files：操作会话级虚拟文件系统。',
    '- get_current_time：获取当前时间。',
    '',
    '## 附件',
    '- 用户消息可能附带图片（多模态模型可直接识图；若模型不支持视觉，请说明并建议切换模型）。',
    '- 文本附件已自动写入沙箱 uploads/ 目录，可用 read_file 或沙箱代码读取全文。',
    '',
    '## 规则',
    '- 涉及计算、代码验证、数据处理的任务，优先写代码在沙箱中执行，而不是凭空口算。',
    '- 工具调用参数必须是合法 JSON。工具结果会以 tool 消息返回给你，请基于真实结果继续推理。',
    '',
    OUTPUT_SPEC,
    '',
    `当前时间：${now.toISOString()}`,
  ].join('\n');
}
