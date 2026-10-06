// ─── 模型官方价格表与费用预估（USD）──────────────────────────────────────
// 数据来源：TeamoRouter 官方定价接口（GET /v1/models/pricing 的 list_cost 字段与 per_call_tiers）
// 独立模块：不修改 config.js / api.js 的既有导出列表，避免 Pages 混版缓存下 ESM link 失败。

export const VISION_MODEL_ID = 'deepseek-v4-flash-vision-exp';

// 对话/推理模型官方价格（USD / 1M tokens）
export const MODEL_PRICING = {
  // Anthropic Claude
  'claude-opus-5-5':          { input: 4.0,   output: 20.0,  cachedInput: 0.2,   cacheCreation: 5.0 },
  'claude-sonnet-5-5':        { input: 2.0,   output: 10.0,  cachedInput: 0.2,   cacheCreation: 2.5 },
  'claude-fable-5-1':         { input: 10.0,  output: 50.0,  cachedInput: 0.25,  cacheCreation: 12.5 },
  'claude-opus-5':            { input: 5.0,   output: 25.0,  cachedInput: 0.5,   cacheCreation: 6.25 },
  'claude-fable-5':           { input: 10.0,  output: 50.0,  cachedInput: 1.0,   cacheCreation: 12.5 },
  'claude-sonnet-5':          { input: 2.0,   output: 10.0,  cachedInput: 0.2,   cacheCreation: 2.5 },
  'claude-opus-4-8':          { input: 5.0,   output: 25.0,  cachedInput: 0.5,   cacheCreation: 6.25 },
  'claude-opus-4-7':          { input: 5.0,   output: 25.0,  cachedInput: 0.5,   cacheCreation: 6.25 },
  'claude-opus-4-6':          { input: 5.0,   output: 25.0,  cachedInput: 0.5,   cacheCreation: 6.25 },
  'claude-sonnet-4-6':        { input: 3.0,   output: 15.0,  cachedInput: 0.3,   cacheCreation: 3.75 },
  'claude-haiku-4-5':         { input: 1.0,   output: 5.0,   cachedInput: 0.1,   cacheCreation: 1.25 },
  'claude-haiku-4-5-20251001':{ input: 1.0,   output: 5.0,   cachedInput: 0.1,   cacheCreation: 1.25 },

  // OpenAI GPT（支持 Fast 模式 2x 官方价；272k 以上上下文阶梯计费）
  'gpt-6-astra':              { input: 10.0,  output: 50.0,  cachedInput: 1.0,   cacheCreation: 12.5,  fastMultiplier: 2.0, contextTier: true },
  'gpt-6.1-sol':              { input: 2.0,   output: 10.0,  cachedInput: 0.1,   cacheCreation: 2.5,   fastMultiplier: 2.0, contextTier: true },
  'gpt-6-sol':                { input: 2.0,   output: 10.0,  cachedInput: 0.2,   cacheCreation: 2.5,   fastMultiplier: 2.0, contextTier: true },
  'gpt-6-luna':               { input: 0.1,   output: 0.5,   cachedInput: 0.01,  cacheCreation: 0.125, fastMultiplier: 2.0, contextTier: true },
  'gpt-5.6-sol':              { input: 5.0,   output: 30.0,  cachedInput: 0.5,   cacheCreation: 6.25,  fastMultiplier: 2.0, contextTier: true },
  'gpt-5.6-terra':            { input: 2.0,   output: 12.0,  cachedInput: 0.2,   cacheCreation: 2.5,   fastMultiplier: 2.0, contextTier: true },
  'gpt-5.6-luna':             { input: 0.2,   output: 1.2,   cachedInput: 0.02,  cacheCreation: 0.25,  fastMultiplier: 2.0, contextTier: true },
  'gpt-5.5':                  { input: 5.0,   output: 30.0,  cachedInput: 0.5,   fastMultiplier: 2.0,   contextTier: true },
  'gpt-5.4':                  { input: 2.5,   output: 15.0,  cachedInput: 0.25,  fastMultiplier: 2.0,   contextTier: true },
  'gpt-5.4-mini':             { input: 0.75,  output: 4.5,   cachedInput: 0.075, fastMultiplier: 2.0 },

  // Google Gemini
  'gemini-3.8-flash':         { input: 0.75,  output: 3.75,  cachedInput: 0.075 },
  'gemini-3.7-flash':         { input: 0.75,  output: 3.75,  cachedInput: 0.075 },
  'gemini-3.6-flash':         { input: 0.75,  output: 3.75,  cachedInput: 0.075 },
  'gemini-3.5-flash':         { input: 1.5,   output: 9.0,   cachedInput: 0.15 },
  'gemini-3.5-flash-lite':    { input: 0.3,   output: 2.5,   cachedInput: 0.03 },
  'gemini-3.1-pro-preview':   { input: 2.0,   output: 12.0,  cachedInput: 0.2 },

  // DeepSeek
  'deepseek-flash':           { input: 0.3,   output: 1.2,   cachedInput: 0.006 },
  'deepseek-flash-free':      { input: 0.3,   output: 1.2,   cachedInput: 0.006, freeTier: true },
  'deepseek-v4-pro':          { input: 1.32,  output: 3.96,  cachedInput: 0.044 },
  'deepseek-v4-pro-260425':   { input: 1.74,  output: 3.48,  cachedInput: 0.145 },
  'deepseek-v4-flash':        { input: 0.44,  output: 1.32,  cachedInput: 0.014 },
  'deepseek-v4-flash-free':   { input: 0.44,  output: 1.32,  cachedInput: 0.014, freeTier: true },

  // Zhipu GLM
  'glm-5.3':                  { input: 1.4,   output: 4.4,   cachedInput: 0.26 },
  'glm-5.3-flash':            { input: 0.114, output: 0.4,   cachedInput: 0.03 },
  'glm-5.3-flash-free':       { input: 0.114, output: 0.4,   cachedInput: 0.03,  freeTier: true },
  'glm-5.2':                  { input: 1.4,   output: 4.4,   cachedInput: 0.26 },

  // Moonshot Kimi
  'kimi-k3':                  { input: 3.0,   output: 15.0,  cachedInput: 0.3 },
  'kimi-k3[1M]':              { input: 3.0,   output: 15.0,  cachedInput: 0.3 },

  // xAI Grok
  'grok-4.6':                 { input: 2.0,   output: 6.0,   cachedInput: 0.5 },

  // TypeSafe Jev（System One）
  'jev':                      { input: 0.042, output: 0.0 },
  'typesafe-ai/jev':          { input: 0.042, output: 0.0 },
};

