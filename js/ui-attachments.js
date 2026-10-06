// Dubhe Agent · 附件（从 ui.js 的 mountUI 拆出，V1.7.1）
// 按钮 / 相机 / 拖拽 / 粘贴 四个入口 → 统一 addFiles：图片缩放与 MIME 白名单、文本 / PDF（原样入沙箱，交给 analyze_pdf）/ ZIP（解包进沙箱）、
// 大小上限与芯片渲染。对外只暴露 { hasPending, takePending, addFiles }，发送逻辑取走后自动清空。
import { ICON } from './icons.js';
import { openPhotoEditor } from './photo-editor.js?v=2026.10.5.20';
import { relayDownload, relaySupports, relayAvailable, RELAY_FILE_MAX_BYTES } from './net.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

export function installAttachments({ composer, toast, safeImgSrc, fmtSize }) {
  // ── 附件（按钮 / 拖拽 / 粘贴）────────────────────────────────────────
  // 图片 MIME 白名单：覆盖主流浏览器可直接显示的全部光栅/矢量格式（PNG/JPEG/GIF/WEBP/BMP/ICO/TIFF/AVIF/APNG/HEIC/HEIF/SVG）
  // DeepSeek 视觉接口只接受 JPEG/PNG/GIF/WEBP；其它格式发图前在 analyze_image 里统一转成 PNG/JPEG。
  const IMG_RE = /^image\/(png|jpe?g|gif|webp|bmp|ico|tiff?|avif|apng|heic|heif|svg\+xml)$/i;
  const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|avif|apng|heic|heif|svg)$/i;
  const TEXT_RE = /\.(txt|md|markdown|js|mjs|cjs|ts|tsx|jsx|py|pyi|java|c|cc|cpp|cxx|h|hpp|cs|go|rs|rb|php|swift|kt|scala|dart|m|r|jl|sh|bash|zsh|ps1|bat|cmd|json|jsonc|jsonl|csv|tsv|log|html?|css|scss|less|xml|ya?ml|toml|ini|env|conf|cfg|sql|vue|svelte|tex|latex|lua|hs|erl|exs?|clj|cljs|fsx?|ml|mli|asm|diff|patch)$/i;
  const PDF_RE = /\.pdf$/i;
  const ZIP_RE = /\.zip$/i;
  // 视频：原样进沙箱 uploads/，由 Agent 调用 analyze_video（Gemini 视频理解）；16MB ≈ 手机 1080p 30–60 秒
  const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;
  const VIDEO_MIME_RE = /^video\/(mp4|webm|quicktime|x-m4v)$/i;
  const MAX_IMG = 5 * 1024 * 1024, MAX_TEXT = 512 * 1024, MAX_PDF = 12 * 1024 * 1024, MAX_ZIP = 12 * 1024 * 1024, MAX_VIDEO = 16 * 1024 * 1024, MAX_FILES = 8;
  let pending = [];
  const attachChips = $('#attach-chips');
  const fileInput = $('#attach-input');
  const cameraInput = $('#camera-input');

  // 视频抽帧：海报图（首帧缩略图，气泡 / 芯片用）+ 均匀抽 VIDEO_FRAMES 帧（本地审核用，与图片同一条 NudeNet + NSFWJS 流水线）。
  // 只在浏览器解码能力内（H.264 / VP8 / VP9 / AV1）；解不出来的（HEVC .mov 等）直接拒收——审不到就不进沙箱。
  const VIDEO_FRAMES = 5;
  const FRAME_MAX_SIDE = 480;
  const captureVideoFrames = (file, { frames = VIDEO_FRAMES, timeoutMs = 20000 } = {}) => new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return reject(new Error('当前环境不支持视频解码'));
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* noop */ } try { URL.revokeObjectURL(url); } catch { /* noop */ } fn(arg); };
    const timer = setTimeout(() => finish(reject, new Error('视频解码超时（20 秒）')), timeoutMs);
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const canvas = document.createElement('canvas');
    const grab = () => {
      const w = v.videoWidth || 0, h = v.videoHeight || 0;
      if (!w || !h) throw new Error('视频没有画面轨');
      const r = Math.min(1, FRAME_MAX_SIDE / Math.max(w, h));
      canvas.width = Math.max(1, Math.round(w * r)); canvas.height = Math.max(1, Math.round(h * r));
      canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.78);
    };
    const seekTo = (t) => new Promise((res, rej) => {
      const onSeeked = () => { v.removeEventListener('seeked', onSeeked); v.removeEventListener('error', onErr); res(); };
      const onErr = () => { v.removeEventListener('seeked', onSeeked); v.removeEventListener('error', onErr); rej(new Error('seek 失败')); };
      v.addEventListener('seeked', onSeeked); v.addEventListener('error', onErr);
      v.currentTime = Math.max(0, t);
    });
    v.onerror = () => finish(reject, new Error('浏览器无法解码该视频（可能是 HEVC / 不支持的容器），请转成 H.264 MP4 再传'));
    v.onloadedmetadata = async () => {
      try {
        let d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
        // 等到能画第一帧
        if (v.readyState < 2) await new Promise((res) => { v.addEventListener('loadeddata', res, { once: true }); });
        // 流式 WebM（MediaRecorder / 屏幕录制产物）头里没写时长，duration 为 Infinity：
        // 先 seek 到一个极大值逼浏览器扫到文件尾，durationchange 后才能拿到真实时长并均匀抽帧。
        if (!d) {
          d = await new Promise((res) => {
            const t = setTimeout(() => res(0), 4000);
            const on = () => {
              if (Number.isFinite(v.duration) && v.duration > 0) { clearTimeout(t); v.removeEventListener('durationchange', on); res(v.duration); }
            };
            v.addEventListener('durationchange', on);
            try { v.currentTime = 1e9; } catch { clearTimeout(t); v.removeEventListener('durationchange', on); res(0); }
          });
        }
        const out = [];
        // 海报：0.3 秒处（避开纯黑首帧），短视频取 10%
        await seekTo(Math.min(0.3, d * 0.1));
        const poster = grab();
        // 均匀抽帧：(i+0.5)/n · duration
        const n = Math.max(1, frames);
        for (let i = 0; i < n; i++) {
          const t = d ? ((i + 0.5) / n) * d : 0;
          await seekTo(t);
          out.push(grab());
          if (!d) break;
        }
        finish(resolve, { poster, frames: out, durationSec: d, width: v.videoWidth, height: v.videoHeight });
      } catch (err) { finish(reject, err); }
    };
    v.src = url;
  });

  const readAs = (mode, file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    mode === 'text' ? r.readAsText(file) : r.readAsDataURL(file);
  });

  // 等比缩放图片：最长边不超过 maxLongEdge 像素，输出 JPEG（或原格式为 PNG 时 PNG）。
  // 用于用户上传的大图（>5MB）自动压缩到合理体积，避免消耗上下文 token / 撑爆 IndexedDB。
  // SVG（矢量）不缩放——它是文本，尺寸无意义。
  async function downscaleImage(file, maxLongEdge = 2048, quality = 0.85) {
    const isSvg = /svg/i.test(file.type) || /\.svg$/i.test(file.name);
    if (isSvg) return { dataUrl: await readAs('dataURL', file), mime: 'image/svg+xml', scaled: false };
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) {
      // 兜底：浏览器不能解码就退回原文件
      return { dataUrl: await readAs('dataURL', file), mime: file.type || 'image/png', scaled: false };
    }
    const origW = bitmap.width, origH = bitmap.height;
    let { width, height } = bitmap;
    const long = Math.max(width, height);
    if (long <= maxLongEdge) {
      bitmap.close?.();
      return { dataUrl: await readAs('dataURL', file), mime: file.type || 'image/png', scaled: false };
    }
    const scale = maxLongEdge / long;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    // 原图是 PNG 且有透明通道 → PNG；其它一律 JPEG
    const outMime = (file.type === 'image/png' || /\.png$/i.test(file.name)) ? 'image/png' : 'image/jpeg';
    const dataUrl = canvas.toDataURL(outMime, quality);
    return { dataUrl, mime: outMime, scaled: true, origW, origH, newW: width, newH: height };
  }

  async function addFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    for (const f of files) {
      if (pending.length >= MAX_FILES) { toast(`单次最多 ${MAX_FILES} 个附件`, 'warn'); break; }
      try {
        const isImageByMime = IMG_RE.test(f.type);
        const isImageByExt = IMG_EXT_RE.test(f.name);
        if (isImageByMime || isImageByExt) {
          if (globalThis.__dubhePrewarmImageModeration) globalThis.__dubhePrewarmImageModeration('attachment');
          let dataUrl, finalMime, originalSize = f.size, didScale = false;
          if (f.size > MAX_IMG) {
            // 自动等比缩放到最长边 2048px 再上传
            try {
              const r = await downscaleImage(f, 2048, 0.85);
              dataUrl = r.dataUrl; finalMime = r.mime; didScale = r.scaled;
              if (didScale) toast(`${f.name}：已从 ${fmtSize(originalSize)} 等比缩放到 ${r.newW}×${r.newH}`, 'ok', 2400);
            } catch (err) {
              toast(`${f.name}：图片缩放失败（${err.message}），已跳过`, 'err'); continue;
            }
          } else {
            dataUrl = await readAs('dataURL', f);
          }
          // 浏览器 FileReader 对某些扩展名/未知 MIME 会给 application/octet-stream 或空 MIME，
          // 这里按扩展名兜底修正 data: URL 的 MIME 头，保证后续预览/识图正确识别。
          if (dataUrl && !didScale) {
            const extMatch = /\.([a-z0-9]+)$/i.exec(f.name);
            const ext = extMatch ? extMatch[1].toLowerCase() : '';
            const extToMime = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', bmp:'image/bmp', ico:'image/x-icon', tif:'image/tiff', tiff:'image/tiff', avif:'image/avif', apng:'image/apng', heic:'image/heic', heif:'image/heif', svg:'image/svg+xml' };
            const wantMime = (f.type && IMG_RE.test(f.type)) ? f.type : (extToMime[ext] || f.type || 'image/png');
            dataUrl = dataUrl.replace(/^data:[^;]*;base64,/, `data:${wantMime};base64,`);
            finalMime = wantMime;
          }
          finalMime = finalMime || (dataUrl.match(/^data:([^;]+);base64,/) || [])[1] || f.type || 'image/png';
          // 估算缩放后的字节数（base64 → binary ≈ * 0.75）
          const comma = dataUrl.indexOf(',');
          const finalSize = comma > 0 && /;base64/i.test(dataUrl.slice(0, comma))
            ? Math.round((dataUrl.length - comma - 1) * 0.75)
            : originalSize;
          pending.push({ id: Math.random().toString(36).slice(2), kind: 'image', name: f.name, mime: finalMime, size: finalSize, dataUrl, scaled: didScale ? true : undefined });
        } else if (PDF_RE.test(f.name) || f.type === 'application/pdf') {
          if (f.size > MAX_PDF) { toast(`${f.name}：PDF 超过 12MB`, 'err'); continue; }
          // PDF 原样进沙箱 uploads/，由 Agent 调用 analyze_pdf（文本层 + 整批页图识图）；不再在发送前逐页转图
          const dataUrl = await readAs('dataURL', f);
          let pages = 0;
          try {
            const head = atob(String(dataUrl).slice(String(dataUrl).indexOf(',') + 1, String(dataUrl).indexOf(',') + 1 + 4 * 1024 * 256));
            pages = (head.match(/\/Type\s*\/Page(?![sA-Z])/g) || []).length;
          } catch { pages = 0; }
          pending.push({
            id: Math.random().toString(36).slice(2),
            kind: 'file',
            name: f.name,
            mime: 'application/pdf',
            size: f.size,
            dataUrl: String(dataUrl).replace(/^data:[^;]*;base64,/, 'data:application/pdf;base64,'),
            source: 'pdf',
            pages: pages || undefined,
            originalName: f.name,
          });
          toast(`${f.name}：已作为 PDF 附件加入${pages ? `（约 ${pages} 页）` : ''}，发送后 Agent 会调用 analyze_pdf 识别`, 'ok', 4200);
        } else if (VIDEO_RE.test(f.name) || VIDEO_MIME_RE.test(f.type)) {
          if (f.size > MAX_VIDEO) { toast(`${f.name}：视频超过 16MB，请裁剪或压缩后再传`, 'err'); continue; }
          const ext = (f.name.toLowerCase().split('.').pop() || 'mp4');
          const mime = VIDEO_MIME_RE.test(f.type) ? f.type : (ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : ext === 'm4v' ? 'video/x-m4v' : 'video/mp4');
          let cap;
          try { cap = await captureVideoFrames(f); } catch (err) { toast(`${f.name}：${err.message}（无法抽帧审核，未加入）`, 'err', 5200); continue; }
          const durationSec = cap.durationSec || 0;
          pending.push({
            id: Math.random().toString(36).slice(2),
            kind: 'file',
            name: f.name,
            mime,
            size: f.size,
            dataUrl: String(await readAs('dataURL', f)).replace(/^data:[^;]*;base64,/, `data:${mime};base64,`),
            source: 'video',
            durationSec: durationSec || undefined,
            width: cap.width || undefined,
            height: cap.height || undefined,
            poster: cap.poster,   // 首帧缩略图：芯片 / 气泡显示
            frames: cap.frames,   // 均匀 5 帧：仅供本地审核，agent.send 会在入消息前摘掉
            originalName: f.name,
          });
          toast(`${f.name}：已作为视频附件加入（${durationSec ? `约 ${Math.round(durationSec)} 秒，` : ''}已抽 ${cap.frames.length} 帧待审核），发送后 Agent 会调用 analyze_video 识别`, 'ok', 4200);
        } else if (ZIP_RE.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') {
          if (f.size > MAX_ZIP) { toast(`${f.name}：ZIP 超过 12MB`, 'err'); continue; }
          pending.push({
            id: Math.random().toString(36).slice(2),
            kind: 'file',
            name: f.name,
            mime: f.type || 'application/zip',
            size: f.size,
            dataUrl: await readAs('dataURL', f),
            source: 'zip',
            originalName: f.name,
          });
          toast(`${f.name}：已添加 ZIP，发送并通过审核后写入 uploads/，请用 unzip_file 解压`, 'ok', 4200);
        } else if (TEXT_RE.test(f.name) || f.type.startsWith('text/') || f.type === 'application/json') {
          if (f.size > MAX_TEXT) { toast(`${f.name}：文本超过 512KB`, 'err'); continue; }
          pending.push({ id: Math.random().toString(36).slice(2), kind: 'text', name: f.name, mime: f.type || 'text/plain', size: f.size, text: await readAs('text', f) });
        } else {
          toast(`不支持的文件类型：${f.name}（支持图片、视频 mp4/webm/mov、PDF、ZIP 与文本/代码文件）`, 'err');
        }
      } catch (err) { toast(err.message, 'err'); }
    }
    renderAttachChips();
  }

  function renderAttachChips() {
    attachChips.innerHTML = '';
    attachChips.style.display = pending.length ? '' : 'none';
    for (const a of pending) {
      const chip = el('div', 'attach-chip enter');
      const imgSrc = a.kind === 'image' ? safeImgSrc(a.dataUrl) : (a.source === 'video' && a.poster ? safeImgSrc(a.poster) : '');
      chip.innerHTML = (imgSrc
        ? `<span class="attach-chip-thumb${a.source === 'video' ? ' is-video' : ''}"><img src="${esc(imgSrc)}" alt=""></span>`
        : `<span class="attach-chip-ico">${a.source === 'video' ? '🎬' : '📄'}</span>`)
        + `<span class="attach-chip-name mono">${esc(a.originalName || a.name)}</span><span class="attach-chip-size">${fmtSize(a.size)}</span><button class="attach-chip-x" type="button" aria-label="移除附件">${ICON.x}</button>`;
      $('.attach-chip-x', chip).addEventListener('click', () => {
        pending = pending.filter((x) => x.id !== a.id);
        renderAttachChips();
      });
      attachChips.appendChild(chip);
    }
  }

  const attachWrap = $('#attach-menu-wrap');
  const attachMenu = $('#attach-menu');
  const attachButton = $('#attach-btn');
  function setAttachMenuOpen(open) {
    if (!attachMenu || !attachButton) return;
    attachMenu.hidden = !open;
    attachButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  attachButton?.addEventListener('click', () => setAttachMenuOpen(attachMenu?.hidden));
  $('#attach-file-action')?.addEventListener('click', () => {
    setAttachMenuOpen(false);
    fileInput.click();
  });
  attachWrap?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setAttachMenuOpen(false);
      attachButton?.focus();
    } else if (event.key === 'ArrowDown' && attachMenu?.hidden) {
      event.preventDefault();
      setAttachMenuOpen(true);
      attachMenu.querySelector('button')?.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (attachWrap && !attachWrap.contains(event.target)) setAttachMenuOpen(false);
  });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  const cameraBtn = $('#camera-btn');
  if (cameraBtn && cameraInput) {
    cameraBtn.addEventListener('click', () => {
      setAttachMenuOpen(false);
      cameraInput.click();
    });
    cameraInput.addEventListener('change', async () => {
      const photo = cameraInput.files && cameraInput.files[0];
      cameraInput.value = '';
      if (!photo) return;
      try {
        const edited = await openPhotoEditor(photo);
        if (edited) await addFiles([edited]); // camera output uses the existing attachment/upload pipeline
      } catch (error) { toast(`照片编辑器不可用：${error.message}`, 'err', 5000); }
    });
  }

  const mainEl = $('.main');
  ['dragenter', 'dragover'].forEach((ev) => mainEl.addEventListener(ev, (e) => { e.preventDefault(); mainEl.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach((ev) => mainEl.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget && mainEl.contains(e.relatedTarget)) return;
    mainEl.classList.remove('drag-over');
  }));
  mainEl.addEventListener('drop', (e) => addFiles(e.dataTransfer && e.dataTransfer.files));
  composer.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (files.length) { e.preventDefault(); addFiles(files); return; }
    // 粘贴的是一条指向文件的链接（图片 / 视频 / PDF / ZIP）：经中继跨域拉下来当附件，走同一条审核 / 缩略图流水线
    const text = String((e.clipboardData && e.clipboardData.getData('text')) || '').trim();
    if (looksLikeFileUrl(text) && composer.value.trim() === '') {
      e.preventDefault();
      addFromUrl(text).then((ok) => { if (!ok) insertAtCursor(composer, text); });
    }
  });

  // ── 链接附件：粘贴 / 「链接」菜单项 → relay /api/file → File → addFiles ──────────────
  const FILE_URL_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|svg|mp4|webm|mov|m4v|pdf|zip)(?:[?#].*)?$/i;
  function looksLikeFileUrl(t) {
    if (!/^https?:\/\/\S+$/i.test(t) || /\s/.test(t)) return false;
    try { return FILE_URL_EXT_RE.test(new URL(t).pathname + (new URL(t).search || '')); } catch { return false; }
  }
  function insertAtCursor(el, text) {
    const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  let urlBusy = false;
  async function addFromUrl(url) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) { toast('请输入以 http(s):// 开头的文件链接', 'err'); return false; }
    if (urlBusy) { toast('上一个链接还在拉取中…', 'info'); return false; }
    if (pending.length >= MAX_FILES) { toast(`最多 ${MAX_FILES} 个附件`, 'err'); return false; }
    urlBusy = true;
    const label = target.length > 60 ? `${target.slice(0, 57)}…` : target;
    try {
      await relayAvailable();
      if (!relaySupports('file')) {
        toast('当前中继不支持跨域拉取文件（需要新版 relay/worker.js，health 声明 file 能力）', 'err', 5200);
        return false;
      }
      toast(`正在经中继拉取 ${label}`, 'info', 2600);
      const r = await relayDownload({ url: target, maxBytes: RELAY_FILE_MAX_BYTES });
      if (!r.ok) { toast(`拉取失败：${r.error}`, 'err', 5200); return false; }
      const file = new File([r.bytes], r.name || 'download', { type: r.mime || 'application/octet-stream' });
      const before = pending.length;
      await addFiles([file]);
      return pending.length > before;
    } catch (err) {
      toast(`拉取失败：${err && err.message ? err.message : String(err)}`, 'err', 5200);
      return false;
    } finally { urlBusy = false; }
  }
  const linkBtn = $('#attach-link-action');
  if (linkBtn) {
    linkBtn.addEventListener('click', async () => {
      setAttachMenuOpen(false);
      const url = prompt('粘贴文件链接（图片 / 视频 / PDF / ZIP / 文本，≤ 16MB，经中继跨域拉取）：', '');
      if (url && url.trim()) await addFromUrl(url.trim());
    });
  }
  return {
    hasPending: () => pending.length > 0,
    takePending: () => { const atts = pending; pending = []; renderAttachChips(); return atts; },
    addFiles,
    addFromUrl,
    captureVideoFrames,
  };
}
