// 推理级别（独立文件，避免给 config/api 加新具名导出导致 Pages 混版缓存白屏）
export const REASONING_LEVELS = ['mini', 'low', 'medium', 'high', 'max', 'ultra'];

const CLAUDE_BUDGET = {
  mini: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  max: 16384,
  ultra: 32768,
};

// GPT：minimal / low / medium / high / xhigh
// Gemini 3 thinkingLevel：minimal / low / medium / high（更高档位映射到 high）
// Grok：常见 low / medium / high
const OPENAI_EFFORT = { mini: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'xhigh', ultra: 'xhigh' };
const GEMINI_EFFORT = { mini: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high', ultra: 'high' };
const GROK_EFFORT = { mini: 'low', low: 'low', medium: 'medium', high: 'high', max: 'high', ultra: 'high' };

const LABELS = { mini: 'Mini', low: 'Low', medium: 'Medium', high: 'High', max: 'Max', ultra: 'Ultra' };
const HINTS = {
  mini: 'Claude 1024 tok · GPT minimal',
  low: 'Claude 2048 · GPT/Gemini low',
  medium: '默认。Claude 4096 · GPT medium',
  high: 'Claude 8192 · GPT/Gemini high',
  max: 'Claude 16k · GPT xhigh',
  ultra: 'Claude 32k · GPT xhigh，最慢最贵',
};

export function normalizeReasoningLevel(v) {
  const s = String(v || '').toLowerCase();
  return REASONING_LEVELS.includes(s) ? s : 'medium';
}

export function reasoningLevelLabel(v) {
  return LABELS[normalizeReasoningLevel(v)];
}

export function reasoningLevelHint(v) {
  return HINTS[normalizeReasoningLevel(v)];
}

export function claudeThinkingBudget(level) {
  return CLAUDE_BUDGET[normalizeReasoningLevel(level)];
}

export function reasoningEffortFor(modelId, level) {
  const lv = normalizeReasoningLevel(level);
  const m = String(modelId || '').toLowerCase();
  if (m.startsWith('gemini')) return GEMINI_EFFORT[lv];
  if (m.startsWith('grok')) return GROK_EFFORT[lv];
  return OPENAI_EFFORT[lv];
}