// 识图模型专用官方价格表（USD / 1M tokens）
export const VISION_MODEL_PRICING = {
  'deepseek-v4-flash-vision-exp': {
    id: 'deepseek-v4-flash-vision-exp',
    label: 'DeepSeek V4 Flash Vision Exp',
    input: 0.44,
    output: 1.32,
    cachedInput: 0.014,
    defaultTokensPerImage: 1500,
  },
};

// 生图模型专用官方价格表（含按张阶梯官方价 per_call_tiers 与按 token 官方价）
export const IMAGE_MODEL_PRICING = {
  'gpt-image-2.5-sunburst': {
    id: 'gpt-image-2.5-sunburst',
    label: 'GPT Image 2.5 Sunburst',
    mode: 'tier',
    input: 5.0,
    imageInput: 8.0,
    output: 30.0,
    cachedInput: 1.25,
    tiers: { '1k': 0.06, '2k': 0.20, '4k': 0.25 },
  },
  'gpt-image-2.5-flare': {
    id: 'gpt-image-2.5-flare',
    label: 'GPT Image 2.5 Flare',
    mode: 'tier',
    input: 5.0,
    imageInput: 8.0,
    output: 30.0,
    cachedInput: 1.25,
    tiers: { '1k': 0.06, '2k': 0.20, '4k': 0.25 },
  },
  'gpt-image-2': {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    mode: 'tier',
    input: 5.0,
    imageInput: 8.0,
    output: 30.0,
    cachedInput: 1.25,
    tiers: { '1k': 0.06, '2k': 0.20, '4k': 0.25 },
  },
  'gemini-3.1-flash-image': {
    id: 'gemini-3.1-flash-image',
    label: 'Nano Banana 2',
    mode: 'token',
    input: 0.5,
    imageInput: 0.5,
    output: 60.0,
    defaultInputTokens: 64,
    defaultOutputTokensPerImage: 1290, // 1290 * $60 / 1M ≈ $0.0774 / 张
  },
};

