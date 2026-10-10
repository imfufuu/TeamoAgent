// 介绍页与对话页共用一份外观偏好；旧的 home key 仅用于向后迁移。
import { STORAGE_KEY } from './config.js?v=2026.10.9.4';
import { readLocal, writeLocal, removeLocal } from './legacy-keys.js';

export const THEME_STORAGE_KEY = 'dubhe-theme';
export const LEGACY_HOME_THEME_KEY = 'dubhe-home-theme';
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
    const shared = validTheme(readLocal(THEME_STORAGE_KEY));
    if (shared) return shared;
    const legacy = validTheme(readLocal(LEGACY_HOME_THEME_KEY));
    if (legacy) return legacy;
    const stateRaw = readLocal(`${STORAGE_KEY}-v2`) || readLocal(STORAGE_KEY) || '';
    if (stateRaw) {
      const state = JSON.parse(stateRaw);
      const saved = validTheme(state && state.settings && state.settings.theme);
      if (saved) return saved;
    }
  } catch { /* 隐私模式 / 损坏的旧存档：使用调用方默认值 */ }
  return validTheme(fallback) || 'light';
}

/** 保存共享主题；旧介绍页 key 只清不写，避免两份偏好并存。 */
export function writeThemePreference(value) {
  const theme = validTheme(value);
  if (!theme) return '';
  writeLocal(THEME_STORAGE_KEY, theme);
  removeLocal(LEGACY_HOME_THEME_KEY);
  return theme;
}
