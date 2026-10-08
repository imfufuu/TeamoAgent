// ─── 沙箱：隔离代码执行 + 虚拟文件系统 ────────────────────────────────
// JS 沙箱：独立 Web Worker，无 DOM/fetch 访问面，超时强制 terminate
// Python 沙箱：Pyodide（WASM）跑在独立 Worker 中，可终止；CDN 加载失败时优雅降级

import { SANDBOX_JS_TIMEOUT_MS, SANDBOX_PY_TIMEOUT_MS } from './config.js?v=2026.10.5.35';
import { readLocal, writeLocal } from './legacy-keys.js';
import { SANDBOX_STORAGE_CAP } from './storagefmt.js';

// ── 虚拟文件系统（会话级，随 state 持久化）─────────────────────────────
// 内部文件前缀：长久保存但用户不直接查看（识图 OCR/联网缓存/元数据等）；
// 工作区（uploads/、outputs/ 及用户主动写入的路径）对用户可见。
const WS_INTERNAL_PREFIXES = ['internal/', '.git/'];
// P2 修正：临时沙箱提交白名单。这些前缀下的文件是「整文件写入的工具副产物 / 用户上传 / 跨域拉取」，
// 不是模型自由创建的半截产物——回合结束无条件写回 baseFS，不再看最终回答有没有提到路径。
// 以前 fetch_url 落盘的 internal/web/*.md、analyze_* 的 internal/ocr/*.md 全靠「回答里碰巧出现文件名」才能活过本轮。
export const TEMP_PERSIST_PREFIXES = Object.freeze(['internal/', 'uploads/']);
export function isAlwaysPersistedPath(p) {
  const s = String(p || '');
  return TEMP_PERSIST_PREFIXES.some((pref) => s.startsWith(pref));
}
// 工具结果里的持久性说明：让「已写入 X」这句话带上契约，而不是让模型 / 用户猜
export function persistenceNote(fs, path) {
  if (!fs || fs._isTemp !== true) return '';
  return isAlwaysPersistedPath(path) ? '（已持久）' : '（本轮结束后若最终回答未提及此文件将被丢弃）';
}
const FS_MAX_PATH = 512;
const FS_MAX_FILES = 5000;

// 路径合法性：相对路径、无反斜杠 / 控制字符、无空段 / . / ..、不允许原型键，长度 ≤ 512
// 文件真实字节数：data URL 按 base64 反推（去掉填充），文本按 UTF-8 编码长度。
// 以前 list() 直接给 String(c).length —— 图片 / 视频 / PDF 的 data URL 会虚高 1/3，中文文本则偏小；
// list_files 工具、系统提示里的「当前沙箱文件」与文件面板都从这里取数，必须是真实体积。
// 按（路径 → 内容引用）缓存：同一引用直接命中，避免每次刷新文件面板都对大文件重新编码。
const sizeCache = new Map();
const utf8 = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
export function contentByteSize(content) {
  const str = String(content == null ? '' : content);
  if (str.startsWith('data:')) {
    const comma = str.indexOf(',');
    if (comma > 0 && comma < 256 && /;base64/i.test(str.slice(0, comma))) {
      const body = str.length - comma - 1;
      let pad = 0;
      if (str.endsWith('==')) pad = 2; else if (str.endsWith('=')) pad = 1;
      return Math.max(0, Math.floor(body * 3 / 4) - pad);
    }
  }
  if (!utf8) return str.length;
  // 纯 ASCII 快速路径：长度即字节数（绝大多数代码 / JSON / CSV 命中）
  // eslint-disable-next-line no-control-regex
  if (str.length < 4096 && !/[^\x00-\x7f]/.test(str)) return str.length;
  return utf8.encode(str).length;
}
function cachedSize(path, content) {
  const hit = sizeCache.get(path);
  if (hit && hit.content === content) return hit.size;
  const size = contentByteSize(content);
  if (sizeCache.size > 4096) sizeCache.clear();
  sizeCache.set(path, { content, size });
  return size;
}

