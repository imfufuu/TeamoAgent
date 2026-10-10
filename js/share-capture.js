import { text } from './locale.js';
export const MAX_CAPTURE_PIXELS = 12000000;
export const MAX_CAPTURE_HEIGHT = 15000;
export function capturePlan(width, height, deviceScale = 1) {
  const w = Math.ceil(width), h = Math.ceil(height);
  if (w < 1 || h < 1 || !Number.isFinite(w + h) || h > MAX_CAPTURE_HEIGHT * 32) throw new Error(text('超出安全画布尺寸，请减少选择或改用HTML；没有截断任何消息', 'Selection exceeds safe canvas limits. Select fewer messages or export HTML; no messages were truncated.'));
  const partHeight = Math.min(MAX_CAPTURE_HEIGHT, Math.floor(MAX_CAPTURE_PIXELS / w));
  if (partHeight < 1) throw new Error('Canvas width exceeds safe bounds');
  const scale = Math.max(1, Math.min(2, Number(deviceScale) || 1, Math.sqrt(MAX_CAPTURE_PIXELS / (w * Math.min(h, partHeight)))));
  return Array.from({ length: Math.ceil(h / partHeight) }, (_, i) => ({ y: i * partHeight, height: Math.min(partHeight, h - i * partHeight), width: w, scale }));
}
let library;
async function html2canvas() {
  if (window.html2canvas) return window.html2canvas;
  return library ||= new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = new URL('../assets/vendor/html2canvas.min.js', import.meta.url); script.onload = () => resolve(window.html2canvas); script.onerror = () => { library = null; reject(new Error(text('无法载入本地长图渲染器', 'Could not load the local image renderer'))); }; document.head.append(script);
  });
}
// html2canvas 1.4.1 does not parse color(srgb …). Normalize browser-computed colors, not application styles.
function normalizeCaptureColors(doc) {
  const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const legacy = (value) => String(value).replace(/(?:color|oklab|oklch|lab|lch)\([^)]*\)/g, (color) => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const p = ctx.getImageData(0, 0, 1, 1).data; return `rgba(${p[0]},${p[1]},${p[2]},${p[3] / 255})`;
  });
  const props = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color', 'box-shadow', 'background-image', 'fill', 'stroke'];
  for (const el of doc.querySelectorAll('*')) {
    const style = doc.defaultView.getComputedStyle(el);
    for (const prop of props) { const value = style.getPropertyValue(prop); if (/(?:color|oklab|oklch|lab|lch)\(/.test(value)) el.style.setProperty(prop, legacy(value), 'important'); }
    if (el instanceof doc.defaultView.SVGElement) for (const p of ['fill', 'stroke', 'stroke-width', 'font-family', 'font-size', 'font-weight', 'text-anchor']) el.style.setProperty(p, legacy(style.getPropertyValue(p)));
  }
}
export async function captureShare(html, { signal, onPart, onStage } = {}) {
  const bounded = (promise, ms = 30000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(text('长图渲染未能完成，请改用HTML或减少选择', 'Image rendering did not complete. Export HTML or select fewer messages.'))); }, ms);
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    Promise.resolve(promise).then((v) => { cleanup(); resolve(v); }, (err) => { cleanup(); reject(err); });
  });
  onStage?.('renderer');
  const render = await bounded(html2canvas());
  const frame = document.createElement('iframe'); frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;left:-12000px;top:0;width:760px;height:1000px;border:0;pointer-events:none';
  const loaded = new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = reject; });
  // The rasterizer clones into a nested same-origin about:blank iframe; this permission is capture-only. Exported HTML keeps its restrictive policy.
  frame.srcdoc = html.replace("default-src 'none';", "default-src 'none'; frame-src 'self';"); document.body.append(frame);
  try {
    onStage?.('frame');
    await bounded(loaded); if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const doc = frame.contentDocument; onStage?.('fonts'); await bounded(doc.fonts?.ready);
    for (const n of doc.querySelectorAll('.md-fold,.tool-call-chip')) n.classList.add('expanded');
    for (const n of doc.querySelectorAll('details')) n.open = true;
    const style = doc.createElement('style'); style.textContent = '*{animation:none!important;transition:none!important}.chip-detail{display:block!important;height:auto!important;max-height:none!important;opacity:1!important}.share-controls,.copy-code,.chip-copy,.md-chart-expand{display:none!important}.md-body table{overflow:visible;white-space:normal;display:table;width:100%;table-layout:fixed}.md-body td,.md-body th{white-space:normal;overflow-wrap:anywhere}.code-block pre,.chip-win-b{white-space:pre-wrap!important;overflow-wrap:anywhere!important;word-break:break-word!important}.ep-body{max-height:none!important;overflow:visible!important}'; doc.head.append(style);
    onStage?.('images');
    for (const image of doc.images) image.loading = 'eager';
    await bounded(Promise.all([...doc.images].map((img) => img.decode?.().catch(() => {}) || Promise.resolve())));
    const root = doc.querySelector('.share-page'); const height = Math.ceil(root.getBoundingClientRect().height);
    const plan = capturePlan(760, height, window.devicePixelRatio); const parts = [];
    for (const [i, part] of plan.entries()) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      onStage?.(`part-${i + 1}`);
      const canvas = await bounded(render(root, { ...part, x: 0, scrollX: 0, scrollY: 0, windowWidth: 760, windowHeight: 1000, backgroundColor: doc.defaultView.getComputedStyle(doc.body).backgroundColor, logging: false, useCORS: false, allowTaint: false, onclone: normalizeCaptureColors }));
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png')); canvas.width = canvas.height = 1;
      if (!blob) throw new Error(text('长图生成失败；请改用HTML', 'Image capture failed. Try HTML export.')); parts.push(blob); onPart?.(i + 1, plan.length);
    }
    return parts;
  } finally { frame.remove(); }
}
