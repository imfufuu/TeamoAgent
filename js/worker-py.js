// TeamoAgent · Python 沙箱 Worker（Pyodide / WebAssembly，独立同源文件）
// 关键：经典 Worker 中 importScripts 加载后，loadPyodide 必须显式传 indexURL，
// 否则无法定位 pyodide.asm.wasm（这是官方文档明确要求的）。
// Worker 常驻复用：运行时只加载一次，后续执行秒级启动。
const PY_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
let loaded = null;

self.onmessage = async (e) => {
  const { code, files } = e.data;
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
    let fs = {};
    try { fs = JSON.parse(JSON.stringify(files || {})); } catch { fs = {}; }
    pyodide.globals.set('FILES', pyodide.toPy(fs));
    await pyodide.runPythonAsync(code);
    let outFiles = fs;
    try {
      const f = pyodide.globals.get('FILES');
      if (f !== undefined && f !== null) outFiles = JSON.parse(JSON.stringify(pyodide.toJS(f)));
    } catch { outFiles = fs; }
    let result;
    try {
      const r = pyodide.globals.get('result');
      if (r !== undefined && r !== null) result = String(pyodide.toJS(r));
    } catch { result = undefined; }
    self.postMessage({ ok: true, logs, files: outFiles, result });
  } catch (err) {
    self.postMessage({ ok: false, logs, files: files || {}, error: { message: String((err && err.message) || err) } });
  }
};
