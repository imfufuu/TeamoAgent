// 介绍页与对话页共用一份外观偏好；旧的 home key 仅用于向后迁移。
import { STORAGE_KEY } from './config.js';

export const THEME_STORAGE_KEY = 'teamo-theme';
const LEGACY_HOME_THEME_KEY = 'teamo-home-theme';
const VALID_THEMES = new Set(['light', 'dark']);

function validTheme(value) {
  const theme = String(value || '').trim().toLowerCase();
  return VALID_THEMES.has(theme) ? theme : '';
}

/**
 * 读取顺序：共享 key → 旧介绍页偏好 → 已保存的应用设置 → 调用方默认值。
 * 这样不会丢掉升级前在任一页面选过的主题。
 */
export function readThemePreference(fallback = 'light') {
  try {
    const shared = validTheme(localStorage.getItem(THEME_STORAGE_KEY));
    if (shared) return shared;
    const legacy = validTheme(localStorage.getItem(LEGACY_HOME_THEME_KEY));
    if (legacy) return legacy;
    const stateRaw = localStorage.getItem(`${STORAGE_KEY}-v2`) || localStorage.getItem(STORAGE_KEY) || '';
    if (stateRaw) {
      const state = JSON.parse(stateRaw);
      const saved = validTheme(state && state.settings && state.settings.theme);
      if (saved) return saved;
    }
  } catch { /* 隐私模式 / 损坏的旧存档：使用调用方默认值 */ }
  return validTheme(fallback) || 'light';
}

/** 保存共享主题，并继续写旧介绍页 key 以兼容已打开的旧构建。 */
export function writeThemePreference(value) {
  const theme = validTheme(value);
  if (!theme) return '';
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    localStorage.setItem(LEGACY_HOME_THEME_KEY, theme);
  } catch { /* storage quota / private mode */ }
  return theme;
}
