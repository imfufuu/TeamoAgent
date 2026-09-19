// ─── 供应商图标：真实品牌 Logo ─────────────────────────────────────────
// SVG 下载自 Wikimedia Commons / Wikipedia（见 README「图标来源与版权」）
// mono = 纯黑 Logo（暗色主题下 CSS 反色）；word = 横排 wordmark（宽度自适应）

export const PROVIDER_ICON = {
  Anthropic: { file: 'anthropic.svg', mono: false, word: false }, // Claude 符号（品牌珊瑚色）
  OpenAI:    { file: 'openai.svg',    mono: true,  word: false },
  Google:    { file: 'gemini.svg',    mono: false, word: false }, // Gemini 图标 2025
  DeepSeek:  { file: 'deepseek.svg',  mono: false, word: false }, // DeepSeek 鲸图标（品牌蓝）
  GLM:       { file: 'zhipu.svg',     mono: false, word: false }, // Z.ai（智谱）
  Grok:      { file: 'grok.svg',      mono: false, word: false, white: true }, // 白色图标 → 亮色主题反色
};

export function providerIcon(provider) {
  const def = PROVIDER_ICON[provider];
  if (!def) return `<span class="p-icon-fallback">${String(provider || '?').slice(0, 1)}</span>`;
  const cls = ['p-icon', def.mono ? 'mono' : '', def.word ? 'word' : '', def.white ? 'white' : ''].filter(Boolean).join(' ');
  return `<img class="${cls}" src="assets/icons/${def.file}" alt="${provider}" loading="lazy">`;
}
