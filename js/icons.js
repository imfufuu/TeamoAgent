// ─── 供应商图标（内联 SVG · 单色 currentColor · 风格化近似品牌标识）───
const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;

const ICONS = {
  // Anthropic —— 放射星芒
  Anthropic: svg(
    '<g stroke="currentColor" stroke-width="2.1" stroke-linecap="round" fill="none">' +
    '<path d="M12 2.9v4.3M12 16.8v4.3M2.9 12h4.3M16.8 12h4.3"/>' +
    '<path d="M5.6 5.6l3 3M15.4 15.4l3 3M18.4 5.6l-3 3M8.6 15.4l-3 3"/></g>'
  ),
  // OpenAI —— 六边形结
  OpenAI: svg(
    '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">' +
    '<path d="M12 2.6l8.1 4.7v9.4L12 21.4 3.9 16.7V7.3z"/>' +
    '<path d="M12 7.4l4 2.3v4.6l-4 2.3-4-2.3V9.7z"/></g>'
  ),
  // Google Gemini —— 四芒星
  Google: svg('<path d="M12 1.9l2.55 7.55L22.1 12l-7.55 2.55L12 22.1l-2.55-7.55L1.9 12l7.55-2.55z"/>'),
  // DeepSeek —— 鲸
  DeepSeek: svg(
    '<path d="M3 14.4c1.7-5.3 6.6-8.8 12.3-7.9 2 .3 3.7 1.2 5.7.4-.5 3.7-2.8 6.5-6.3 7.8-2.5 1-5.1 1.1-7.7.4l-4 2.8 1.4-2.4c-.6-.3-1.1-.7-1.4-1.1z"/>'
  ),
  // 智谱 GLM —— 圆环 Z
  GLM: svg(
    '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
    '<path d="M8.5 8.7h7L8.9 15.3h7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'
  ),
  // xAI Grok —— 双斜杠
  Grok: svg('<path d="M10.4 3.2L6 20.8h3.2l4.4-17.6zM17.6 3.2l-4.4 17.6h3.2l4.4-17.6z" transform="skewX(-4)"/>'),
  // 其他
  其他: svg('<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.8"/>'),
};

export function providerIcon(provider) {
  return ICONS[provider] || ICONS['其他'];
}