/** 归一化模型 ID（剥离 [1M] / (fast) 等后缀） */
export function normalizeModelKey(modelId) {
  const raw = String(modelId || '').trim().toLowerCase();
  const isFast = /\(fast\)/i.test(raw);
  const base = raw
    .replace(/\s*\(fast\)\s*$/i, '')
    .replace(/\[1m\]$/i, '')
    .trim();
  return { base, isFast };
}

/** 查询任意模型的官方价格配置 */
export function getModelPricing(modelId) {
  const { base, isFast } = normalizeModelKey(modelId);
  if (!base) return null;
  if (VISION_MODEL_PRICING[base]) return { ...VISION_MODEL_PRICING[base], kind: 'vision' };
  if (IMAGE_MODEL_PRICING[base]) return { ...IMAGE_MODEL_PRICING[base], kind: 'image' };
  if (MODEL_PRICING[base]) return { ...MODEL_PRICING[base], id: base, kind: 'chat', isFast };
  // 家族前缀兜底（未来新小版本上线时按同系官方基准价估算）
  if (base.startsWith('claude-opus-5-5')) return { input: 4.0, output: 20.0, cachedInput: 0.2, id: base, kind: 'chat' };
  if (base.startsWith('claude-fable')) return { input: 10.0, output: 50.0, cachedInput: 0.25, id: base, kind: 'chat' };
  if (base.startsWith('claude-opus')) return { input: 5.0, output: 25.0, cachedInput: 0.5, id: base, kind: 'chat' };
  if (base.startsWith('claude-sonnet-5')) return { input: 2.0, output: 10.0, cachedInput: 0.2, id: base, kind: 'chat' };
  if (base.startsWith('claude-sonnet')) return { input: 3.0, output: 15.0, cachedInput: 0.3, id: base, kind: 'chat' };
  if (base.startsWith('claude-haiku')) return { input: 1.0, output: 5.0, cachedInput: 0.1, id: base, kind: 'chat' };
  if (base.startsWith('gpt-6-astra')) return { input: 10.0, output: 50.0, cachedInput: 1.0, fastMultiplier: 2.0, id: base, kind: 'chat', isFast };
  if (base.startsWith('gpt-6-luna')) return { input: 0.1, output: 0.5, cachedInput: 0.01, fastMultiplier: 2.0, id: base, kind: 'chat', isFast };
  if (base.startsWith('gpt-6')) return { input: 2.0, output: 10.0, cachedInput: 0.2, fastMultiplier: 2.0, id: base, kind: 'chat', isFast };
  if (base.startsWith('gpt-5.6-sol') || base.startsWith('gpt-5.5')) return { input: 5.0, output: 30.0, cachedInput: 0.5, fastMultiplier: 2.0, id: base, kind: 'chat', isFast };
  if (base.startsWith('gpt-5.6-terra')) return { input: 2.0, output: 12.0, cachedInput: 0.2, fastMultiplier: 2.0, id: base, kind: 'chat', isFast };
  if (base.startsWith('gpt-5.6-luna')) return { input: 0.2, output: 1.2, cachedInput: 0.02, fastMultiplier: 2.0, id: base, kind: 'chat', isFast };
  if (base.startsWith('gpt-5.4-mini')) return { input: 0.75, output: 4.5, cachedInput: 0.075, fastMultiplier: 2.0, id: base, kind: 'chat', isFast };
  if (base.startsWith('gpt-5')) return { input: 2.5, output: 15.0, cachedInput: 0.25, fastMultiplier: 2.0, id: base, kind: 'chat', isFast };
  if (base.startsWith('gpt-image')) return { ...IMAGE_MODEL_PRICING['gpt-image-2.5-sunburst'], id: base, kind: 'image' };
  if (base.includes('flash-image')) return { ...IMAGE_MODEL_PRICING['gemini-3.1-flash-image'], id: base, kind: 'image' };
  if (base.startsWith('gemini-3.1-pro')) return { input: 2.0, output: 12.0, cachedInput: 0.2, id: base, kind: 'chat' };
  if (base.startsWith('gemini-3.5-flash-lite')) return { input: 0.3, output: 2.5, cachedInput: 0.03, id: base, kind: 'chat' };
  if (base.startsWith('gemini-3.5-flash')) return { input: 1.5, output: 9.0, cachedInput: 0.15, id: base, kind: 'chat' };
  if (base.startsWith('gemini')) return { input: 0.75, output: 3.75, cachedInput: 0.075, id: base, kind: 'chat' };
  if (base.includes('vision')) return { ...VISION_MODEL_PRICING[VISION_MODEL_ID], id: base, kind: 'vision' };
  if (base.startsWith('deepseek-v4-pro')) return { input: 1.32, output: 3.96, cachedInput: 0.044, id: base, kind: 'chat' };
  if (base.startsWith('deepseek-v4-flash')) return { input: 0.44, output: 1.32, cachedInput: 0.014, id: base, kind: 'chat' };
  if (base.startsWith('deepseek')) return { input: 0.3, output: 1.2, cachedInput: 0.006, id: base, kind: 'chat' };
  if (base.startsWith('glm-5.3-flash')) return { input: 0.114, output: 0.4, cachedInput: 0.03, id: base, kind: 'chat' };
  if (base.startsWith('glm')) return { input: 1.4, output: 4.4, cachedInput: 0.26, id: base, kind: 'chat' };
  if (base.startsWith('kimi')) return { input: 3.0, output: 15.0, cachedInput: 0.3, id: base, kind: 'chat' };
  if (base.startsWith('grok')) return { input: 2.0, output: 6.0, cachedInput: 0.5, id: base, kind: 'chat' };
  return null;
}

