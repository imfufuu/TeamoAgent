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

// ── 界面图标（线性 SVG，stroke=currentColor 随主题；与顶栏 pill 同一风格）──
// 24x24 视图、1.9 描边、圆角端点，与思考/沙箱两个 pill 内联的图标完全一致，
// 这样「快速」按钮、下载按钮与左侧按钮是同一套视觉语言，而不是系统 emoji。
const ico = (body) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICON = {
  bolt: ico('<path d="M13 2 4.6 13.2a.6.6 0 0 0 .48.97H11l-1.2 7.4a.35.35 0 0 0 .62.27l8.56-11.2a.6.6 0 0 0-.48-.97H14l1.2-7.4a.35.35 0 0 0-.62-.27Z"/>'),
  download: ico('<path d="M12 3.5v11.2"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 17.5v1.8a1.2 1.2 0 0 0 1.2 1.2h12.6a1.2 1.2 0 0 0 1.2-1.2v-1.8"/>'),
  folder: ico('<path d="M20.5 19.5v-11a1.5 1.5 0 0 0-1.5-1.5h-7L9.6 4.6A1.5 1.5 0 0 0 8.44 4h-5A1.5 1.5 0 0 0 2 5.5v13a1.5 1.5 0 0 0 1.5 1.5h15.5a1.5 1.5 0 0 0 1.5-1.5Z"/>'),
  folderOpen: ico('<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h4.94a1.5 1.5 0 0 1 1.16.55l.9 1.2a1.5 1.5 0 0 0 1.16.55H19a1.5 1.5 0 0 1 1.5 1.5v1.2"/><path d="M2.4 10.5h19.1a.5.5 0 0 1 .49.6l-1.7 7A1.5 1.5 0 0 1 18.82 19.4H4.2a1.5 1.5 0 0 1-1.47-1.19L2 11"/>'),
  file: ico('<path d="M14.5 2.5H7A1.5 1.5 0 0 0 5.5 4v16A1.5 1.5 0 0 0 7 21.5h10a1.5 1.5 0 0 0 1.5-1.5V8Z"/><path d="M14 2.8V7a1.5 1.5 0 0 0 1.5 1.5H20"/>'),
  image: ico('<rect x="3" y="3" width="18" height="18" rx="2.2"/><circle cx="8.8" cy="8.8" r="1.8"/><path d="m4.5 18.5 4.6-4.6a1.8 1.8 0 0 1 2.55 0l5.35 5.35"/><path d="M14.5 14.2l1.7-1.7a1.8 1.8 0 0 1 2.55 0l1.75 1.75"/>'),
  chevRight: ico('<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>'),
  x: ico('<path d="M6 6 18 18"/><path d="M18 6 6 18"/>'),
};

export function providerIcon(provider) {
  const def = PROVIDER_ICON[provider];
  if (!def) return `<span class="p-icon-fallback">${String(provider || '?').slice(0, 1)}</span>`;
  const cls = ['p-icon', def.mono ? 'mono' : '', def.word ? 'word' : '', def.white ? 'white' : ''].filter(Boolean).join(' ');
  return `<img class="${cls}" src="assets/icons/${def.file}" alt="${provider}" loading="lazy">`;
}
