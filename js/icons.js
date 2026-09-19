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

// ─── TeamoAgent 应用标识 ───────────────────────────────────────────────
// 设计语义：半填充圆（路由的二分与选择）+ 环上三个节点（网关分发到多模型），
// 单色 currentColor 随主题；favicon 用静态双色版（黑底白半圆，深浅标签页均可见）。
export const APP_LOGO = `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="16" cy="16" r="11.4" stroke="currentColor" stroke-width="2.4"/>
  <path d="M16 4.6a11.4 11.4 0 0 1 0 22.8z" fill="currentColor"/>
  <circle cx="16" cy="4.6" r="2.7" fill="currentColor"/>
  <circle cx="6.1" cy="21.7" r="2.7" fill="currentColor"/>
  <circle cx="25.9" cy="21.7" r="2.7" fill="currentColor"/>
</svg>`;

export const APP_FAVICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0a0a0a"/><path d="M16 1a15 15 0 0 1 0 30z" fill="#fff"/><circle cx="16" cy="16" r="3.4" fill="#0a0a0a"/></svg>`
);

export function providerIcon(provider) {
  const def = PROVIDER_ICON[provider];
  if (!def) return `<span class="p-icon-fallback">${String(provider || '?').slice(0, 1)}</span>`;
  const cls = ['p-icon', def.mono ? 'mono' : '', def.word ? 'word' : '', def.white ? 'white' : ''].filter(Boolean).join(' ');
  return `<img class="${cls}" src="assets/icons/${def.file}" alt="${provider}" loading="lazy">`;
}
