// ─── 大对象仓库（IndexedDB）─────────────────────────────────────────────
// 为什么需要它：会话状态一直存在 localStorage 里，而 localStorage 只有 ~5MB 且写入是
// 同步的。附件图片、沙箱里的 data URL（生成的图）、工具芯片里的预览图都是 base64，
// 张张几百 KB ~ 数 MB：一旦超限，setItem 直接抛 QuotaExceededError，旧代码会**静默**退化成
// 「瘦身版」快照（剥掉所有 dataUrl）—— 用户刷新页面后附件与沙箱图片凭空消失。
//
// 现在把「重数据」按 key 存进 IndexedDB（配额按磁盘算，通常几百 MB），
// localStorage 里只留轻量状态 + 一份「哪条数据在哪个 key」的索引（见 state.js 的 blobFiles/
// blobAtts/blobChips）。浏览器没有 IndexedDB（老环境 / 隐私模式）时全部函数退化为 no-op，
// 上层走原来的老路径，不会有额外风险。

import { legacyNameFor } from './legacy-keys.js';

const DB_NAME = 'dubhe-agent-blobs';
const STORE = 'blobs';
const DB_VERSION = 1;

let dbPromise = null;

/** 环境是否支持 IndexedDB（不支持时上层沿用旧逻辑） */
export function blobsSupported() {
  try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch { return false; }
}

function openNamed(name, { createIfMissing = true } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(name, DB_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      if (!createIfMissing) { // 旧库不存在：中止升级，不留下空库
        try { req.transaction.abort(); } catch { /* ignore */ }
        return;
      }
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其它标签页阻塞'));
  });
}

/** 一次性把旧品牌数据库里的大对象搬到新库，搬完删除旧库；任何失败都静默放弃（不影响新库使用）。 */
async function migrateLegacyDb(db) {
  const legacyName = legacyNameFor(DB_NAME);
  if (!legacyName || legacyName === DB_NAME) return;
  try {
    if (typeof indexedDB.databases === 'function') {
      const names = (await indexedDB.databases()).map((d) => d && d.name);
      if (!names.includes(legacyName)) return;
    }
    const old = await openNamed(legacyName, { createIfMissing: false });
    if (!old.objectStoreNames.contains(STORE)) { old.close(); indexedDB.deleteDatabase(legacyName); return; }
    const entries = await new Promise((resolve, reject) => {
      const out = [];
      const cur = old.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve(out); return; }
        if (typeof c.key === 'string' && typeof c.value === 'string') out.push([c.key, c.value]);
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    old.close();
    if (entries.length) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const st = tx.objectStore(STORE);
        for (const [k, v] of entries) st.put(v, k);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    indexedDB.deleteDatabase(legacyName);
  } catch { /* 旧库缺失 / 被阻塞：下次再试，不影响新库 */ }
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = openNamed(DB_NAME)
    .then(async (db) => { await migrateLegacyDb(db); return db; })
    .catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

/** 批量写入：entries = [[key, value], ...]，返回写入条数 */
export async function blobPut(entries) {
  const list = (entries || []).filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string');
  if (!list.length || !blobsSupported()) return 0;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    for (const [k, v] of list) st.put(v, k);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return list.length;
}

/** 批量读取：返回 Map<key, value>（缺失的 key 不会出现在结果里） */
export async function blobGet(keys) {
  const list = [...new Set((keys || []).filter((k) => typeof k === 'string' && k))];
  if (!list.length || !blobsSupported()) return new Map();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = new Map();
    const tx = db.transaction(STORE, 'readonly');
    const st = tx.objectStore(STORE);
    for (const k of list) {
      const r = st.get(k);
      r.onsuccess = () => { if (r.result !== undefined && r.result !== null) out.set(k, r.result); };
    }
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 现有全部 key（用于清理已删除会话/消息留下的孤儿数据） */
export async function blobKeys() {
  if (!blobsSupported()) return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).getAllKeys();
    r.onsuccess = () => resolve(r.result || []);
    tx.onerror = () => reject(tx.error);
  });
}

export async function blobDelete(keys) {
  const list = (keys || []).filter((k) => typeof k === 'string' && k);
  if (!list.length || !blobsSupported()) return 0;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    for (const k of list) st.delete(k);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return list.length;
}

/** 只保留 keep 里的 key，其余删掉（会话被删除 / 消息回滚后不留垃圾） */
export async function blobPrune(keep) {
  if (!blobsSupported()) return 0;
  const keepSet = new Set(keep || []);
  const all = await blobKeys();
  const dead = all.filter((k) => !keepSet.has(k));
  if (!dead.length) return 0;
  return blobDelete(dead);
}
