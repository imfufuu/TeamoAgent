// Dubhe Agent · Python 沙箱 Worker（Pyodide / WebAssembly，独立同源文件）
// 关键：经典 Worker 中 importScripts 加载后，loadPyodide 必须显式传 indexURL。
// 第三方库：micropip.install；本 Worker 内 installed Set 去重。刷新后运行时重建，包名由主线程再传入，字节走浏览器缓存。
//
// 安全加固：
//   · 运行时与包必须从网上拉，所以 fetch / importScripts 不能整体删除，改为私有化真实引用 +
//     全局替换成「仅允许白名单源」的版本（cdn.jsdelivr.net/pyodide/、pypi.org、files.pythonhosted.org）。
//     用户 Python 代码经 `import js; js.fetch(...)` / pyodide.http 发往其他域名会被直接拒绝。
//   · XMLHttpRequest / WebSocket / EventSource / Worker / BroadcastChannel / indexedDB / caches 一律移除。
//   · 真实 postMessage 私有化，全局置空，防止伪造结果帧；输出做与 JS 沙箱相同的硬上限。
const PY_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const ALLOWED_ORIGINS = [
  /^https:\/\/cdn\.jsdelivr\.net\/pyodide\//,
  /^https:\/\/pypi\.org\//,
  /^https:\/\/files\.pythonhosted\.org\//,
];
const post = self.postMessage.bind(self);
const realFetch = self.fetch.bind(self);
const realImportScripts = self.importScripts.bind(self);
const LOG_MAX_ENTRIES = 500;
const LOG_MAX_BYTES = 1024 * 1024;
const RESULT_MAX_BYTES = 200 * 1024;
const FILES_MAX_BYTES = 128 * 1024 * 1024;
const FILES_MAX_COUNT = 5000;
let loaded = null;
const installed = new Set();
const networkDenied = [];

function urlOf(input) {
  try { return String(input instanceof Request ? input.url : (input && input.url) || input); } catch { return String(input); }
}
function allowed(url) { return ALLOWED_ORIGINS.some((re) => re.test(url)); }

function lockdown() {
  const protoList = [];
  try { protoList.push(WorkerGlobalScope.prototype); } catch { /* ignore */ }
  try { protoList.push(DedicatedWorkerGlobalScope.prototype); } catch { /* ignore */ }
  const guardedFetch = function fetch(input, init) {
    const url = urlOf(input);
    if (!allowed(url)) {
      networkDenied.push(url);
      return Promise.reject(new TypeError(`沙箱禁止联网：${url.slice(0, 120)}（仅允许 Pyodide CDN 与 PyPI 下载依赖）`));
    }
    return realFetch(input, init);
  };
  const guardedImport = function importScripts(...urls) {
    for (const u of urls) {
      const url = String(u);
      if (!allowed(url)) { networkDenied.push(url); throw new TypeError(`沙箱禁止加载外部脚本：${url.slice(0, 120)}`); }
    }
    return realImportScripts(...urls);
  };
  const removeNames = ['XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB', 'caches', 'WebTransport', 'RTCPeerConnection', 'RTCDataChannel', 'showDirectoryPicker', 'showOpenFilePicker', 'showSaveFilePicker'];
  for (const proto of protoList) {
    for (const name of ['fetch', 'importScripts', ...removeNames]) {
      try { if (Object.prototype.hasOwnProperty.call(proto, name)) delete proto[name]; } catch { /* ignore */ }
    }
  }
  try { Object.defineProperty(self, 'fetch', { value: guardedFetch, writable: false, configurable: false }); } catch { /* ignore */ }
  try { Object.defineProperty(self, 'importScripts', { value: guardedImport, writable: false, configurable: false }); } catch { /* ignore */ }
  for (const name of removeNames) {
    try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false, enumerable: false }); } catch { /* ignore */ }
  }
  try { Object.defineProperty(self, 'postMessage', { value: () => {}, writable: false, configurable: false }); } catch { /* ignore */ }
  try { Object.defineProperty(self, 'onmessage', { value: null, writable: false, configurable: false }); } catch { /* ignore */ }
}
lockdown();

function pushLog(logs, level, text) {
  if (logs.length >= LOG_MAX_ENTRIES) { logs.__dropped = (logs.__dropped || 0) + 1; return; }
  const t = String(text);
  logs.__bytes = (logs.__bytes || 0) + t.length;
  if (logs.__bytes > LOG_MAX_BYTES) { logs.__dropped = (logs.__dropped || 0) + 1; return; }
  logs.push({ level, text: t.length > 64 * 1024 ? `${t.slice(0, 64 * 1024)}…[单条日志截断]` : t });
}
function flushLogs(logs) {
  if (logs.__dropped) logs.push({ level: 'warn', text: `[沙箱] 日志超出上限（${LOG_MAX_ENTRIES} 条 / 1 MB），已丢弃 ${logs.__dropped} 条` });
  if (networkDenied.length) {
    logs.push({ level: 'warn', text: `[沙箱] 已拦截 ${networkDenied.length} 次出网请求：${[...new Set(networkDenied)].slice(0, 3).map((u) => u.slice(0, 80)).join('，')}` });
    networkDenied.length = 0;
  }
  delete logs.__dropped; delete logs.__bytes;
  return logs;
}
function sanitizeFiles(fs, logs) {
  const out = {};
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
  if (bad.length) logs.push({ level: 'warn', text: `[沙箱] 以下 FILES 条目未被保存：${bad.slice(0, 8).join('；')}${bad.length > 8 ? ` 等 ${bad.length} 项` : ''}` });
  return out;
}
function capResult(result) {
  if (result === undefined) return undefined;
  const text = String(result);
  return text.length > RESULT_MAX_BYTES ? `${text.slice(0, RESULT_MAX_BYTES)}…[result 超过 200 KB，已截断；大结果请写入 FILES]` : result;
}