export function isSafeFsPath(path) {
  const p = String(path == null ? '' : path);
  if (!p || p.length > FS_MAX_PATH) return false;
  if (p.startsWith('/') || p.includes('\\') || /[\u0000-\u001f\u007f]/.test(p)) return false;
  const parts = p.split('/');
  return !parts.some((seg) => !seg || seg === '.' || seg === '..' || seg === '__proto__' || seg === 'constructor' || seg === 'prototype');
}

// 把沙箱 Worker 回传的 files 快照合并回真实文件系统（Worker 代码可能是对抗性的）：
//   · 键必须通过 isSafeFsPath；值必须是字符串
//   · internal/ 与 .git/ 为受保护前缀：Worker 不能新增、修改或删除（保留 before 里的版本）
//   · 总量不得超过 SANDBOX_STORAGE_CAP、文件数不得超过 FS_MAX_FILES；超限时整体拒收，保留 before
export function sanitizeWorkerFiles(before, after, { cap = SANDBOX_STORAGE_CAP, maxFiles = FS_MAX_FILES } = {}) {
  const prev = before && typeof before === 'object' ? before : {};
  const next = after && typeof after === 'object' ? after : {};
  const out = Object.create(null);
  const rejected = [];
  const isProtected = (k) => WS_INTERNAL_PREFIXES.some((pref) => k.startsWith(pref));
  // 受保护文件原样保留
  for (const k of Object.keys(prev)) if (isProtected(k)) out[k] = prev[k];
  let total = Object.values(out).reduce((n, v) => n + String(v).length, 0);
  let count = Object.keys(out).length;
  for (const k of Object.keys(next)) {
    if (isProtected(k)) { if (!(k in prev) || prev[k] !== next[k]) rejected.push({ path: k, reason: 'protected' }); continue; }
    if (!isSafeFsPath(k)) { rejected.push({ path: k, reason: 'unsafe-path' }); continue; }
    const v = next[k];
    if (typeof v !== 'string') { rejected.push({ path: k, reason: 'non-string' }); continue; }
    out[k] = v;
    total += v.length;
    count += 1;
  }
  if (total > cap || count > maxFiles) {
    return { ok: false, files: { ...prev }, rejected, reason: total > cap ? `沙箱输出 ${(total / 1048576).toFixed(1)} MB 超过容量上限 ${(cap / 1048576).toFixed(0)} MB` : `文件数 ${count} 超过上限 ${maxFiles}`, total, count };
  }
  return { ok: true, files: { ...out }, rejected, total, count };
}

// 把 Worker 跑完后的文件镜像写回会话文件系统——按「差异」写，而不是 clear() + import()。
// 根因（V1.7 → .28 一直存在）：每轮工具拿到的是 createTempFS 临时层，它的 import() 是空操作、clear() 会清掉本轮所有写入，
// 于是任何一次 execute_javascript / execute_python 都会：① 把本轮 write_file 写的文件清空 ② 丢掉沙箱代码自己写的 files。
// 表现就是「write_file 成功 → 下一个 JS 调用 files_keys: []」「同调用能回读 files/probe.txt，下一调用就没了」。
// 差异写法对真实 FS（createFS）与临时层（createTempFS）语义一致：新增 / 修改 → write，Worker 里删掉的 → remove。
export function applyWorkerFiles(fsObj, before, after) {
  const r = sanitizeWorkerFiles(before, after);
  if (!r.ok) return r;
  const prev = before && typeof before === 'object' ? before : {};
  let written = 0, removed = 0;
  for (const k of Object.keys(r.files)) {
    if (!Object.prototype.hasOwnProperty.call(prev, k) || prev[k] !== r.files[k]) {
      try { fsObj.write(k, r.files[k]); written += 1; } catch (err) { r.rejected.push({ path: k, reason: `write-failed: ${err && err.message || err}` }); }
    }
  }
  for (const k of Object.keys(prev)) {
    if (!Object.prototype.hasOwnProperty.call(r.files, k) && typeof fsObj.remove === 'function') {
      try { fsObj.remove(k); removed += 1; } catch { /* 删不掉就保留 */ }
    }
  }
  return { ...r, written, removed };
}

