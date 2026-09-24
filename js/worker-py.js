// TeamoAgent · Python 沙箱 Worker（Pyodide / WebAssembly，独立同源文件）
// 关键：经典 Worker 中 importScripts 加载后，loadPyodide 必须显式传 indexURL。
// 第三方库：micropip.install；已装包名由主线程记到 localStorage，刷新后重装。
const PY_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
let loaded = null;
const installed = new Set();

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
    if (['os', 'sys', 'json', 're', 'math', 'time', 'random', 'itertools', 'functools', 'collections', 'typing', 'pathlib', 'io', 'csv', 'datetime', 'string', 'struct', 'hashlib', 'base64', 'copy', 'operator', 'statistics', 'decimal', 'fractions', 'unicodedata', 'textwrap', 'pprint', 'enum', 'dataclasses', 'abc', 'contextlib', 'traceback', 'warnings', 'ast'].includes(raw)) continue;
    found.push(IMPORT_ALIAS[raw] || raw);
  }
  return found;
}

self.onmessage = async (e) => {
  const { code, files, packages } = e.data;
  const logs = [];
  try {
    if (!loaded) {
      self.postMessage({ __progress: '正在加载 Python 运行时…' });
      importScripts(PY_BASE + 'pyodide.js');
      loaded = await loadPyodide({ indexURL: PY_BASE });
      self.postMessage({ __progress: 'Python 运行时就绪' });
    }
    const pyodide = loaded;
    pyodide.setStdout({ batched: (s) => logs.push({ level: 'log', text: String(s) }) });
    pyodide.setStderr({ batched: (s) => logs.push({ level: 'error', text: String(s) }) });

    const want = [...new Set([...(packages || []), ...pkgsFromCode(code)])].filter(Boolean);
    const missing = want.filter((p) => !installed.has(p));
    if (missing.length) {
      self.postMessage({ __progress: `正在安装 Python 库：${missing.join(', ')}…` });
      try { await pyodide.loadPackage('micropip'); } catch { /* 已装 */ }
      const micropip = pyodide.pyimport('micropip');
      for (const p of missing) {
        try {
          try { await pyodide.loadPackage(p); }
          catch { await micropip.install(p); }
          installed.add(p);
        } catch (err) {
          logs.push({ level: 'error', text: `安装 ${p} 失败：${err && err.message ? err.message : err}` });
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
    self.postMessage({ ok: true, logs, files: outFiles, result, installed: [...installed] });
  } catch (err) {
    self.postMessage({ ok: false, logs, files: files || {}, error: { message: String((err && err.message) || err) }, installed: [...installed] });
  }
};
