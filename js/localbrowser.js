// Same-origin LOCAL companion only. Never selected through relay/Cloudflare.
import { isSafeFsPath, contentByteSize } from './sandbox.js';
export const LOCAL_BROWSER_LIMITS = Object.freeze({ files: 512, bytes: 8 * 1024 * 1024 });
let available = false;
let lastProbe = 0;
let pending = null;
export const localBrowserAvailable = () => available;
export function resetLocalBrowserProbe() { available = false; lastProbe = 0; pending = null; }
export async function probeLocalBrowser({ signal, force = false } = {}) {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol || '')) return false;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (pending) return pending;
  if (!force && lastProbe && Date.now() - lastProbe < 30000) return available;
  pending = (async () => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 9000);
    try {
      const response = await fetch('/api/sandbox-web/health', { signal: controller.signal, cache: 'no-store' });
      const info = response.ok && /application\/json\b/i.test(response.headers?.get('Content-Type') || '') ? await response.json() : {};
      available = info.ok === true && info.local === true && info.kind === 'sandbox-project-browser' && info.engine === 'chromium';
      return available;
    } catch (err) {
      available = false;
      if (signal?.aborted) throw err;
      return false;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      lastProbe = Date.now(); pending = null;
    }
  })();
  return pending;
}
export function sandboxProject(fs, entry, root) {
  const path = String(entry || '');
  if (!isSafeFsPath(path) || !/\.html?$/i.test(path)) throw new Error('entry 必须是沙箱内 HTML 文件路径，不接受网址');
  const base = root == null ? path.split('/').slice(0, -1).join('/') : String(root).replace(/\/$/, '');
  if (base && !isSafeFsPath(base)) throw new Error('root 必须是沙箱相对目录');
  const prefix = base ? base + '/' : '';
  if (!path.startsWith(prefix)) throw new Error('入口必须位于项目 root 内');
  const files = Object.create(null);
  let bytes = 0;
  for (const item of fs.list()) {
    const name = String(item.path || '');
    if (!name.startsWith(prefix)) continue;
    const relative = name.slice(prefix.length);
    if (!isSafeFsPath(relative) || relative.split('/').some((p) => p.startsWith('.')) || /^(internal|node_modules)\//.test(relative)) continue;
    const value = String(fs.read(name));
    bytes += contentByteSize(value);
    files[relative] = value;
    if (bytes > LOCAL_BROWSER_LIMITS.bytes || Object.keys(files).length > LOCAL_BROWSER_LIMITS.files) throw new Error('网页项目超过 8MB / 512 文件上限；请选择更小的 root');
  }
  const localEntry = path.slice(prefix.length);
  if (!Object.hasOwn(files, localEntry)) throw new Error('沙箱入口文件不存在');
  return { entry: localEntry, files };
}
export async function sandboxBrowserRequest(payload, { signal, onEvent } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('浏览器参数无效');
  const supported = new Set(['action', 'entry', 'files', 'preview_id', 'selector', 'text', 'expression', 'width', 'height', 'full_page', 'wait_ms']);
  if (Object.keys(payload).some((k) => !supported.has(k))) throw new Error('网页沙箱只接受项目参数，禁止公网 URL 或未知运行参数');
  if (Object.keys(payload).some((key) => ['url', 'host', 'port', 'base', 'command'].includes(key))) throw new Error('浏览器仅调试沙箱项目，不接受公网 URL 或 shell 命令');
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const response = await fetch(payload.action === 'start' ? '/api/sandbox-web/start' : '/api/sandbox-web/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || '需要本地 server.py 与 Playwright/Chromium；GitHub Pages 本身不能运行浏览器');
  }
  let result;
  const frame = (line) => {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    if (value.type === 'event') onEvent?.(value.payload || {});
    else if (value.type === 'result') result = value.result;
  };
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 16 * 1024 * 1024) throw new Error('浏览器返回数据超过限制');
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) { frame(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      }
      buffer += decoder.decode(); if (buffer.trim()) frame(buffer);
    } finally { reader.releaseLock(); }
  } else (await response.text()).split('\n').forEach(frame);
  if (!result) throw new Error('本地浏览器连接结束，但没有返回完成帧');
  if (!result.ok) throw new Error(result.error || '本地浏览器操作失败');
  if (result.image && !/^data:image\/png;base64,iVBORw0KGgo/.test(result.image)) throw new Error('本地截图不是 PNG');
  return result;
}
