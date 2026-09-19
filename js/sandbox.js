// ─── 沙箱：隔离代码执行 + 虚拟文件系统 ────────────────────────────────
// JS 沙箱：独立 Web Worker，无 DOM/fetch 访问面，超时强制 terminate
// Python 沙箱：Pyodide（WASM）跑在独立 Worker 中，可终止；CDN 加载失败时优雅降级

import { SANDBOX_JS_TIMEOUT_MS, SANDBOX_PY_TIMEOUT_MS } from './config.js';

// ── 虚拟文件系统（会话级，随 state 持久化）─────────────────────────────
export function createFS(initial = {}) {
  const files = { ...initial };
  return {
    read(path) {
      if (!(path in files)) throw new Error(`文件不存在: ${path}`);
      return files[path];
    },
    write(path, content) { files[path] = String(content); },
    remove(path) { delete files[path]; },
    list() {
      return Object.entries(files).map(([path, c]) => ({ path, size: String(c).length }));
    },
    export() { return { ...files }; },
    import(obj) { for (const [k, v] of Object.entries(obj || {})) files[k] = String(v); },
    clear() { for (const k of Object.keys(files)) delete files[k]; },
  };
}

let pyodideBroken = false; // CDN 加载失败后不再尝试
export function pythonAvailable() { return !pyodideBroken; }

// ── Worker 创建：同源文件优先，blob 兜底 ───────────────────────────────
// 背景：部分宿主页面（如预览 iframe）的 CSP 不允许 blob: Worker，
// 直接 new Worker(blobURL) 会触发 onerror（message 为空、瞬间失败）。
// 因此优先加载同源真实文件 js/worker-*.js（CSP 'self' 放行），
// 文件加载再失败时，取源码文本回退为 blob Worker，仍失败则给出明确诊断。
function runInWorker(workerFile, payload, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let active = null; // { worker, dispose }
    let triedBlob = false;

    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (active) { try { active.worker.terminate(); } catch { /* noop */ } active.dispose(); }
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
          const src = await res.text();
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
      worker.postMessage(payload);
    };
    spawn(false);
  });
}

// 对外统一执行接口：返回 { ok, logs, result, error, timedOut, durationMs, files }
export async function runJavaScript(code, fsObj) {
  const t0 = performance.now();
  const files = fsObj.export();
  const out = await runInWorker('worker-js.js', { code, files }, SANDBOX_JS_TIMEOUT_MS);
  if (out.files && !out.timedOut) { fsObj.clear(); fsObj.import(out.files); }
  return { ...out, durationMs: Math.round(performance.now() - t0) };
}

export async function runPython(code, fsObj) {
  if (pyodideBroken) {
    return { ok: false, logs: [], error: { message: 'Pyodide 运行时不可用（CDN 加载失败），请改用 execute_javascript' }, durationMs: 0 };
  }
  const t0 = performance.now();
  const files = fsObj.export();
  const out = await runInWorker('worker-py.js', { code, files }, SANDBOX_PY_TIMEOUT_MS);
  if (!out.ok && /importScripts|loadPyodide|Failed to fetch|pyodide/i.test(String(out.error && out.error.message))) {
    pyodideBroken = true;
    out.error.message += '（已标记 Python 沙箱不可用，本次会话内请使用 execute_javascript）';
  }
  if (out.files && !out.timedOut) { fsObj.clear(); fsObj.import(out.files); }
  return { ...out, durationMs: Math.round(performance.now() - t0) };
}
