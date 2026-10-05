// Privacy-minimal environment snapshot. It intentionally returns only coarse,
// browser-exposed hints; it never reads cookies, storage, GPS, IP, or device IDs.
const firstMatch = (text, patterns) => {
  for (const [name, re] of patterns) {
    const match = re.exec(text);
    if (match) return { name, major: match[1] ? Number(match[1]) : null };
  }
  return { name: 'Unknown', major: null };
};

function roundedBucket(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(100, Math.round(n / 100) * 100) : 0;
}

export function getCoarseBrowserEnvironment(options = {}) {
  const nav = options.navigator || globalThis.navigator || {};
  const win = options.window || globalThis.window || {};
  const intl = options.Intl || globalThis.Intl;
  const ua = String(nav.userAgent || '');
  const platform = String(nav.platform || '');
  const browser = firstMatch(ua, [
    ['Edge', /(?:Edg|EdgA|EdgiOS)\/(\d+)/i],
    ['Opera', /(?:OPR|Opera)\/(\d+)/i],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/i],
    ['Chrome', /(?:Chrome|CriOS)\/(\d+)/i],
    ['Safari', /Version\/(\d+)[\s\S]*Safari\//i],
  ]);
  if (browser.name === 'Unknown' && /Safari\//i.test(ua)) browser.name = 'Safari';

  let osFamily = 'Unknown';
  if (/CrOS/i.test(ua)) osFamily = 'ChromeOS';
  else if (/Android/i.test(ua)) osFamily = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua) || (/MacIntel/i.test(platform) && Number(nav.maxTouchPoints) > 1)) osFamily = /iPad|MacIntel/i.test(ua + platform) ? 'iPadOS' : 'iOS';
  else if (/Windows/i.test(ua + platform)) osFamily = 'Windows';
  else if (/Mac OS X|Macintosh|MacIntel/i.test(ua + platform)) osFamily = 'macOS';
  else if (/Linux|X11/i.test(ua + platform)) osFamily = 'Linux';

  const smallViewport = Math.min(Number(win.innerWidth) || 0, Number(win.innerHeight) || 0);
  const touchPoints = Math.max(0, Math.min(10, Number(nav.maxTouchPoints) || 0));
  let formFactor = '桌面';
  if (/iPhone|iPod|Mobile/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua))) formFactor = '手机';
  else if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) || (touchPoints > 0 && smallViewport >= 600 && smallViewport <= 1400)) formFactor = '平板或触屏设备';

  const langsRaw = Array.isArray(nav.languages) && nav.languages.length ? nav.languages : [nav.language || ''];
  const languages = [...new Set(langsRaw.map((x) => String(x || '').trim()).filter((x) => /^[A-Za-z0-9-]{2,24}$/.test(x)))].slice(0, 3);
  let timeZone = 'Unknown';
  try { timeZone = intl.DateTimeFormat().resolvedOptions().timeZone || timeZone; } catch { /* privacy-safe fallback */ }
  const width = roundedBucket(win.innerWidth);
  const height = roundedBucket(win.innerHeight);
  let reducedMotion = null;
  try { reducedMotion = typeof win.matchMedia === 'function' ? !!win.matchMedia('(prefers-reduced-motion: reduce)').matches : null; } catch { /* unavailable */ }

  return {
    browser: browser.name,
    browserMajor: Number.isFinite(browser.major) ? browser.major : null,
    osFamily,
    formFactor,
    languages: languages.length ? languages : ['Unknown'],
    timeZone,
    viewportApprox: width && height ? `${width} × ${height}（约，取整到 100 px）` : 'Unknown',
    touch: touchPoints > 0,
    online: typeof nav.onLine === 'boolean' ? nav.onLine : null,
    reducedMotion,
    privacy: '仅使用浏览器公开的粗略信息；未读取 Cookie、存储、IP、精确定位或设备标识。',
  };
}
