// UI preference is global; session content is never translated or rewritten.
export const LANGUAGE_KEY = 'dubhe-ui-language';
let override = null;
const listeners = new Set();
export function browserLanguage(nav = globalThis.window?.navigator) {
  const first = String(nav?.language || nav?.languages?.[0] || 'zh').toLowerCase();
  return first.startsWith('en') ? 'en' : 'zh';
}
export function languagePreference() {
  if (override) return override;
  try { const p = globalThis.localStorage?.getItem(LANGUAGE_KEY); if (['zh', 'en'].includes(p)) return p; } catch { /* private storage */ }
  return 'auto';
}
export function getLanguage() { const p = languagePreference(); return p === 'auto' ? browserLanguage() : p; }
export function text(zh, en) { return getLanguage() === 'en' ? en : zh; }
export function setLanguagePreference(value) {
  const p = ['en', 'zh'].includes(value) ? value : 'auto'; override = p;
  try { if (p === 'auto') localStorage.removeItem(LANGUAGE_KEY); else localStorage.setItem(LANGUAGE_KEY, p); } catch { /* usable for this page */ }
  for (const fn of listeners) fn(getLanguage(), p);
  return getLanguage();
}
export function onLanguageChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
