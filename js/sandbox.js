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

// ── Python：常驻 Worker（Pyodide 运行时只加载一次）─────────────────────
let pyWorker = null;
let pyBlobTried = false;

export async function runPython(code, fsObj, onProgress) {
  if (pyodideBroken) {
    return { ok: false, logs: [], error: { message: 'Pyodide 运行时不可用（CDN 加载失败），请改用 execute_javascript' }, durationMs: 0 };
  }
  const files = fsObj.export();
  const t0 = performance.now();

  const attempt = (useBlob) => new Promise((resolve) => {
    const spawn = async () => {
      if (useBlob) {
        const res = await fetch(new URL('worker-py.js', import.meta.url));
        if (!res.ok) throw new Error(`无法获取沙箱脚本（HTTP ${res.status}）`);
        const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
        return new Worker(url);
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
      worker.postMessage({ code, files });
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
  if (!out.ok && /importScripts|loadPyodide|Failed to fetch|pyodide|indexURL/i.test(String(out.error && out.error.message))) {
    pyodideBroken = true;
    pyWorker = null;
    out.error.message += '（已标记 Python 沙箱不可用，本次会话内请使用 execute_javascript）';
  }
  if (out.files && !out.timedOut) { fsObj.clear(); fsObj.import(out.files); }
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

export async function runCpp(code) {
  const t0 = performance.now();
  const dur = () => Math.round(performance.now() - t0);
  try {
    if (!cppCompilerDetected) { cppCompilerDetected = true; await detectCppCompiler(); }
    const res = await fetch(`${CE_BASE}/api/compiler/${cppCompilerId}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        source: code,
        options: {
          userArguments: '-O2 -std=c++20',
          executeParameters: { args: [], stdin: '' },
          compilerOptions: { executorRequest: true }, // 关键：executorRequest 才是「编译并执行」
          filters: { execute: true },
          tools: [],
        },
        lang: 'c++',
        allowStoreCodeDebug: true,
      }),
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
