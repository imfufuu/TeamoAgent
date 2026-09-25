// PDF → 页图。新文件，避免给 pdf.js / ui.js 混版缓存加新导出。
// 按需加载 assets/pdfjs/（Mozilla pdf.js 3.11，主线程 + 同源 worker）。

const MAX_PAGES = 8;
const BASE_SCALE = 2.4;       // 提高栅格精度，方便 OCR / 读表
const JPEG_QUALITY = 0.92;
const MAX_EDGE = 4096;        // 单边像素上限，避免超大 Canvas 撑爆内存

function toU8(bytes) {
  if (!bytes) return new Uint8Array(0);
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(0);
}

let loading;
function loadPdfjs() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(null);
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (loading) return loading;
  const ver = (document.querySelector('meta[name="app-version"]') || {}).content || '';
  const q = ver ? `?v=${encodeURIComponent(ver)}` : '';
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `assets/pdfjs/pdf.min.js${q}`;
    s.async = true;
    s.onload = () => {
      const lib = window.pdfjsLib;
      if (!lib) { reject(new Error('pdf.js 未挂载')); return; }
      lib.GlobalWorkerOptions.workerSrc = `assets/pdfjs/pdf.worker.min.js${q}`;
      resolve(lib);
    };
    s.onerror = () => reject(new Error('无法加载 PDF 渲染库'));
    document.head.appendChild(s);
  });
  return loading;
}

function pageName(pdfName, i) {
  const n = String(pdfName || 'document.pdf').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'document.pdf';
  const stem = n.replace(/\.pdf$/i, '') || 'document';
  return `${stem}-p${String(i).padStart(2, '0')}.jpg`;
}

/**
 * 把 PDF 每一页画成 JPEG data URL，供 analyze_image 识别。
 * @returns {Promise<{ok:boolean, pages:number, images:{name:string, dataUrl:string, page:number}[], error?:string, truncated?:boolean}>}
 */
export async function pdfToImages(bytes, { maxPages = MAX_PAGES, name = 'document.pdf' } = {}) {
  const u8 = toU8(bytes);
  if (u8.length < 5 || u8[0] !== 0x25 || u8[1] !== 0x50 || u8[2] !== 0x44 || u8[3] !== 0x46) {
    return { ok: false, pages: 0, images: [], error: '不是 PDF 文件' };
  }
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return { ok: false, pages: 0, images: [], error: 'PDF 转图片需要浏览器 Canvas' };
  }
  let pdfjs;
  try { pdfjs = await loadPdfjs(); }
  catch (err) { return { ok: false, pages: 0, images: [], error: err.message || String(err) }; }
  if (!pdfjs) return { ok: false, pages: 0, images: [], error: 'PDF 渲染库不可用' };

  let doc;
  try {
    const data = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  } catch (err) {
    return { ok: false, pages: 0, images: [], error: `无法打开 PDF（可能加密或损坏）：${err.message || err}` };
  }
  const pages = doc.numPages || 0;
  const n = Math.min(pages, maxPages);
  const images = [];
  try {
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(window.devicePixelRatio, 2.5) : 1;
      let scale = BASE_SCALE * dpr;
      const edge = Math.max(base.width, base.height) * scale;
      if (edge > MAX_EDGE) scale *= MAX_EDGE / edge;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return { ok: false, pages, images, error: 'Canvas 不可用' };
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      images.push({ name: pageName(name, i), dataUrl, page: i });
    }
  } catch (err) {
    return { ok: false, pages, images, error: `渲染 PDF 第 ${images.length + 1} 页失败：${err.message || err}` };
  } finally {
    try { if (doc && doc.destroy) doc.destroy(); } catch { /* */ }
  }
  if (!images.length) return { ok: false, pages, images: [], error: '没有渲染出任何页' };
  return { ok: true, pages, images, truncated: pages > n };
}