function noteWorkerFiles(out, r) {
  if (!r) return out;
  const notes = [];
  if (!r.ok) notes.push(`[沙箱] ${r.reason}，本次对文件的修改已全部丢弃`);
  if (r.rejected.length) {
    const why = { protected: '受保护路径', 'unsafe-path': '非法路径', 'non-string': '值不是字符串' };
    notes.push(`[沙箱] 已拒绝 ${r.rejected.length} 个文件写入：${r.rejected.slice(0, 5).map((x) => `${x.path}（${why[x.reason] || x.reason}）`).join('；')}${r.rejected.length > 5 ? ' …' : ''}`);
  }
  if (!notes.length) return out;
  return { ...out, logs: [...(out.logs || []), ...notes.map((text) => ({ level: 'warn', text }))], filesRejected: r.rejected.length, filesDropped: !r.ok };
}

export function createFS(initial = {}) {
  const files = Object.create(null);
  for (const [k, v] of Object.entries(initial || {})) files[k] = v;
  const has = (p) => Object.prototype.hasOwnProperty.call(files, p);
  return {
    read(path) {
      const p = String(path);
      if (!has(p)) throw new Error(`文件不存在: ${path}`);
      return files[p];
    },
    write(path, content) {
      const p = String(path || '');
      if (!isSafeFsPath(p)) throw new Error(`非法路径: ${p}`);
      files[p] = String(content);
    },
    remove(path) {
      const p = String(path || '');
      if (!isSafeFsPath(p)) return;
      delete files[p];
    },
    list() {
      return Object.entries(files).map(([path, c]) => ({ path, size: cachedSize(path, c) }));
    },
    export() { return { ...files }; },
    import(obj) { for (const [k, v] of Object.entries(obj || {})) { if (isSafeFsPath(k)) files[k] = String(v); } },
    clear() { for (const k of Object.keys(files)) delete files[k]; },
    // 清空工作区（保留内部文件 internal/ 与元数据 .git/）
    clearWorkspace() {
      for (const k of Object.keys(files)) {
        if (WS_INTERNAL_PREFIXES.some((pref) => k.startsWith(pref))) continue;
        delete files[k];
      }
    },
    // 只列出工作区文件（过滤 internal/ 与 .git/）
    listWorkspace() {
      return this.list().filter(({ path }) => !WS_INTERNAL_PREFIXES.some((pref) => path.startsWith(pref)));
    },
    isInternalPath(p) { return WS_INTERNAL_PREFIXES.some((pref) => String(p).startsWith(pref)); },
    has(path) { return has(String(path)); },
    keys() { return Object.keys(files); },
  };
}

