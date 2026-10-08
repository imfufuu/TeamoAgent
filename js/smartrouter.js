// ─── 智能路由器：根据任务类型和难度自动选择最合适的模型 ─────────────────
// 用户可见服务提供商，但不暴露具体模型 ID（满足用户隐私/抽象需求）。
// 路由策略为本地启发式（0ms 决策），不需要额外网络请求。

import { SMART_ROUTER_ID } from './config.js?v=2026.10.5.35';

// 路由类别
const TASK_CATEGORY = {
  CODING: 'coding',
  MATH: 'math',
  WRITING: 'writing',
  ANALYSIS: 'analysis',
  CHAT: 'chat',
  SEARCH: 'search',
  IMAGE: 'image',
};

// 难度
const DIFFICULTY = { EASY: 'easy', MEDIUM: 'medium', HARD: 'hard' };

// 模型路由表：按 provider 选，不暴露具体模型 ID 给用户
// 实际 ID 在最后选定时解析，此处只是策略。
// 选模原则（简化启发式）：
//   - 代码任务（含多文件/调试/沙箱执行）→ Anthropic Claude 系（Sonnet / Opus 视难度）
//   - 数学/推理/复杂分析 → OpenAI GPT 或 DeepSeek（高难度用 Sol/Opus 级别）
//   - 多语言闲聊/快速问答 → 低价档（deepseek-v4-flash、gemini-flash、glm-flash）
//   - 生图 / 识图 相关 → 不改变生图模型，对话仍选普通模型
//   - 简单问题 → 低价快速模型

// 可用模型（从常用模型中选）——与 FALLBACK_MODELS 保持一致
function classifyTask(text) {
  const s = String(text || '').toLowerCase();
  const codeHints = /(?:代码|编程|写\s*(?:个|一)?\s*(?:函数|程序|脚本)|bug|调试|debug|implement|function|class\s+\w+|def\s+\w+|import\s+|const\s+\w+\s*=|python|javascript|typescript|rust|golang|c\+\+|java|html|css|react|vue|node\.js|沙箱|执行|写文件|代码|正则|regex|算法|algorithm|sql|数据库|api)/;
  const mathHints = /(?:数学|证明|计算|推导|公式|方程|积分|微分|求导|概率|统计|微积分|线性代数|几何|物理|化学|latex|katex|\$\$|\\frac|\\sum|\\int|proof|theorem|calculate|compute|math|equation|formula)/;
  const writingHints = /(?:写\s*(?:一)?(?:篇|段|个)?\s*(?:文章|作文|文案|邮件|信|报告|总结|摘要|故事|小说|诗|博客)|translate|翻译|润色|改写|写作|创作|文案|策划|邮件|信函|总结|汇报)/;
  const analysisHints = /(?:分析|解释|对比|比较|评价|评估|为什么|怎么|如何|原因|优缺点|优劣|review|分析|解读|评价|评论)/;
  const imageHints = /(?:生图|画图|图片|图像|生成图片|draw|generate.*image|画一?张|海报|插画)/;

  if (imageHints.test(s)) return { category: TASK_CATEGORY.IMAGE, difficulty: DIFFICULTY.MEDIUM };
  if (codeHints.test(s)) {
    // 代码难度判断：多文件/架构/复杂算法 → hard；简单片段/解释 → easy
    const hard = /(?:架构|设计|重构|优化|性能|并发|多线程|分布式|系统|项目|多个文件|全套|完整|全量|重构|refactor|architect|design pattern|scalable|concurrent|distributed|performance)/.test(s)
      || s.length > 800;
    const easy = /(?:解释|什么是|怎么用|简单|小|一行|帮我看|报错|error.*:)/.test(s) && s.length < 300;
    return { category: TASK_CATEGORY.CODING, difficulty: hard ? DIFFICULTY.HARD : (easy ? DIFFICULTY.EASY : DIFFICULTY.MEDIUM) };
  }
  if (mathHints.test(s)) {
    const hard = /(?:证明|复杂|高等|大学|竞赛|奥林匹克|研究生|推导|积分|微分方程|线性代数|prove|theorem|complicated)/.test(s)
      || s.length > 600;
    return { category: TASK_CATEGORY.MATH, difficulty: hard ? DIFFICULTY.HARD : DIFFICULTY.MEDIUM };
  }
  if (writingHints.test(s)) {
    return { category: TASK_CATEGORY.WRITING, difficulty: s.length > 500 ? DIFFICULTY.MEDIUM : DIFFICULTY.EASY };
  }
  if (analysisHints.test(s)) {
    return { category: TASK_CATEGORY.ANALYSIS, difficulty: s.length > 400 ? DIFFICULTY.MEDIUM : DIFFICULTY.EASY };
  }
  return { category: TASK_CATEGORY.CHAT, difficulty: DIFFICULTY.EASY };
}

