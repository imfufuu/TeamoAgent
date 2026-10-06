// ─── 智能调控输出温度系统（Adaptive Temperature Controller）────────────
// 职责：根据当前对话意图、Jev 路由结果、子智能体角色与工具循环阶段自动调控输出温度：
//   · 低温（0.15 ~ 0.25）：调用工具、编写代码、数学/SQL/正则、推理规划、架构设计
//   · 中低温（0.30）：实时事实核查、检索问答
//   · 均衡（0.65）：日常对话、概念讲解、常规问答
//   · 高温（0.80 ~ 0.95）：总结提炼任务、多智能体报告汇总、小说创作、诗歌散文与创意文案

export const TEMPERATURE_PROFILES = {
  code: {
    id: 'code',
    temperature: 0.15,
    label: '低温 · 代码/工具',
    description: '编写代码、调用工具或精确计算，使用低温保障语法与参数确定性',
  },
  planning: {
    id: 'planning',
    temperature: 0.25,
    label: '低温 · 推理规划',
    description: '逻辑推理、任务规划、架构设计与数学推导，使用低温保持严谨一致',
  },
  factual: {
    id: 'factual',
    temperature: 0.30,
    label: '低温 · 事实核查',
    description: '事实检索与技术核对，使用中低温抑制幻觉',
  },
  chat: {
    id: 'chat',
    temperature: 0.65,
    label: '均衡 · 日常对话',
    description: '日常交流与概念讲解，保持自然度与准确性平衡',
  },
  summary: {
    id: 'summary',
    temperature: 0.80,
    label: '高温 · 总结提炼',
    description: '任务总结、会议复盘与多源结果综合，提升概括流畅度与表达力',
  },
  creative: {
    id: 'creative',
    temperature: 0.95,
    label: '高温 · 创意写作',
    description: '小说创作、故事续写、诗歌散文与创意风暴，激发丰富词汇与想象力',
  },
};

const CREATIVE_SUBAGENTS = new Set(['copywriter', 'brainstormer']);
const SUMMARY_SUBAGENTS = new Set(['doc-writer', 'explainer', 'translator', 'prompt-engineer']);
const PLANNING_SUBAGENTS = new Set(['software-architect', 'api-designer']);
const CODE_SUBAGENTS = new Set([
  'code-reviewer', 'debugger', 'security-auditor', 'test-engineer',
  'perf-optimizer', 'refactor-expert', 'data-analyst', 'mathematician',
  'sql-expert', 'regex-expert',
]);

// 小说创作 / 文学创意类匹配（排除「小说阅读器代码」等编程任务）
const CREATIVE_RE = /(小说|故事|写一篇|短篇|长篇|连载|章节|续写|人物设定|世界观|剧本|分镜|诗歌|古诗|现代诗|词牌|散文|随笔|童话|寓言|科幻故事|奇幻|武侠|仙侠|悬疑故事|言情|脑洞|头脑风暴|创意方案|广告语|品牌文案|营销文案|润色文笔|文学创作|角色扮演|\b(?:novel|fiction|short\s+story|creative\s+writing|poem|poetry|screenplay|storytelling|brainstorm|copywriting)\b)/i;

// 总结 / 提炼 / 复盘任务匹配
const SUMMARY_RE = /(总结|概括|汇总|提炼|复盘|综述|归纳|摘要|精简总结|核心要点|会议纪要|周报|日报|月报|述职报告|读后感|观后感|\b(?:summarize|summary|tl;?dr|recap|takeaways|executive\s+summary|synthesize)\b)/i;