// ── 临时沙箱（ephemeral overlay）：任务期间 Agent 写的文件先落在临时层，
//    回合结束时只把「最终回答里提到/展示/引用」的交付物提交到真实沙箱，
//    其余临时文件（调试输出、中间数据、缓存等）随 overlay 一起丢弃。
//    修复 #3：Agent 不再在用户沙箱里留下一堆中间产物。
export function createTempFS(baseFS) {
  const ephemeral = {}; // 本轮临时写的文件
  const deletedInEphemeral = new Set(); // 本轮主动删除的基文件
  const fs = {
    read(path) {
      const p = String(path);
      if (deletedInEphemeral.has(p)) throw new Error(`文件不存在: ${p}`);
      if (Object.prototype.hasOwnProperty.call(ephemeral, p)) return ephemeral[p];
      return baseFS.read(p);
    },
    write(path, content) {
      const p = String(path || '');
      const parts = p.split('/');
      if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')
          || parts.some((seg) => !seg || seg === '.' || seg === '..')) {
        throw new Error(`非法路径: ${p}`);
      }
      ephemeral[p] = String(content);
      deletedInEphemeral.delete(p);
    },
    remove(path) {
      const p = String(path || '');
      if (p.startsWith('/') || p.includes('\0')) return;
      // 临时层删
      delete ephemeral[p];
      // 如果基文件里也有，标记删除
      try { if (baseFS.has(p)) deletedInEphemeral.add(p); } catch { /* noop */ }
    },
    list() {
      const seen = new Set();
      const out = [];
      // 先列临时层
      for (const [path, c] of Object.entries(ephemeral)) {
        seen.add(path);
        out.push({ path, size: cachedSize(path, c) });
      }
      // 再列基文件（剔除被删/被临时覆盖的）
      for (const e of baseFS.list()) {
        if (seen.has(e.path) || deletedInEphemeral.has(e.path)) continue;
        out.push(e);
      }
      return out;
    },
    export() {
      const all = {};
      try { Object.assign(all, baseFS.export()); } catch { /* noop */ }
      for (const k of deletedInEphemeral) delete all[k];
      Object.assign(all, ephemeral);
      return all;
    },
    import(/* obj */) { /* 不允许批量导入临时层 */ },
    clear() {
      for (const k of Object.keys(ephemeral)) delete ephemeral[k];
      deletedInEphemeral.clear();
    },
    clearWorkspace() {
      // 临时层：非内部的删除，内部保留
      for (const k of Object.keys(ephemeral)) {
        if (!WS_INTERNAL_PREFIXES.some((pref) => k.startsWith(pref))) delete ephemeral[k];
      }
      // 基文件：委托基 fs
      try {
        if (baseFS.clearWorkspace) baseFS.clearWorkspace();
        else for (const k of (baseFS.keys ? baseFS.keys() : [])) {
          if (!WS_INTERNAL_PREFIXES.some((pref) => k.startsWith(pref))) { baseFS.remove(k); deletedInEphemeral.delete(k); }
        }
      } catch { /* noop */ }
    },
    listWorkspace() {
      return this.list().filter(({ path }) => !WS_INTERNAL_PREFIXES.some((pref) => path.startsWith(pref)));
    },
    isInternalPath(p) { return WS_INTERNAL_PREFIXES.some((pref) => String(p).startsWith(pref)); },
    has(path) {
      const p = String(path);
      if (deletedInEphemeral.has(p)) return false;
      if (Object.prototype.hasOwnProperty.call(ephemeral, p)) return true;
      return !!baseFS.has && baseFS.has(p);
    },
    keys() {
      const s = new Set();
      for (const k of Object.keys(ephemeral)) s.add(k);
      try { for (const k of baseFS.keys()) if (!deletedInEphemeral.has(k)) s.add(k); } catch { /* noop */ }
      return [...s];
    },
    // 提交：扫描回答文本，把回答里明确引用到的临时文件落到真实沙箱；其余丢弃
    commitAnswer(answerText) {
      const text = String(answerText || '');
      const committed = [];
      const discarded = [];
      // 1) 把被标记删除的基文件真正从 baseFS 删除
      for (const p of deletedInEphemeral) {
        try { baseFS.remove(p); } catch { /* noop */ }
      }
      // 2) 判断临时文件是否在回答里被引用/展示
      const looksReferenced = (path) => {
        // 直接路径字符串出现
        if (text.includes(path)) return true;
        // data-sb-open / data-sb-dl 属性在 HTML 里 → 以 `path` 或 `"path"` 出现
        // （renderMarkdown 后的 HTML 中路径会被包进属性值）
        const esc1 = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 如果生成了 HTML 预览，路径会在 data-sb-open="${path}" 中
        if (new RegExp(`data-sb-(?:open|dl)="${esc1}"`).test(text)) return true;
        // 文件名（basename）在回答中出现且路径本身不晦涩：视为交付物
        const base = path.split('/').pop();
        if (base && /\.(png|jpg|jpeg|gif|svg|webp|pdf|docx|xlsx|pptx|zip|html|md|csv|json|txt)$/i.test(base)
            && text.includes(base)) return true;
        return false;
      };
      for (const [p, c] of Object.entries(ephemeral)) {
        // 白名单前缀（internal/ · uploads/）无条件提交；其余（outputs/、根目录等模型自由创建的）才走引用判定
        if (isAlwaysPersistedPath(p) || looksReferenced(p)) {
          try { baseFS.write(p, c); committed.push(p); } catch { /* noop */ }
        } else {
          discarded.push(p);
        }
      }
      // 清理临时层
      this.clear();
      return { committed, discarded };
    },
    // 丢弃临时层（任务中止 / 失败时调用）：模型自由创建的半截产物丢掉；
    // 白名单前缀下的文件是整文件写入的（抓取全文 / 识图结果 / 下载件），中止也不该让它们蒸发。
    discard() {
      const committed = [];
      const discarded = [];
      for (const [p, c] of Object.entries(ephemeral)) {
        if (isAlwaysPersistedPath(p)) {
          try { baseFS.write(p, c); committed.push(p); continue; } catch { /* 写不进去就按丢弃记 */ }
        }
        discarded.push(p);
      }
      this.clear();
      return { committed, discarded };
    },
    _isTemp: true,
  };
  return fs;
}

