// Dubhe Agent · JS 沙箱 Worker（独立同源文件，避免 blob: 被页面 CSP 拦截）
// 环境：无 DOM；files 为虚拟文件系统快照；console 输出被捕获；支持顶层 await
self.onmessage = async (e) => {
  const { code, files } = e.data;
  const logs = [];
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2); }
    catch { return String(a); }
  };
  const make = (level) => (...a) => logs.push({ level, text: a.map(fmt).join(' ') });
  const console = { log: make('log'), info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug'), table: make('log') };
  let fs = {};
  try { fs = JSON.parse(JSON.stringify(files || {})); } catch { fs = {}; }
  try {
    const fn = new Function('console', 'files', '"use strict";\nreturn (async () => {\n' + code + '\n})();');
    const result = await fn(console, fs);
    let out;
    try { out = JSON.parse(JSON.stringify(result)); } catch { out = String(result); }
    self.postMessage({ ok: true, logs, result: result === undefined ? undefined : out, files: fs });
  } catch (err) {
    let message = String((err && err.message) || err);
    if (/is not defined|Can't find variable|is not a function/i.test(message)) {
      message += "。未定义该名字：此沙箱为 Web Worker，无 Node API（无 require/fs/process/Buffer），无 DOM/fetch。仅提供 console 与 files。键=完整相对路径，例如 files['files/a.txt'] = 'hi'。失败后先探测 Object.keys(files)、typeof console，不要换 API 名盲猜。";
    }
    self.postMessage({ ok: false, logs, files: fs, error: { message, stack: (err && err.stack) || '' } });
  }
};