// 代码编写 / 工具调用匹配
const CODE_TOOL_RE = /(```|写.{0,10}(?:代码|程序|函数|脚本|组件|接口|算法|单测|测试|正则|SQL)|实现|重构|调试|报错|异常|堆栈|\bbug\b|stack\s*trace|编译|沙箱|execute_javascript|execute_python|execute_cpp|execute_sql|write_file|read_file|list_files|run_git|fetch_url|analyze_image|generate_image|render_mermaid|render_dot|zip_files|unzip_file|\b(?:python|javascript|typescript|c\+\+|rust|golang|java|html|css|sql|regex|dockerfile|shell|bash|function|class|def|import|const|let)\b|调用工具|跑一下|运行一下)/i;

// 推理 / 规划 / 架构 / 数学推导匹配
const PLAN_REASON_RE = /(推理|规划|计划|方案|路线图|架构|系统设计|模块划分|技术选型|步骤拆解|拆解任务|排错思路|根因分析|推导|证明|引理|定理|数学计算|方程|微积分|概率|统计分析|逻辑题|权衡分析|对比分析|\b(?:plan|planning|roadmap|architecture|reasoning|proof|derive|theorem|strategy|trade-?off|step-by-step)\b)/i;

function extractLastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && !m.silent) {
      return String(m.text || (typeof m.content === 'string' ? m.content : '') || '');
    }
  }
  return '';
}

function inspectRecentTools(messages) {
  const list = messages || [];
  if (!list.length) return { afterTools: false, hadError: false, toolNames: [] };
  let i = list.length - 1;
  const toolNames = [];
  let hadError = false;
  while (i >= 0 && list[i] && list[i].role === 'tool') {
    const tm = list[i];
    if (tm.name) toolNames.push(tm.name);
    const body = String(tm.content || '');
    if (
      body.startsWith('工具执行失败')
      || body.startsWith('图像模型调用失败')
      || body.startsWith('图像调用在发起前失败')
      || /── 错误 ──|不是合法 JSON/.test(body)
    ) {
      hadError = true;
    }
    i--;
  }
  return { afterTools: toolNames.length > 0, hadError, toolNames };
}

function makeResult(profileKey, reasonOverride) {
  const prof = TEMPERATURE_PROFILES[profileKey] || TEMPERATURE_PROFILES.chat;
  return {
    temperature: prof.temperature,
    profile: prof.id,
    label: prof.label,
    reason: reasonOverride || prof.description,
  };
}

/**
 * 智能计算本轮 LLM 请求的最佳输出温度。
 * @param {object} opts
 * @param {string} [opts.text] 当前用户提问文本
 * @param {Array}  [opts.messages] 对话上下文消息列表
 * @param {object} [opts.plan] Jev System-1 的规划结果
 * @param {number} [opts.iteration] 当前工具循环迭代轮次（1 起）
 * @param {string} [opts.phase] 显式阶段（'code' | 'tool' | 'planning' | 'summary' | 'creative' | 'factual' | 'chat' | 'titler'）
 * @param {string} [opts.subagentId] 子智能体 ID（在 runSubagent 中传入）
 */
export function resolveTemperature({
  text = '',
  userText = '',
  messages = null,
  plan = null,
  iteration = 1,
  phase = '',
  subagentId = '',
} = {}) {
  // 1. 显式阶段优先
  if (phase) {
    const p = String(phase).toLowerCase();
    if (p === 'titler') return makeResult('planning', '自动生成简短会话标题，采用低温保持精炼');
    if (p === 'tool') return makeResult('code', '工具调用阶段采用低温保障参数准确');
    if (p === 'reasoning') return makeResult('planning');
    if (TEMPERATURE_PROFILES[p]) return makeResult(p);
  }

  // 2. 子智能体专属温度
  if (subagentId) {
    const sid = String(subagentId).toLowerCase();
    if (CREATIVE_SUBAGENTS.has(sid)) return makeResult('creative', `子智能体 ${sid} 执行创意发散任务`);
    if (SUMMARY_SUBAGENTS.has(sid)) return makeResult('summary', `子智能体 ${sid} 执行文档总结/讲解任务`);
    if (PLANNING_SUBAGENTS.has(sid)) return makeResult('planning', `子智能体 ${sid} 执行架构与接口规划任务`);
    if (CODE_SUBAGENTS.has(sid)) return makeResult('code', `子智能体 ${sid} 执行代码/计算/审计任务`);
  }

  const query = String(text || userText || extractLastUserText(messages) || '').trim();
  const recentTools = inspectRecentTools(messages);

  // 3. 工具循环后续轮次（iteration > 1 或刚收到 tool 消息结果）
  if ((Number(iteration) > 1 || recentTools.afterTools) && recentTools.afterTools) {
    if (recentTools.hadError) {
      return makeResult('code', '工具返回异常，保持低温修正参数或代码');
    }
    const synthesizedTools = recentTools.toolNames.some((n) =>
      n === 'dispatch_subagent' || n === 'analyze_image' || n === 'analyze_pdf' || n === 'analyze_video' || n === 'fetch_url' || n === 'search_web' || n === 'crawl_site' || n === 'generate_image'
    );
    if (CREATIVE_RE.test(query) && !CODE_TOOL_RE.test(query)) {
      return makeResult('creative', '基于工具结果继续文学/创意写作');
    }
    if (SUMMARY_RE.test(query) || synthesizedTools) {
      return makeResult('summary', '汇总子智能体报告或工具执行结果并生成最终总结');
    }
  }

  // 4. 文本意图与 Jev 路由联合判定
  const hasCodeSignal = CODE_TOOL_RE.test(query)
    || !!(plan && (plan.route === 'tools' || plan.route === 'image' || (plan.needCode != null && plan.needCode >= 0.55) || (plan.needImage != null && plan.needImage >= 0.55)));
  const hasCreativeSignal = CREATIVE_RE.test(query);
  const hasSummarySignal = SUMMARY_RE.test(query);
  const hasPlanSignal = PLAN_REASON_RE.test(query)
    || !!(plan && ((plan.difficulty != null && plan.difficulty >= 4) || (plan.needDispatch != null && plan.needDispatch >= 0.55)));
  const hasSearchSignal = !!(plan && (plan.route === 'search' || (plan.needSearch != null && plan.needSearch >= 0.55)));

  // 小说创作 / 创意写作（非写代码任务）→ 高温 0.95
  if (hasCreativeSignal && !CODE_TOOL_RE.test(query)) {
    return makeResult('creative');
  }

  // 总结任务（非纯写代码任务）→ 高温 0.80
  if (hasSummarySignal && !CODE_TOOL_RE.test(query)) {
    return makeResult('summary');
  }

  // 调用工具 / 编写代码 → 低温 0.15
  if (hasCodeSignal) {
    return makeResult('code');
  }

  // 推理规划 / 架构设计 / 数学推导 → 低温 0.25
  if (hasPlanSignal) {
    return makeResult('planning');
  }

  // 实时检索 / 事实核查 → 中低温 0.30
  if (hasSearchSignal) {
    return makeResult('factual');
  }

  // 默认常规对话 → 均衡 0.65
  return makeResult('chat');
}

/**
 * 判断指定模型与当前思考状态是否允许在请求体中下发自定义 temperature。
 * - Anthropic /v1/messages 开启 extended thinking 时协议硬性要求不能改 temperature（否则 400）
 * - Jev 决策模型不接受 temperature
 */
export function canSendTemperature(modelOrOpts, opts = {}) {
  const isObj = modelOrOpts && typeof modelOrOpts === 'object';
  const modelId = isObj ? modelOrOpts.model : modelOrOpts;
  const withThinking = isObj ? !!modelOrOpts.withThinking : !!opts.withThinking;
  const protocol = isObj ? (modelOrOpts.protocol || '') : (opts.protocol || '');
  const m = String(modelId || '').toLowerCase();
  if (!m || m === 'jev' || m.includes('typesafe')) return false;
  const isAnthropic = protocol === 'anthropic' || m.startsWith('claude');
  if (isAnthropic && withThinking) return false;
  return true;
}