let pyodideBroken = false; // CDN 加载失败后不再尝试
export function pythonAvailable() { return !pyodideBroken; }

const PY_PKG_KEY = 'dubhe-py-packages';
function loadPyPkgs() {
  try { return JSON.parse(readLocal(PY_PKG_KEY) || '[]'); } catch { return []; }
}
function savePyPkgs(list) {
  writeLocal(PY_PKG_KEY, JSON.stringify([...new Set((list || []).filter(Boolean))]));
}

// ── Worker 创建：同源文件优先，blob 兜底 ───────────────────────────────
// 背景：部分宿主页面（如预览 iframe）的 CSP 不允许 blob: Worker，
// 直接 new Worker(blobURL) 会触发 onerror（message 为空、瞬间失败）。
// 因此优先加载同源真实文件 js/worker-*.js（CSP 'self' 放行），
// 文件加载再失败时，取源码文本回退为 blob Worker，仍失败则给出明确诊断。
// rpc：{ method: async (params) => result }——主线程替沙箱做它自己做不了的事（目前只有受控 fetch）。
// 通道是 MessageChannel 的一端，随首条消息 transfer 给 Worker；Worker 侧把它关在闭包里，用户代码拿不到。
function runInWorker(workerFile, payload, timeoutMs, { rpc = null, extraScripts = [] } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let active = null; // { worker, dispose }
    let triedBlob = false;
    let channel = null;
    const openChannel = () => {
      if (!rpc || typeof MessageChannel !== 'function') return null;
      channel = new MessageChannel();
      channel.port1.onmessage = async (ev) => {
        const d = ev.data || {};
        const fn = rpc[d.method];
        let reply;
        try { reply = fn ? await fn(d.params || {}) : { error: `沙箱 RPC 不支持 ${d.method}` }; }
        catch (err) { reply = { error: String((err && err.message) || err).slice(0, 300) }; }
        try { channel.port1.postMessage({ id: d.id, ...(reply && typeof reply === 'object' ? reply : { result: reply }) }); } catch { /* Worker 已终止 */ }
      };
      return channel.port2;
    };

    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (active) { try { active.worker.terminate(); } catch { /* noop */ } active.dispose(); }
      if (channel) { try { channel.port1.close(); } catch { /* noop */ } }
      resolve(v);
    };
    const timer = setTimeout(() => finish({
      ok: false, timedOut: true, logs: [], files: payload.files || {},
      error: { message: `执行超时（>${Math.round(timeoutMs / 1000)}s），沙箱已强制终止` },
    }), timeoutMs);

    const spawn = async (useBlob) => {
      let worker = null;
      let dispose = () => {};
      try {
        if (useBlob) {
          const res = await fetch(new URL(workerFile, import.meta.url));
          if (!res.ok) throw new Error(`无法获取沙箱脚本 ${workerFile}（HTTP ${res.status}）`);
          let src = await res.text();
          // blob: Worker 里相对路径的 importScripts 解析不到（基准是 blob:），把附属脚本（运行时垫片）直接拼在前面
          for (const extra of extraScripts) {
            try { const r2 = await fetch(new URL(extra, import.meta.url)); if (r2.ok) src = `${await r2.text()}\n;\n${src}`; } catch { /* 没有垫片也能跑，只是退化为仅 console + files */ }
          }
          const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
          worker = new Worker(url);
          dispose = () => URL.revokeObjectURL(url);
        } else {
          worker = new Worker(new URL(workerFile, import.meta.url));
        }
      } catch (err) {
        if (!useBlob && !triedBlob) { triedBlob = true; return spawn(true); }
        return finish({ ok: false, logs: [], files: payload.files || {}, error: { message: `沙箱创建失败：${err.message}` } });
      }
      active = { worker, dispose };
      worker.onmessage = (e) => finish(e.data);
      worker.onerror = (e) => {
        if (settled) return;
        try { worker.terminate(); } catch { /* noop */ }
        dispose(); active = null;
        if (!useBlob && !triedBlob) { triedBlob = true; return spawn(true); }
        const detail = [e.message, e.filename && `${e.filename.split('/').pop()}:${e.lineno}`].filter(Boolean).join(' @ ');
        finish({
          ok: false, logs: [], files: payload.files || {},
          error: { message: `沙箱 Worker 加载失败${detail ? '：' + detail : ''}（可能受页面 CSP 限制，请尝试在新标签页打开本应用）` },
        });
      };
      const port = openChannel();
      if (port) worker.postMessage(payload, [port]); else worker.postMessage(payload);
    };
    spawn(false);
  });
}

