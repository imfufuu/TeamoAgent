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
    // Worker 常驻复用：上一轮赋的 result 不会自己消失，不清掉就会把旧结果当成本轮输出
    try { pyodide.globals.delete('result'); } catch { /* 无该全局时忽略 */ }
    await pyodide.runPythonAsync(code);
    // 注意 API 名称：Pyodide 只有 proxy.toJs({...})（实例方法），没有 pyodide.toJS；
    // 写成 toJS 会抛 TypeError 并被 catch 吞掉 —— 表现是 Python 里写的 FILES
    // 与 result「静默丢失」。dict_converter 必须给：dict 默认转成 Map，
    // JSON.stringify(Map) === {}，那样反而会清空整个虚拟文件系统。
    let outFiles = fs;
    try {
      const f = pyodide.globals.get('FILES');
      if (f !== undefined && f !== null) {
        const js = f.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false });
        outFiles = JSON.parse(JSON.stringify(js));
        if (typeof f.destroy === 'function') f.destroy(); // 释放 PyProxy，避免内存泄漏
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
    self.postMessage({ ok: true, logs, files: outFiles, result });
  } catch (err) {
    self.postMessage({ ok: false, logs, files: files || {}, error: { message: String((err && err.message) || err) } });
  }
};
