// ─── 旧本地存储键迁移（仅此一处登记旧品牌前缀）────────────────────────────
// Dubhe Agent 早期构建用旧项目名作为 localStorage / IndexedDB / CacheStorage 键前缀。
// 新代码一律使用 dubhe-* 键；这里只负责把老用户机器上的数据无损搬到新键，
// 搬完即删除旧键。除本文件外，仓库中不应再出现旧前缀。
const LEGACY_BRAND = ['te', 'amo'].join('');

/** 由新键推导旧键：dubhe-foo → <旧前缀>-foo；dubhe.foo → <旧前缀>.foo */
export function legacyKeyFor(key) {
  return String(key || '').replace(/^dubhe(?=[-.]|$)/, LEGACY_BRAND);
}

function storage(kind) {
  try {
    const s = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch { return null; }
}

/**
 * 读取 localStorage：优先新键；新键缺失而旧键存在时，把旧值搬到新键并移除旧键。
 * 任何异常（隐私模式 / 配额）都按「没有值」处理，不向上抛。
 */
export function readLocal(key, kind = 'local') {
  const s = storage(kind);
  if (!s) return null;
  try {
    const v = s.getItem(key);
    if (v != null) return v;
    const old = legacyKeyFor(key);
    if (old === key) return null;
    const legacy = s.getItem(old);
    if (legacy == null) return null;
    try { s.setItem(key, legacy); s.removeItem(old); } catch { /* 搬运失败也先把值用上 */ }
    return legacy;
  } catch { return null; }
}

/** 写新键，并顺手清掉同名旧键，避免两份状态并存。 */
export function writeLocal(key, value, kind = 'local') {
  const s = storage(kind);
  if (!s) return false;
  try {
    s.setItem(key, String(value));
    const old = legacyKeyFor(key);
    if (old !== key) { try { s.removeItem(old); } catch { /* ignore */ } }
    return true;
  } catch { return false; }
}

export function removeLocal(key, kind = 'local') {
  const s = storage(kind);
  if (!s) return;
  try { s.removeItem(key); } catch { /* ignore */ }
  const old = legacyKeyFor(key);
  if (old !== key) { try { s.removeItem(old); } catch { /* ignore */ } }
}

/** 旧数据库/旧缓存名（IndexedDB、CacheStorage 迁移用） */
export function legacyNameFor(name) { return legacyKeyFor(name); }