// 对外统一执行接口：返回 { ok, logs, result, error, timedOut, durationMs, files }
// 沙箱内受控网络的上限：一次执行最多 8 次抓取、单次 ≤ 2 MB、累计 ≤ 6 MB——够拉几个 JSON / 一个 CDN 库，不够当爬虫
export const SANDBOX_NET_LIMITS = Object.freeze({ maxCalls: 8, maxBytesPerCall: 2 * 1024 * 1024, maxBytesTotal: 6 * 1024 * 1024 });
export function createSandboxNetRpc(net, limits = SANDBOX_NET_LIMITS) {
  if (!net || !net.enabled || typeof net.fetchPage !== 'function') return null;
  let calls = 0; let bytes = 0;
  return {
    async fetch({ url, mode } = {}) {
      if (++calls > limits.maxCalls) return { error: `沙箱内 fetch 次数超过上限（${limits.maxCalls} 次/次执行）` };
      const r = await net.fetchPage({ url: String(url || ''), mode: mode === 'text' ? 'text' : 'raw', maxBytes: limits.maxBytesPerCall, full: true, fs: null });
      if (!r || !r.ok) return { ok: false, status: (r && r.status) || 0, error: (r && r.error) || '抓取失败' };
      const text = String(r.text || '');
      bytes += text.length;
      if (bytes > limits.maxBytesTotal) return { error: `沙箱内 fetch 累计字节超过上限（${Math.round(limits.maxBytesTotal / 1048576)} MB/次执行）` };
      return { ok: true, status: r.status || 200, url: r.url || url, contentType: r.contentType || '', text };
    },
  };
}

// opts.net = { enabled, fetchPage }：宿主是否放行沙箱内网络（顶栏联网开 + 中继可用），放行时由主线程代为抓取
export async function runJavaScript(code, fsObj, opts = {}) {
  const t0 = performance.now();
  const files = fsObj.export();
  const rpc = createSandboxNetRpc(opts.net);
  let out = await runInWorker('worker-js.js', { code, files, net: { enabled: !!rpc, ...SANDBOX_NET_LIMITS } }, SANDBOX_JS_TIMEOUT_MS, { rpc, extraScripts: ['worker-shims.js'] });
  if (out.files && !out.timedOut) out = noteWorkerFiles(out, applyWorkerFiles(fsObj, files, out.files));
  return { ...out, durationMs: Math.round(performance.now() - t0) };
}

// ── Python：常驻 Worker（Pyodide 运行时只加载一次）─────────────────────
let pyWorker = null;
let pySyncedWorker = null; // 上次成功同步过镜像的 Worker 实例
let pySynced = null;       // 该 Worker 当前持有的镜像（{path: content}）
// 只传变化：引用相同的字符串比较是 O(1)，未改动的大文件不会被扫描
export function diffFiles(prev, next) {
  const set = {};
  const del = [];
  const p = prev || {};
  const n = next || {};
  for (const k of Object.keys(n)) if (!(k in p) || p[k] !== n[k]) set[k] = n[k];
  for (const k of Object.keys(p)) if (!(k in n)) del.push(k);
  return { set, del };
}
export function applyDelta(base, delta) {
  const out = { ...(base || {}) };
  const d = delta || {};
  for (const k of Object.keys(d.set || {})) out[k] = d.set[k];
  for (const k of (Array.isArray(d.del) ? d.del : [])) delete out[k];
  return out;
}
let pyBlobTried = false;

