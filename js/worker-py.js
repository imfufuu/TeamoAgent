// TeamoAgent · Python 沙箱 Worker（Pyodide / WebAssembly，独立同源文件）
// FILES 字典 = 虚拟文件系统；print 输出被捕获；全局变量 result 作为返回值
let loaded = null;
self.onmessage = async (e) => {
  const { code, files } = e.data;
  const logs = [];
  try {
    if (!loaded) {
      importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
      loaded = await loadPyodide();
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
