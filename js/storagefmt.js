// 沙箱占用展示：{已用}/{本地存储上限}，例 2.7MB/120.0MB
// 上限按产品约定 120MB（IndexedDB 实际配额通常更大，这里给用户一个看得见的天花板）。

export const SANDBOX_STORAGE_CAP = 120 * 1024 * 1024;

export function fmtMB(bytes) {
  const n = Number(bytes);
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  return `${(v / 1048576).toFixed(1)}MB`;
}

export function sandboxQuotaLabel(usedBytes, cap = SANDBOX_STORAGE_CAP) {
  const max = Number(cap) > 0 ? Number(cap) : SANDBOX_STORAGE_CAP;
  return `${fmtMB(usedBytes)}/${fmtMB(max)}`;
}

// 工具栏文案：空沙箱仍显示 0.0MB/120.0MB；有文件时保留「N 个文件 · M 个目录」
export function filesCountLabel(stat, cap = SANDBOX_STORAGE_CAP) {
  const quota = sandboxQuotaLabel(stat && stat.size, cap);
  const files = stat && stat.files;
  if (!files) return quota;
  const dirs = stat.dirs ? ` · ${stat.dirs} 个目录` : '';
  return `${files} 个文件${dirs} · ${quota}`;
}

export async function resolveStorageQuota(fallback = SANDBOX_STORAGE_CAP) {
  try {
    const est = typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate;
    if (typeof est === 'function') {
      const r = await est.call(navigator.storage);
      const q = Number(r && r.quota);
      if (q > 0) return q;
    }
  } catch { /* 无 StorageManager 或被拒 */ }
  return fallback;
}