const IMPORT_ALIAS = {
  numpy: 'numpy', np: 'numpy', pandas: 'pandas', pd: 'pandas',
  PIL: 'Pillow', pillow: 'Pillow', cv2: 'opencv-python', sklearn: 'scikit-learn',
  scipy: 'scipy', matplotlib: 'matplotlib', requests: 'requests',
  bs4: 'beautifulsoup4', yaml: 'pyyaml', lxml: 'lxml',
  sympy: 'sympy', networkx: 'networkx', dateutil: 'python-dateutil',
};

function pkgsFromCode(code) {
  const found = [];
  const re = /(?:^|\n)\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(String(code || '')))) {
    const raw = m[1];
    if (['os', 'sys', 'json', 're', 'math', 'time', 'random', 'itertools', 'functools', 'collections', 'typing', 'pathlib', 'io', 'csv', 'datetime', 'string', 'struct', 'hashlib', 'base64', 'copy', 'operator', 'statistics', 'decimal', 'fractions', 'unicodedata', 'textwrap', 'pprint', 'enum', 'dataclasses', 'abc', 'contextlib', 'traceback', 'warnings', 'ast', 'asyncio', 'js', 'pyodide', 'micropip', 'pyodide_js', 'numbers', 'array', 'bisect', 'heapq', 'queue', 'threading', 'secrets', 'uuid', 'zlib', 'gzip', 'zipfile', 'tarfile', 'shutil', 'tempfile', 'glob', 'fnmatch', 'logging', 'argparse', 'inspect', 'types', 'weakref', 'gc', 'platform', 'locale', 'calendar', 'html', 'xml', 'urllib', 'http', 'email', 'sqlite3', 'pickle', 'shelve', 'difflib', 'cmath'].includes(raw)) continue;
    found.push(IMPORT_ALIAS[raw] || raw);
  }
  return found;
}

self.addEventListener('message', async (e) => {
  const { code, files, packages } = e.data || {};
  const logs = [];
  try {
    if (!loaded) {
      post({ __progress: '正在加载 Python 运行时…' });
      realImportScripts(PY_BASE + 'pyodide.js');
      loaded = await loadPyodide({ indexURL: PY_BASE });
      post({ __progress: 'Python 运行时就绪' });
    }
    const pyodide = loaded;
    pyodide.setStdout({ batched: (s) => pushLog(logs, 'log', s) });
    pyodide.setStderr({ batched: (s) => pushLog(logs, 'error', s) });

    const want = [...new Set([...(packages || []), ...pkgsFromCode(code)])].filter(Boolean);
    const missing = want.filter((p) => !installed.has(p));
    if (missing.length) {
      post({ __progress: `正在安装 Python 库：${missing.join(', ')}…` });
      try { await pyodide.loadPackage('micropip'); } catch { /* 已装 */ }
      const micropip = pyodide.pyimport('micropip');
      for (const p of missing) {
        try {
          try { await pyodide.loadPackage(p); }
          catch { await micropip.install(p); }
          installed.add(p);
        } catch (err) {
          pushLog(logs, 'error', `安装 ${p} 失败：${err && err.message ? err.message : err}`);
        }
      }
    }

    let fs = {};
    try { fs = JSON.parse(JSON.stringify(files || {})); } catch { fs = {}; }
    pyodide.globals.set('FILES', pyodide.toPy(fs));
    try { pyodide.globals.delete('result'); } catch { /* 无该全局时忽略 */ }
    await pyodide.runPythonAsync(code);
    let outFiles = fs;
    try {
      const f = pyodide.globals.get('FILES');
      if (f !== undefined && f !== null) {
        const js = f.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false });
        outFiles = JSON.parse(JSON.stringify(js));
        if (typeof f.destroy === 'function') f.destroy();
      }
    } catch { outFiles = fs; }
    let result;
    try {
      const r = pyodide.globals.get('result');
      if (r !== undefined && r !== null) {
        if (typeof r === 'object' && typeof r.toJs === 'function') {
          try { result = JSON.stringify(r.toJs({ dict_converter: Object.fromEntries })); }
          catch { result = String(r); }
        } else {
          result = String(r);
        }
        if (typeof r.destroy === 'function') r.destroy();
      }
    } catch { result = undefined; }
    post({ ok: true, logs: flushLogs(logs), files: sanitizeFiles(outFiles, logs), result: capResult(result), installed: [...installed] });
  } catch (err) {
    post({ ok: false, logs: flushLogs(logs), files: files || {}, error: { message: String((err && err.message) || err) }, installed: [...installed] });
  }
});