/** 计算单次对话/推理模型调用的官方预估费用（USD） */
export function estimateChatCost(modelId, usage, opts = {}) {
  const p = getModelPricing(modelId);
  if (!p || !usage) return null;
  if (p.kind === 'vision') {
    return estimateVisionCost({
      model: modelId,
      inputTokens: Number(usage.input ?? usage.prompt_tokens ?? usage.input_tokens ?? 0),
      outputTokens: Number(usage.output ?? usage.completion_tokens ?? usage.output_tokens ?? 0),
    });
  }
  if (p.kind === 'image') {
    return estimateImageCost({ model: modelId, usage });
  }
  const inputTok = Math.max(0, Number(usage.input ?? usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0);
  const outputTok = Math.max(0, Number(usage.output ?? usage.completion_tokens ?? usage.output_tokens ?? 0) || 0);
  const cachedTok = Math.max(0, Number(usage.cached ?? usage.cached_tokens ?? usage.cache_read_input_tokens ?? 0) || 0);
  const uncachedInput = Math.max(0, inputTok - cachedTok);

  const fast = !!(opts.fastMode || p.isFast) && (p.fastMultiplier || 1) > 1;
  const fastMult = fast ? p.fastMultiplier : 1;
  const overTier = !!(p.contextTier && inputTok > 272000);
  const inRate = p.input * fastMult * (overTier ? 2.0 : 1.0);
  const outRate = p.output * fastMult * (overTier ? 1.5 : 1.0);
  const cachedRate = (p.cachedInput != null ? p.cachedInput : p.input * 0.1) * fastMult * (overTier ? 2.0 : 1.0);

  const costUsd = (uncachedInput * inRate + cachedTok * cachedRate + outputTok * outRate) / 1e6;
  return {
    kind: 'chat',
    model: p.id || String(modelId || ''),
    inputTokens: inputTok,
    outputTokens: outputTok,
    cachedTokens: cachedTok,
    inRate,
    outRate,
    fast,
    freeTier: !!p.freeTier,
    costUsd,
    rateLabel: `官方价 输入 $${inRate}/M · 输出 $${outRate}/M${fast ? '（Fast 2x）' : ''}${p.freeTier ? '（网关免费档）' : ''}`,
  };
}

/** 单独处理：识图模型（deepseek-v4-flash-vision-exp）官方费用预估 */
export function estimateVisionCost({
  model = VISION_MODEL_ID,
  inputTokens = 0,
  outputTokens = 0,
  imageCount = 1,
  textChars = 0,
} = {}) {
  const { base } = normalizeModelKey(model);
  const p = VISION_MODEL_PRICING[base] || VISION_MODEL_PRICING[VISION_MODEL_ID];
  const imgs = Math.max(1, Number(imageCount) || 1);
  const hasExact = (Number(inputTokens) > 0) || (Number(outputTokens) > 0);
  const inTok = hasExact
    ? Math.max(0, Number(inputTokens) || 0)
    : imgs * (p.defaultTokensPerImage || 1500) + 120;
  const outTok = hasExact
    ? Math.max(0, Number(outputTokens) || 0)
    : Math.max(200, Math.ceil(Math.max(0, Number(textChars) || 0) * 0.85));
  const costUsd = (inTok * p.input + outTok * p.output) / 1e6;
  return {
    kind: 'vision',
    model: p.id,
    label: p.label,
    imageCount: imgs,
    inputTokens: inTok,
    outputTokens: outTok,
    estimated: !hasExact,
    inRate: p.input,
    outRate: p.output,
    costUsd,
    rateLabel: `识图官方价 输入 $${p.input}/M · 输出 $${p.output}/M`,
  };
}

/** 解析生图尺寸/质量对应的官方阶梯档位（1k / 2k / 4k） */
export function resolveImageTier(size = 'auto', quality = 'auto') {
  const s = String(size || 'auto').toLowerCase();
  const q = String(quality || 'auto').toLowerCase();
  if (/4k|4096|2048x2048/.test(s)) return '4k';
  if (/2k|1536|1792/.test(s) || q === 'high') return '2k';
  return '1k';
}

/** 单独处理：生图/改图模型（GPT Image 系列 / Nano Banana 2）官方费用预估 */
export function estimateImageCost({
  model = 'gpt-image-2.5-sunburst',
  size = 'auto',
  quality = 'auto',
  count = 1,
  referenceCount = 0,
  usage = null,
} = {}) {
  const { base } = normalizeModelKey(model);
  const p = IMAGE_MODEL_PRICING[base] || getModelPricing(base) || IMAGE_MODEL_PRICING['gpt-image-2.5-sunburst'];
  const n = Math.max(1, Number(count) || 1);
  const refs = Math.max(0, Number(referenceCount) || 0);

  if (p.mode === 'token' || base.includes('gemini')) {
    const uIn = usage && (usage.input_tokens ?? usage.input ?? usage.prompt_tokens);
    const uOut = usage && (usage.output_tokens ?? usage.output ?? usage.completion_tokens);
    const inTok = uIn != null ? Math.max(0, Number(uIn)) : (p.defaultInputTokens || 64) + refs * 258;
    const outTok = uOut != null && Number(uOut) > 0
      ? Math.max(0, Number(uOut))
      : n * (p.defaultOutputTokensPerImage || 1290);
    const costUsd = (inTok * p.input + outTok * p.output) / 1e6;
    return {
      kind: 'image',
      model: p.id || base,
      label: p.label || base,
      mode: 'token',
      count: n,
      referenceCount: refs,
      inputTokens: inTok,
      outputTokens: outTok,
      inRate: p.input,
      outRate: p.output,
      costUsd,
      rateLabel: `生图官方价 输入 $${p.input}/M · 输出 $${p.output}/M（${n} 张）`,
    };
  }

  // OpenAI GPT Image 系列：按官方 per_call_tiers（1K $0.06 / 2K $0.20 / 4K $0.25）或实测 token 计费
  const tier = resolveImageTier(size, quality);
  const tiers = p.tiers || { '1k': 0.06, '2k': 0.20, '4k': 0.25 };
  const perImage = tiers[tier] ?? tiers['1k'] ?? 0.06;
  const uIn = usage && (usage.input_tokens ?? usage.input ?? usage.prompt_tokens);
  const uOut = usage && (usage.output_tokens ?? usage.output ?? usage.completion_tokens);
  let costUsd;
  if (uIn != null || uOut != null) {
    const inTok = Math.max(0, Number(uIn) || 0);
    const outTok = Math.max(0, Number(uOut) || 0);
    const tokCost = (inTok * p.input + outTok * p.output) / 1e6;
    costUsd = outTok > 0 ? tokCost : (perImage * n + tokCost);
  } else {
    const refCost = refs > 0 ? (refs * 1500 * (p.imageInput || p.input)) / 1e6 : 0;
    costUsd = perImage * n + refCost;
  }
  return {
    kind: 'image',
    model: p.id || base,
    label: p.label || base,
    mode: 'tier',
    tier,
    perImage,
    count: n,
    referenceCount: refs,
    costUsd,
    rateLabel: `生图官方价 ${tier.toUpperCase()} $${perImage.toFixed(2)}/张 × ${n} 张${refs ? `（含 ${refs} 张参考图输入）` : ''}`,
  };
}

/** 格式化美元金额，供 tok 信息旁展示 */
export function formatUsd(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return '$0.0000';
  if (n === 0) return '$0.0000';
  if (n < 0.0001) return `<$0.0001`;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00')}`;
  return `$${n.toFixed(2)}`;
}

/** 生成用于模型选择器或提示条的简短官方价格标签 */
export function priceBadgeFor(modelId, { fastMode = false } = {}) {
  const p = getModelPricing(modelId);
  if (!p) return '';
  if (p.kind === 'vision') return `识图 $${p.input}/$${p.output} /M`;
  if (p.kind === 'image') {
    if (p.mode === 'tier' && p.tiers) return `生图 $${p.tiers['1k'] || 0.06}~$${p.tiers['4k'] || 0.25}/张`;
    return `生图 $${p.input}/$${p.output} /M`;
  }
  const mult = (fastMode || p.isFast) && p.fastMultiplier ? p.fastMultiplier : 1;
  return `$${+(p.input * mult).toFixed(3)}/$${+(p.output * mult).toFixed(3)} /M`;
}

/**
 * 汇总单轮（或单条消息）的官方预估价格：
 * - 对话/推理模型按 input/output tokens 计费
 * - 识图模型（deepseek-v4-flash-vision-exp）单独统计并单列展示
 * - 生图模型（GPT Image / Nano Banana 2）单独统计并单列展示
 * 支持两种调用签名：
 *   1) summarizeTurnCost(turnMessagesArray, { defaultModel, defaultImageModel, fastMode })
 *   2) summarizeTurnCost({ messages, model, fastMode, toolCosts, jevUsage })
 */
export function summarizeTurnCost(arg1, opts = {}) {
  const isConfigObj = arg1 && typeof arg1 === 'object' && !Array.isArray(arg1) && !('role' in arg1);
  const list = isConfigObj
    ? (Array.isArray(arg1.messages) ? arg1.messages : [])
    : (Array.isArray(arg1) ? arg1 : (arg1 ? [arg1] : []));
  const defaultModel = (isConfigObj ? arg1.model : opts.defaultModel) || 'claude-sonnet-5';
  const defaultImageModel = (isConfigObj ? arg1.imageModel : opts.defaultImageModel) || 'gpt-image-2.5-sunburst';
  const fastMode = !!(isConfigObj ? arg1.fastMode : opts.fastMode);
  const explicitToolCosts = isConfigObj && Array.isArray(arg1.toolCosts) ? arg1.toolCosts : [];
  const explicitJevUsage = isConfigObj ? arg1.jevUsage : opts.jevUsage;

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let hasChatUsage = false;
  let chatCostUsd = 0;
  let subagentCostUsd = 0;
  let jevCostUsd = 0;
  let visionCostUsd = 0;
  let imageCostUsd = 0;
  const chatModels = new Set();
  const visionItems = [];
  const imageItems = [];
  const countedToolCallIds = new Set();

  for (const b of explicitToolCosts) {
    if (!b || typeof b !== 'object') continue;
    if (b.id) countedToolCallIds.add(b.id);
    if (b.kind === 'vision') {
      const vc = estimateVisionCost({
        model: b.model || VISION_MODEL_ID,
        inputTokens: b.input || b.inputTokens || 0,
        outputTokens: b.output || b.outputTokens || 0,
        imageCount: b.imageCount || 1,
        textChars: b.textChars || 0,
      });
      visionCostUsd += vc.costUsd;
      visionItems.push(vc);
    } else if (b.kind === 'image_gen' || b.kind === 'image') {
      const ic = estimateImageCost({
        model: b.model || defaultImageModel,
        size: b.size || 'auto',
        quality: b.quality || 'auto',
        count: b.count || 1,
        referenceCount: b.referenceCount || 0,
        usage: (b.inputTokens || b.outputTokens) ? { input_tokens: b.inputTokens, output_tokens: b.outputTokens } : null,
      });
      imageCostUsd += ic.costUsd;
      imageItems.push(ic);
    }
  }

  const toolMsgById = new Map();
  for (const m of list) {
    if (m && m.role === 'tool' && m.toolCallId) toolMsgById.set(m.toolCallId, m);
  }

  for (const m of list) {
    if (!m || m.role !== 'assistant') continue;
    const model = m.model || defaultModel;
    if (model === '__system__' || model === 'Moderator') continue;
    if (m.usage && (m.usage.input != null || m.usage.output != null || m.usage.prompt_tokens != null || m.usage.completion_tokens != null)) {
      const c = estimateChatCost(model, m.usage, { fastMode: !!(m.fastMode ?? fastMode) });
      if (c) {
        hasChatUsage = true;
        inputTokens += c.inputTokens;
        outputTokens += c.outputTokens;
        if (m.usage.reasoning) reasoningTokens += Number(m.usage.reasoning) || 0;
        chatCostUsd += c.costUsd;
        chatModels.add(c.model);
      }
    }
    if (m.subagentUsage && (m.subagentUsage.input || m.subagentUsage.output)) {
      const sc = estimateChatCost(model, m.subagentUsage, { fastMode: !!(m.fastMode ?? fastMode) });
      if (sc) {
        hasChatUsage = true;
        inputTokens += sc.inputTokens;
        outputTokens += sc.outputTokens;
        subagentCostUsd += sc.costUsd;
      }
    }
    if (m.jevUsage && m.jevUsage.input) {
      const jc = estimateChatCost('jev', m.jevUsage);
      if (jc) jevCostUsd += jc.costUsd;
    }

    for (const tc of m.toolCalls || []) {
      if (!tc || (tc.id && countedToolCallIds.has(tc.id))) continue;
      const tm = toolMsgById.get(tc.id);
      const tContent = tm ? String(tm.content || '') : '';
      const b = tc.billing || tc.toolCost;
      if (b && b.kind === 'vision') {
        const vc = b.costUsd != null ? b : estimateVisionCost({
          model: b.model || VISION_MODEL_ID,
          inputTokens: b.input || b.inputTokens || 0,
          outputTokens: b.output || b.outputTokens || 0,
          imageCount: b.imageCount || 1,
          textChars: b.textChars || 0,
        });
        visionCostUsd += Number(vc.costUsd) || 0;
        visionItems.push(vc);
        continue;
      }
      if (b && (b.kind === 'image' || b.kind === 'image_gen')) {
        const ic = b.costUsd != null ? b : estimateImageCost({
          model: b.model || defaultImageModel,
          size: b.size || 'auto',
          quality: b.quality || 'auto',
          count: b.count || 1,
          referenceCount: b.referenceCount || 0,
          usage: (b.inputTokens || b.outputTokens) ? { input_tokens: b.inputTokens, output_tokens: b.outputTokens } : null,
        });
        imageCostUsd += Number(ic.costUsd) || 0;
        imageItems.push(ic);
        continue;
      }
      if (tc.name === 'analyze_pdf' && (!tm || /^\[PDF 分析完成\]/.test(tContent))) {
        const shot = Number((/识图 (\d+) 页/.exec(tContent) || [])[1] || 0);
        if (!shot) continue;
        const vc = estimateVisionCost({ model: VISION_MODEL_ID, imageCount: shot, textChars: tContent.length || 600 });
        visionCostUsd += vc.costUsd;
        visionItems.push(vc);
        continue;
      }
      if (tc.name === 'analyze_image' && (!tm || /^\[识图完成\]/.test(tContent))) {
        const args = tc.args || {};
        const count = Array.isArray(args.paths) && args.paths.length ? args.paths.length : 1;
        const vc = estimateVisionCost({
          model: VISION_MODEL_ID,
          imageCount: count,
          textChars: tContent.length || 600,
        });
        visionCostUsd += vc.costUsd;
        visionItems.push(vc);
      } else if (tc.name === 'generate_image' && (!tm || /^\[图像(生成|编辑)完成\]/.test(tContent))) {
        const args = tc.args || {};
        if (Array.isArray(args.compare_paths) && args.compare_paths.length >= 2) continue;
        const modelMatch = /^- 模型：(\S+)/m.exec(tContent);
        const tokMatch = /计费\s*(\d+)\s*输入\s*\/\s*(\d+)\s*输出\s*tokens/.exec(tContent);
        const imgModel = (modelMatch && modelMatch[1]) || m.imageModel || defaultImageModel;
        const refs = Array.isArray(args.reference_paths) ? args.reference_paths.length : 0;
        const n = [1, 2, 3, 4].includes(Number(args.n)) ? Number(args.n) : 1;
        const ic = estimateImageCost({
          model: imgModel,
          size: args.size || 'auto',
          quality: args.quality || 'auto',
          count: n,
          referenceCount: refs,
          usage: tokMatch ? { input_tokens: Number(tokMatch[1]), output_tokens: Number(tokMatch[2]) } : null,
        });
        imageCostUsd += ic.costUsd;
        imageItems.push(ic);
      }
    }
  }

  if (explicitJevUsage && explicitJevUsage.input && jevCostUsd === 0) {
    const jc = estimateChatCost('jev', explicitJevUsage);
    if (jc) jevCostUsd += jc.costUsd;
  }

  const totalCostUsd = chatCostUsd + subagentCostUsd + jevCostUsd + visionCostUsd + imageCostUsd;
  const hasAny = hasChatUsage || visionItems.length > 0 || imageItems.length > 0 || jevCostUsd > 0;
  if (!hasAny && !isConfigObj) return null;

  const extraTags = [];
  if (visionItems.length) extraTags.push(`识图 ${formatUsd(visionCostUsd)}`);
  if (imageItems.length) extraTags.push(`生图 ${formatUsd(imageCostUsd)}`);
  const badgeText = extraTags.length
    ? `≈ ${formatUsd(totalCostUsd)}（${extraTags.join(' + ')}）`
    : `≈ ${formatUsd(totalCostUsd)}`;

  const tooltipLines = [`本轮官方预估总价：${formatUsd(totalCostUsd)}`];
  if (hasChatUsage) {
    const mName = [...chatModels].join(', ') || defaultModel;
    const p = estimateChatCost(mName, { input: inputTokens, output: outputTokens }, { fastMode });
    tooltipLines.push(`· 对话模型（${mName}）：${formatUsd(chatCostUsd + subagentCostUsd)}（↑${inputTokens} ↓${outputTokens} tok${p ? ` · ${p.rateLabel}` : ''}）`);
  }
  if (visionItems.length) {
    const imgs = visionItems.reduce((s, x) => s + (Number(x.imageCount) || 1), 0);
    tooltipLines.push(`· 识图模型（${VISION_MODEL_ID}）：${formatUsd(visionCostUsd)}（共 ${imgs} 张 · ${visionItems[0].rateLabel || '官方价 输入 $0.44/M · 输出 $1.32/M'}）`);
  }
  if (imageItems.length) {
    const imgs = imageItems.reduce((s, x) => s + (Number(x.count) || 1), 0);
    const imgModel = imageItems[0].model || defaultImageModel;
    tooltipLines.push(`· 生图模型（${imgModel}）：${formatUsd(imageCostUsd)}（共 ${imgs} 张 · ${imageItems[0].rateLabel || ''}）`);
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    chatCostUsd,
    chatUsd: chatCostUsd,
    subagentCostUsd,
    subagentUsd: subagentCostUsd,
    jevCostUsd,
    jevUsd: jevCostUsd,
    visionCostUsd,
    visionUsd: visionCostUsd,
    imageCostUsd,
    imageUsd: imageCostUsd,
    totalCostUsd,
    totalUsd: totalCostUsd,
    formatted: formatUsd(totalCostUsd),
    visionCount: visionItems.length,
    imageCount: imageItems.length,
    badgeText,
    tooltip: tooltipLines.join('\n'),
  };
}