// 实际映射：(category, difficulty) → 真实模型 ID
function pickRealModel(category, difficulty, availableModels) {
  const available = new Set((availableModels || []).map((m) => (typeof m === 'string' ? m : m.id)));
  const have = (id) => available.has(id);
  // 按优先顺序尝试（越靠前越优先）
  const pick = (candidates) => {
    for (const id of candidates) if (have(id)) return id;
    return null;
  };

  switch (category) {
    case TASK_CATEGORY.CODING:
      if (difficulty === DIFFICULTY.HARD) {
        return pick(['claude-opus-5-5', 'claude-opus-5', 'gpt-6-astra', 'claude-sonnet-5-5', 'gpt-6.1-sol']);
      }
      if (difficulty === DIFFICULTY.MEDIUM) {
        return pick(['claude-sonnet-5-5', 'claude-sonnet-5', 'gpt-6.1-sol', 'deepseek-v4-pro', 'gpt-6-sol']);
      }
      return pick(['deepseek-v4-flash', 'gemini-3.8-flash', 'glm-5.3-flash', 'claude-haiku-4-5', 'gpt-6-luna']);

    case TASK_CATEGORY.MATH:
      if (difficulty === DIFFICULTY.HARD) {
        return pick(['gpt-6.1-sol', 'claude-opus-5-5', 'gpt-6-astra', 'deepseek-v4-pro', 'claude-sonnet-5-5']);
      }
      return pick(['gpt-6-sol', 'deepseek-v4-flash', 'claude-sonnet-5', 'grok-4.6', 'gemini-3.8-flash']);

    case TASK_CATEGORY.WRITING:
      if (difficulty === DIFFICULTY.MEDIUM) {
        return pick(['claude-sonnet-5-5', 'claude-sonnet-5', 'gpt-6-sol', 'gemini-3.8-flash', 'kimi-k3']);
      }
      return pick(['deepseek-v4-flash', 'gemini-3.8-flash', 'glm-5.3-flash', 'gpt-6-luna']);

    case TASK_CATEGORY.ANALYSIS:
      if (difficulty === DIFFICULTY.MEDIUM) {
        return pick(['claude-sonnet-5-5', 'gpt-6.1-sol', 'claude-sonnet-5', 'deepseek-v4-pro']);
      }
      return pick(['deepseek-v4-flash', 'gemini-3.8-flash', 'gpt-6-luna', 'glm-5.3-flash']);

    case TASK_CATEGORY.IMAGE:
      // 图相关对话依然用强模型
      return pick(['claude-sonnet-5-5', 'gpt-6.1-sol', 'gemini-3.8-flash']);

    case TASK_CATEGORY.CHAT:
    default:
      // 简单闲聊优先选支持 thinking/reasoning 的中档模型（DeepSeek 免费档已下架：不返回可见思考正文，
      // 会让「思考过程」一直显示「已思考」而没有内容）
      return pick(['claude-sonnet-5', 'deepseek-v4-flash', 'gemini-3.8-flash', 'gpt-6-luna', 'glm-5.3-flash']);
  }
}

