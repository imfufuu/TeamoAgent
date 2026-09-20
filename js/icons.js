// ─── 供应商图标：真实品牌 Logo ─────────────────────────────────────────
// SVG 下载自 Wikimedia Commons / Wikipedia（见 README「图标来源与版权」）
// mono = 纯黑 Logo（暗色主题下 CSS 反色）；word = 横排 wordmark（宽度自适应）

export const PROVIDER_ICON = {
  Anthropic: { file: 'anthropic.svg', mono: false, word: false }, // Claude 符号（品牌珊瑚色）
  OpenAI:    { file: 'openai.svg',    mono: true,  word: false },
  Google:    { file: 'gemini.svg',    mono: false, word: false }, // Gemini 图标 2025
  DeepSeek:  { file: 'deepseek.svg',  mono: false, word: false }, // DeepSeek 鲸图标（品牌蓝）
  GLM:       { file: 'zhipu.svg',     mono: false, word: false }, // Z.ai（智谱）
  Kimi:      { file: 'kimi.svg',      mono: false, word: false }, // Kimi（月之暗面）：黑底白 K + 品牌蓝 #1783FF 折角
  Grok:      { file: 'grok.svg',      mono: false, word: false, white: true }, // 白色图标 → 亮色主题反色
};

// ─── TeamoAgent 应用标识 ───────────────────────────────────────────────
// 几何化「轨道枢纽」：中心核心 + 三条 120° 对称平滑轨道弧 + 三个卫星节点
// （多智能体围绕路由枢纽协作）；单色 currentColor 随主题；favicon 为
// index.html 内联的静态双色版（黑底白图标，深浅标签页均可见）。
export const APP_LOGO = `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="1.3"/>
  <path d="M22.128 21.142 A8.000 8.000 0 0 1 9.872 21.142" fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M8.482 18.736 A8.000 8.000 0 0 1 14.611 8.122" fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M17.389 8.122 A8.000 8.000 0 0 1 23.518 18.736" fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width="2.2" stroke-linecap="round"/>
  <circle cx="16" cy="16" r="2.7" fill="currentColor"/>
  <circle cx="16.000" cy="24.000" r="1.8" fill="currentColor"/>
  <circle cx="9.072" cy="12.000" r="1.8" fill="currentColor"/>
  <circle cx="22.928" cy="12.000" r="1.8" fill="currentColor"/>
</svg>`;

export function providerIcon(provider) {
  const def = PROVIDER_ICON[provider];
  if (!def) return `<span class="p-icon-fallback">${String(provider || '?').slice(0, 1)}</span>`;
  const cls = ['p-icon', def.mono ? 'mono' : '', def.word ? 'word' : '', def.white ? 'white' : ''].filter(Boolean).join(' ');
  return `<img class="${cls}" src="assets/icons/${def.file}" alt="${provider}" loading="lazy">`;
}
