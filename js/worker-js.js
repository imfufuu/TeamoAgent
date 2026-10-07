// Dubhe Agent · JS 沙箱 Worker（独立同源文件，避免 blob: 被页面 CSP 拦截）
// 环境：无 DOM；files 为虚拟文件系统快照；console 输出被捕获；支持顶层 await
//
// 安全加固（见 docs「沙箱安全」）：
//   1. 执行用户代码前先拆掉 Worker 全局里所有能出网 / 持久化 / 再派生的能力：
//      fetch · importScripts · XMLHttpRequest · WebSocket · EventSource · Worker · SharedWorker ·
//      BroadcastChannel · indexedDB · caches · navigator · WebTransport · RTCPeerConnection。
//      删除的是原型上的原生引用，用户代码拿不回来（没有任何剩余原语能真正发包）。
//   2. 真正的 postMessage 先捕获为私有引用，再把全局 postMessage 置为空函数并锁死 onmessage，
//      防止用户代码伪造「执行成功」的结果帧或劫持后续消息。
//   3. 输出做硬上限：日志 ≤ 500 条 / 1 MB，result ≤ 200 KB，files 只接受字符串值且总量 ≤ 128 MB；
//      主线程还会再做一次路径白名单校验（sandbox.js sanitizeWorkerFiles）。
const post = self.postMessage.bind(self);
const LOG_MAX_ENTRIES = 500;
const LOG_MAX_BYTES = 1024 * 1024;
const RESULT_MAX_BYTES = 200 * 1024;
const FILES_MAX_BYTES = 128 * 1024 * 1024;
const FILES_MAX_COUNT = 5000;

function lockdown() {
  const removed = [];
  const protoList = [];
  try { protoList.push(WorkerGlobalScope.prototype); } catch { /* ignore */ }
  try { protoList.push(DedicatedWorkerGlobalScope.prototype); } catch { /* ignore */ }
  const names = [
    'fetch', 'importScripts', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker',
    'BroadcastChannel', 'indexedDB', 'caches', 'navigator', 'WebTransport', 'RTCPeerConnection',
    'RTCDataChannel', 'FileSystemHandle', 'FileSystemFileHandle', 'FileSystemDirectoryHandle',
    'showDirectoryPicker', 'showOpenFilePicker', 'showSaveFilePicker',
  ];
  for (const name of names) {
    for (const proto of protoList) {
      try { if (Object.prototype.hasOwnProperty.call(proto, name)) { delete proto[name]; removed.push(name); } } catch { /* 非 configurable 时下面再覆盖 */ }
    }
    try { if (name in self) Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false, enumerable: false }); } catch { /* ignore */ }
  }
  // postMessage：真实引用已私有化；全局改成空函数并锁死，onmessage 也不可再改
  try { Object.defineProperty(self, 'postMessage', { value: () => {}, writable: false, configurable: false }); } catch { /* ignore */ }
  try { Object.defineProperty(self, 'onmessage', { value: null, writable: false, configurable: false }); } catch { /* ignore */ }
  try { Object.defineProperty(self, 'onmessageerror', { value: null, writable: false, configurable: false }); } catch { /* ignore */ }
  return removed;
}

const fmt = (a) => {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2); }
  catch { return String(a); }
};

function makeConsole(logs) {
  let bytes = 0;
  let dropped = 0;
  const push = (level, parts) => {
    if (logs.length >= LOG_MAX_ENTRIES || bytes >= LOG_MAX_BYTES) { dropped++; return; }
    let text = parts.map(fmt).join(' ');
    if (text.length > 64 * 1024) text = `${text.slice(0, 64 * 1024)}…[单条日志截断]`;
    bytes += text.length;
    logs.push({ level, text });
  };
  const make = (level) => (...a) => push(level, a);
  const con = { log: make('log'), info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug'), table: make('log'), dir: make('log'), trace: make('log') };
  con.__flush = () => { if (dropped) logs.push({ level: 'warn', text: `[沙箱] 日志超出上限（${LOG_MAX_ENTRIES} 条 / 1 MB），已丢弃 ${dropped} 条` }); };
  return con;
}

function sanitizeResult(result) {
  if (result === undefined) return undefined;
  let out;
  try { out = JSON.parse(JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? String(v) : v))); } catch { out = String(result); }
  let text;
  try { text = typeof out === 'string' ? out : JSON.stringify(out); } catch { text = String(out); }
  if (text && text.length > RESULT_MAX_BYTES) return `${text.slice(0, RESULT_MAX_BYTES)}…[result 超过 200 KB，已截断；大结果请写入 files]`;
  return out;
}

function sanitizeFiles(fs, logs) {
  const out = Object.create(null);
  let total = 0;
  let count = 0;
  const bad = [];
  for (const key of Object.keys(fs || {})) {
    const v = fs[key];
    if (typeof v !== 'string') { bad.push(`${key}（值不是字符串，已忽略）`); continue; }
    if (++count > FILES_MAX_COUNT) { bad.push(`${key}（文件数超过 ${FILES_MAX_COUNT}）`); continue; }
    total += v.length;
    if (total > FILES_MAX_BYTES) { bad.push(`${key}（总量超过 128 MB）`); total -= v.length; continue; }
    out[key] = v;
  }
  if (bad.length) logs.push({ level: 'warn', text: `[沙箱] 以下 files 条目未被保存：${bad.slice(0, 8).join('；')}${bad.length > 8 ? ` 等 ${bad.length} 项` : ''}` });
  return out;
}

self.addEventListener('message', async (e) => {
  const { code, files } = e.data || {};
  const logs = [];
  const console = makeConsole(logs);
  let fs = Object.create(null);
  try { Object.assign(fs, JSON.parse(JSON.stringify(files || {}))); } catch { fs = Object.create(null); }
  lockdown();
  try {
    const fn = new Function('console', 'files', '"use strict";\nreturn (async () => {\n' + code + '\n})();');
    const result = await fn(console, fs);
    console.__flush();
    post({ ok: true, logs, result: sanitizeResult(result), files: sanitizeFiles(fs, logs) });
  } catch (err) {
    console.__flush();
    let message = String((err && err.message) || err);
    if (/is not defined|Can't find variable|is not a function/i.test(message)) {
      message += "。未定义该名字：此沙箱为 Web Worker，无 Node API（无 require/fs/process/Buffer），无 DOM，也没有 fetch/XMLHttpRequest/WebSocket/importScripts（已被沙箱移除，代码不能联网）。仅提供 console 与 files（无原型字典：files.constructor 为 undefined，用 Object.keys 遍历）。键=完整相对路径，例如 files['files/a.txt'] = 'hi'；对 files 的增删改会在执行结束后同步回会话文件系统。失败后先探测 Object.keys(files)、typeof console，不要换 API 名盲猜。";
    }
    post({ ok: false, logs, files: sanitizeFiles(fs, logs), error: { message, stack: (err && err.stack) || '' } });
  }
}, { once: false });