export async function runPython(code, fsObj, onProgress, extraPkgs = []) {
  if (pyodideBroken) {
    return { ok: false, logs: [], error: { message: 'Pyodide 运行时不可用（CDN 加载失败），请改用 execute_javascript' }, durationMs: 0 };
  }
  const files = fsObj.export();
  const packages = [...new Set([...loadPyPkgs(), ...(Array.isArray(extraPkgs) ? extraPkgs : [])])];
  const t0 = performance.now();
  // 增量同步：常驻 Worker 已持有上次镜像时只发 diff；Worker 重建 / 上次失败则发全量
  // 不论全量还是增量，Worker 应用完载荷后的镜像都恰好等于 files（delta = diff(镜像, files)）
  let usedWorker = null;
  let sentFull = true;
  const buildPayload = (worker) => {
    usedWorker = worker;
    if (worker === pySyncedWorker && pySynced) {
      sentFull = false;
      return { code, delta: diffFiles(pySynced, files), packages };
    }
    sentFull = true;
    return { code, files, packages };
  };

  const attempt = (useBlob) => new Promise((resolve) => {
    const spawn = async () => {
      if (useBlob) {
        const res = await fetch(new URL('worker-py.js', import.meta.url));
        if (!res.ok) throw new Error(`无法获取沙箱脚本（HTTP ${res.status}）`);
        const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
        pyWorker = new Worker(url); // 常驻复用：后续 attempt(false) 直接拿到这个 blob Worker
        return pyWorker;
      }
      if (!pyWorker) pyWorker = new Worker(new URL('worker-py.js', import.meta.url));
      return pyWorker;
    };
    spawn().then((worker) => {
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        try { worker.terminate(); } catch { /* noop */ }
        if (pyWorker === worker) pyWorker = null;
        finish({ ok: false, timedOut: true, logs: [], files, error: { message: `执行超时（>${Math.round(SANDBOX_PY_TIMEOUT_MS / 1000)}s），沙箱已强制终止` } });
      }, SANDBOX_PY_TIMEOUT_MS);
      worker.onmessage = (e) => {
        if (e.data && e.data.__progress) { onProgress && onProgress(String(e.data.__progress)); return; }
        finish(e.data);
      };
      worker.onerror = (e) => finish({ __workerError: e.message || '加载失败' });
      worker.postMessage(buildPayload(worker));
    }).catch((err) => resolve({ __workerError: err.message }));
  });

  let out = await attempt(false);
  if (out.__workerError && !pyBlobTried) {
    // 文件 Worker 被拦截（如 CSP）→ 回退 blob Worker 重试一次
    pyBlobTried = true;
    pyWorker = null;
    out = await attempt(true);
  }
  if (out.__workerError) {
    pyWorker = null;
    return {
      ok: false, logs: [], files,
      error: { message: `Python 沙箱 Worker 加载失败：${out.__workerError}（可能受页面 CSP 限制）` },
      durationMs: Math.round(performance.now() - t0),
    };
  }
  if (out.timedOut) pyWorker = null;
  // 只有「运行时加载阶段」失败才标记不可用。过去用正则匹配错误文本，而 Pyodide 的 Python 回溯里
  // 本身就带 _pyodide/ 路径——任何一次用户代码抛异常都会把整个会话的 Python 沙箱误判为坏掉。
  const loadStageFailure = !out.ok && (out.stage === 'load'
    || (out.stage === undefined && /importScripts|loadPyodide|indexURL/i.test(String(out.error && out.error.message)) && !/Traceback/.test(String(out.error && out.error.message))));
  if (loadStageFailure) {
    pyodideBroken = true;
    pyWorker = null;
    out.error.message += '（已标记 Python 沙箱不可用，本次会话内请使用 execute_javascript）';
  }
  // 回传形态：新版 filesDelta {set, del}（相对 Worker 镜像），旧版 files 全量
  let workerAfter = null;
  if (out.ok && out.filesDelta && typeof out.filesDelta === 'object') {
    workerAfter = applyDelta(files, out.filesDelta);
  } else if (out.files && !out.timedOut) {
    workerAfter = out.files;
  }
  if (workerAfter) {
    out = noteWorkerFiles(out, applyWorkerFiles(fsObj, files, workerAfter));
    // 记录 Worker 镜像（含被主线程拒收的条目——下一轮 diff 会把它们纠正回来）
    pySyncedWorker = out.ok ? usedWorker : null;
    pySynced = out.ok ? workerAfter : null;
  } else {
    pySyncedWorker = null;
    pySynced = null;
  }
  if (sentFull && !out.ok) { pySyncedWorker = null; pySynced = null; }
  if (Array.isArray(out.installed)) savePyPkgs(out.installed.filter((n) => typeof n === 'string' && /^[A-Za-z0-9_.\-\[\]]{1,80}$/.test(n)).slice(0, 200));
  return { ...out, durationMs: Math.round(performance.now() - t0) };
}