// 路由记录：每轮记录一次选择，供用户事后查看
const ROUTE_LABELS = {
  [TASK_CATEGORY.CODING]: '代码',
  [TASK_CATEGORY.MATH]: '推理/数学',
  [TASK_CATEGORY.WRITING]: '写作',
  [TASK_CATEGORY.ANALYSIS]: '分析',
  [TASK_CATEGORY.CHAT]: '对话',
  [TASK_CATEGORY.SEARCH]: '检索',
  [TASK_CATEGORY.IMAGE]: '图像',
};
const DIFF_LABELS = {
  [DIFFICULTY.EASY]: '简单',
  [DIFFICULTY.MEDIUM]: '中等',
  [DIFFICULTY.HARD]: '困难',
};

export function routeModel(userText, availableModels) {
  const { category, difficulty } = classifyTask(userText);
  const modelId = pickRealModel(category, difficulty, availableModels);
  return {
    router: true,
    category,
    difficulty,
    categoryLabel: ROUTE_LABELS[category] || '对话',
    difficultyLabel: DIFF_LABELS[difficulty] || '简单',
    chosenModel: modelId || 'claude-sonnet-5',
    chosenProvider: providerOfForRouter(modelId || 'claude-sonnet-5'),
  };
}

// 独立的 providerOf（避免循环依赖）
function providerOfForRouter(id) {
  const m = String(id || '').toLowerCase();
  if (m.startsWith('claude')) return 'Anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'OpenAI';
  if (m.startsWith('gemini')) return 'Google';
  if (m.startsWith('deepseek')) return 'DeepSeek';
  if (m.startsWith('glm')) return 'GLM';
  if (m.startsWith('kimi') || m.startsWith('moonshot')) return 'Kimi';
  if (m.startsWith('grok')) return 'Grok';
  return '其他';
}

export function isSmartRouter(modelId) {
  return modelId === SMART_ROUTER_ID;
}

// 路由器徽章的图标 & 显示名
// 路由器图标 = TeamoRouter 产品 LOGO（粗实线外环 + 三段轨道弧 + 三个卫星点 + 实心核心）。
// 2026.10.5.35：对照产品 LOGO 原图重新量过——轨道半径 8 → 8.6（更贴近外环）、弧线 2.6 → 2.5、缺口半角 10°、
// 卫星点 r 2.1 → 2.05 并外移 0.3 成「鼓包」、外环 2.1 → 2.3、核心 r 3.1 → 3.0；几何由 tools 内脚本按角度算出，不要手改坐标。
export const SMART_ROUTER_LABEL = 'smart_router';
export const SMART_ROUTER_PROVIDER_LABEL = 'TEAMOROUTER';
// 任何要把模型 ID 给用户看的地方都走这里：路由器统一显示 smart_router（用户要求：所有位置都用这个名字，不用中文「智能」），/system 显示 system-commands，其余原样
export function modelDisplayName(modelId) {
  if (modelId === SMART_ROUTER_ID) return SMART_ROUTER_LABEL;
  if (modelId === '__system__') return 'system-commands';
  return String(modelId || '');
}
export const ROUTER_ICON_SVG = '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="16" cy="16" r="13.3" stroke="currentColor" stroke-width="2.3"/><path d="M17.493 7.531 A8.600 8.600 0 0 1 24.081 18.941" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/><path d="M22.588 21.528 A8.600 8.600 0 0 1 9.412 21.528" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/><path d="M7.919 18.941 A8.600 8.600 0 0 1 14.507 7.531" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/><circle cx="16" cy="16" r="3" fill="currentColor"/><circle cx="23.708" cy="11.550" r="2.05" fill="currentColor"/><circle cx="16.000" cy="24.900" r="2.05" fill="currentColor"/><circle cx="8.292" cy="11.550" r="2.05" fill="currentColor"/></svg>';