// ── C++：Compiler Explorer 公共 API 远程编译执行 ───────────────────────
// （浏览器内没有轻量 C++ 运行时；godbolt.org 已放行 CORS，实测执行/错误捕获可用）
const CE_BASE = 'https://godbolt.org';
let cppCompilerId = 'g142'; // 默认 GCC 14.2（已实测可用）
let cppCompilerDetected = false;

// 注意：编译器 ID 数字≠版本大小（g550=GCC 5.5.0 < g142=GCC 14.2），必须按 semver 字段排序
async function detectCppCompiler() {
  try {
    const res = await fetch(`${CE_BASE}/api/compilers/c++?fields=id,semver`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const list = await res.json();
    const bySemverDesc = (x, y) => {
      const a = String(x.semver).split('.').map(Number);
      const b = String(y.semver).split('.').map(Number);
      for (let i = 0; i < 3; i++) if ((b[i] || 0) !== (a[i] || 0)) return (b[i] || 0) - (a[i] || 0);
      return 0;
    };
    const valid = (c) => /^\d+\.\d+/.test(c.semver || '');
    const gcc = list.filter((c) => /^g\d/.test(c.id) && valid(c)).sort(bySemverDesc);
    const any = list.filter(valid).sort(bySemverDesc);
    if (gcc.length) cppCompilerId = gcc[0].id;
    else if (any.length) cppCompilerId = any[0].id;
  } catch { /* 网络失败保留默认 g142 */ }
}

export async function runCpp(code, opts = {}) {
  const t0 = performance.now();
  const dur = () => Math.round(performance.now() - t0);
  const extraFiles = Array.isArray(opts.files) ? opts.files.filter((f) => f && f.filename) : [];
  const stdin = opts.stdin == null ? '' : String(opts.stdin);
  const argv = Array.isArray(opts.args) ? opts.args.map((a) => String(a)) : [];
  try {
    if (!cppCompilerDetected) { cppCompilerDetected = true; await detectCppCompiler(); }
    const payload = {
      source: code,
      options: {
        userArguments: '-O2 -std=c++20',
        executeParameters: { args: argv, stdin },
        compilerOptions: { executorRequest: true }, // 关键：executorRequest 才是「编译并执行」
        filters: { execute: true },
        tools: [],
      },
      lang: 'c++',
      allowStoreCodeDebug: true,
    };
    if (extraFiles.length) payload.files = extraFiles.map((f) => ({ filename: String(f.filename), contents: String(f.contents ?? '') }));
    const res = await fetch(`${CE_BASE}/api/compiler/${cppCompilerId}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, logs: [], error: { message: `Compiler Explorer HTTP ${res.status}` }, durationMs: dur() };
    const j = await res.json();
    const logs = [
      ...(j.stdout || []).filter((l) => l.text !== '').map((l) => ({ level: 'log', text: l.text })),
      ...(j.stderr || []).filter((l) => l.text && l.text.trim() !== '').map((l) => ({ level: 'error', text: l.text })),
    ];
    const ok = j.code === 0;
    return {
      ok, logs,
      error: ok ? undefined : { message: j.code === -1 ? '编译失败（详见 stderr 诊断）' : `进程退出码 ${j.code}` },
      durationMs: dur(),
    };
  } catch (err) {
    return { ok: false, logs: [], error: { message: `C++ 远程执行失败：${err.message}（godbolt.org 不可达？）` }, durationMs: dur() };
  }
}
