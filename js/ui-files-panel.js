// Dubhe Agent · 侧栏沙箱文件面板（从 ui.js 的 mountUI 拆出，V1.7.1）
// 职责：文件树渲染（容量条 / 折叠目录 / 行内操作）、单文件与整包 ZIP 下载、文件预览窗。
// 只依赖 store.state.files 与少量渲染工具；通过 installFilesPanel(deps) 注入，返回 { renderFiles, openFileViewer, downloadFile }。
import { createZip, fileBytesFromValue, withExtension, mimeFromPath } from './zip.js';
import { buildFileTree, collectPaths, treeStats, flattenTree } from './filetree.js';
import { ICON } from './icons.js';
import { SANDBOX_STORAGE_CAP, sandboxQuotaLabel } from './storagefmt.js';
import { pdfToImages } from './pdfpages.js';
import { contentByteSize } from './sandbox.js?v=2026.10.7.2';

// data:video/… → blob URL（与 ui.js 气泡播放同一做法；独立实现以免 split 模块反向 import ui.js）
function videoBlobUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = /^data:([^;,]+);base64,/.exec(s);
  if (!m) return '';
  try {
    const bin = atob(s.slice(s.indexOf(',') + 1));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([u8], { type: m[1] }));
  } catch { return ''; }
}

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


// 空状态插画：一叠文件 + 一个被放进来的文件（线稿，currentColor，随深浅主题）
const FILES_EMPTY_ART = `<svg class="files-empty-art" viewBox="0 0 160 112" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs><linearGradient id="feg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".10"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
  <ellipse cx="80" cy="98" rx="52" ry="7" fill="url(#feg)"/>
  <g class="fe-stack" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
    <path d="M44 42h40l12 12v38a4 4 0 0 1-4 4H44a4 4 0 0 1-4-4V46a4 4 0 0 1 4-4Z" fill="var(--bg)"/>
    <path d="M84 42v12h12" stroke-opacity=".7"/>
    <path d="M52 68h32M52 78h24" stroke-opacity=".45" stroke-linecap="round"/>
  </g>
  <g class="fe-back" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" opacity=".55">
    <path d="M58 32h36l10 10v8" stroke-linecap="round"/>
    <path d="M54 36v-2a4 4 0 0 1 4-4" stroke-linecap="round"/>
  </g>
  <g class="fe-drop" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
    <path d="M106 18h18l7 7v18a3 3 0 0 1-3 3h-22a3 3 0 0 1-3-3V21a3 3 0 0 1 3-3Z" fill="var(--bg)"/>
    <path d="M124 18v7h7" stroke-opacity=".7"/>
    <path d="M117 29v10M113 35l4 4 4-4" stroke-opacity=".9"/>
  </g>
  <g class="fe-sparks" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".5">
    <path d="M30 30v6M27 33h6"/><path d="M134 62v4M132 64h4"/><circle cx="26" cy="70" r="1.4" fill="currentColor" stroke="none"/>
  </g>
</svg>`;

export function installFilesPanel({ store, agent, toast, fmtSize, highlightCode, sanitizeSvgRaw, safeImgSrc }) {
  // ── 沙箱下载：整包 ZIP / 单个文件（图片按原始二进制还原，可直接打开）──
  const stampName = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  function saveBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const zipName = (path, mime) => withExtension(path.split('/').pop() || 'file', mime && mime.startsWith('image/') ? mime : '');
  function downloadFile(path) {
    let raw;
    try { raw = agent.fs.read(path); } catch { return toast('文件已不存在', 'err'); }
    const { bytes, mime: detectedMime } = fileBytesFromValue(raw);
    // 优先用文件路径扩展名推断的 MIME，避免浏览器因 text/plain 把文件另存为 .txt
    const pathMime = mimeFromPath(path);
    const mime = (detectedMime && !detectedMime.startsWith('text/plain')) ? detectedMime : (pathMime || detectedMime || 'application/octet-stream');
    const name = withExtension(path.split('/').pop() || 'file', detectedMime && detectedMime.startsWith('image/') ? detectedMime : '');
    saveBlob(name, new Blob([bytes], { type: mime }));
    toast(`已下载 ${name}（${fmtSize(bytes.length)}）`, 'ok');
  }
  // 打包：整包（保留目录结构）或单个目录；entries.name 即沙箱内路径
  const zipEntriesOf = (paths) => paths.map((p) => {
    let raw = '';
    try { raw = agent.fs.read(p); } catch { /**/ }
    const { bytes, mime } = fileBytesFromValue(raw);
    return { name: withExtension(p, mime && mime.startsWith('image/') ? mime : ''), bytes };
  });
  let filesZippedOnce = false;
  function saveZip(entries, base) {
    if (!entries.length) return toast('没有可打包的文件', 'warn');
    const blob = createZip(entries);
    saveBlob(`${base}-${stampName()}.zip`, blob);
    filesZippedOnce = true;
    toast(`已打包 ${entries.length} 个文件（${fmtSize(blob.size)}）`, 'ok');
  }
  $('#download-zip').addEventListener('click', () => {
    const wsKeys = (typeof agent.fs.listWorkspace === 'function' ? agent.fs.listWorkspace() : agent.fs.list()).map((f) => f.path);
    saveZip(zipEntriesOf(wsKeys), 'dubhe-workspace');
  });
  $('#clear-files').addEventListener('click', () => {
    const wsKeys = (typeof agent.fs.listWorkspace === 'function' ? agent.fs.listWorkspace() : agent.fs.list()).map((f) => f.path);
    const n = wsKeys.length;
    if (!n) return toast('工作区没有文件（内部缓存/OCR 会自动长期保留）');
    if (!filesZippedOnce) {
      if (!confirm('尚未打包 ZIP。清空后工作区文件无法恢复，仍要清空？（内部缓存/OCR 等不受影响）')) return;
    } else if (!confirm('清空工作区里的全部文件？内部缓存/OCR 会保留。此操作不可恢复。')) return;
    if (!confirm('再次确认：确定清空工作区文件？')) return;
    if (typeof agent.fs.clearWorkspace === 'function') {
      agent.fs.clearWorkspace();
    } else {
      agent.fs.clear();
    }
    store.clearFiles(); renderFiles(); toast('工作区已清空（内部文件保留）');
  });

  // 目录折叠状态：本次页面会话内记住（沙箱是路径即结构，没有真实目录节点）
  const collapsedDirs = new Set();
  // 图片以 data URL 存放，字符串长度会虚高 ~1/3；按 base64 反推真实字节
  const approxBytes = (raw) => contentByteSize(raw);

  const storageQuota = SANDBOX_STORAGE_CAP; // 产品上限 120MB，不用 navigator.storage 那种 39321.6MB
  const zipEstimateBytes = (files) => {
    // zip.js 使用 STORE（不压缩内容），这里估算「打包后容器大小」：数据字节 + 本地头/中心目录/EOCD。
    // 这样不必每次刷新文件树都真正 createZip / 解码所有大图。
    const enc = new TextEncoder();
    let n = 22;
    for (const f of files || []) {
      const nameLen = enc.encode(String(f.path || '').replace(/^\/+/, '').replace(/\\/g, '/')).length;
      n += Number(f.size || 0) + 30 + nameLen + 46 + nameLen;
    }
    return n;
  };

  let lastSig = null;
  function renderFiles() {
    const box = $('#file-list'); box.innerHTML = '';
    const allList = agent.fs.list();
    const allFiles = allList.map((f) => {
      let raw = '';
      try { raw = agent.fs.read(f.path); } catch { /**/ }
      const str = String(raw);
      const isSvg = /\.svg$/i.test(f.path) || (/^data:image\/svg/i.test(str)) || (/<svg[\s>]/i.test(str.slice(0, 2000)));
      return { path: f.path, size: approxBytes(raw), isImage: /^data:image\//.test(str), isSvg, isVideo: /^data:video\//.test(str) || /\.(mp4|webm|mov|m4v)$/i.test(f.path) };
    });
    // 与上一次渲染比对：新建 / 内容变化的文件行短暂高亮（首次渲染与会话切换不高亮）
    const sigNow = new Map(allFiles.map((f) => [f.path, f.size]));
    const changed = new Set();
    if (lastSig && lastSig.sid === store.state.activeSessionId) {
      for (const [path, size] of sigNow) if (lastSig.map.get(path) !== size) changed.add(path);
    }
    lastSig = { sid: store.state.activeSessionId, map: sigNow };
    const isInternal = (p) => typeof agent.fs.isInternalPath === 'function' && agent.fs.isInternalPath(p);
    const wsFiles = allFiles.filter((f) => !isInternal(f.path));
    const intFiles = allFiles.filter((f) => isInternal(f.path));
    const tree = buildFileTree(wsFiles);
    const stat = treeStats(tree);
    const quotaEl = $('#files-count');
    if (quotaEl) {
      const wsSize = stat.size;
      const intSize = intFiles.reduce((a, f) => a + (Number(f.size) || 0), 0);
      quotaEl.textContent = sandboxQuotaLabel(wsSize + intSize, storageQuota);
      quotaEl.title = `工作区 ${fmtSize(wsSize)} + 内部 ${fmtSize(intSize)} · 上限 120MB`;
    }
    const nEl = $('#files-n');
    if (nEl) {
      const n = Number(stat.files) || 0;
      const ni = intFiles.length;
      nEl.textContent = ni ? `${n} 个文件 · 内部 ${ni}` : `${n} 个文件`;
      nEl.title = ni ? `工作区显示 ${n} 个用户可见文件，另有 ${ni} 个内部长期文件（OCR/缓存等，不可见）` : '';
    }
    const zipEl = $('#files-zip');
    if (zipEl) {
      const z = zipEstimateBytes(wsFiles);
      zipEl.textContent = `ZIP ≈ ${fmtSize(z)}`;
      zipEl.title = `工作区文件打包后估算体积：${fmtSize(z)}（内部文件不打包）`;
    }
    if (!tree.length) {
      // 空状态：一句说明 + 轻量线稿插画（内联 SVG，跟随主题色；暂无文件时整块居中）
      const empty = el('div', 'files-empty');
      empty.setAttribute('aria-label', '暂无文件');
      empty.innerHTML = `${FILES_EMPTY_ART}<p class="files-empty-text">在此会话中创建或上传的所有文件都将保存在这里</p><p class="files-empty-sub">拖入 / 粘贴附件，或让 Agent 在沙箱里生成</p>`;
      box.appendChild(empty);
      return;
    }
    const imageSet = new Set(wsFiles.filter((f) => f.isImage).map((f) => f.path));
    const videoSet = new Set(wsFiles.filter((f) => f.isVideo).map((f) => f.path));
    const rows = flattenTree(tree, { isCollapsed: (p) => collapsedDirs.has(p) });
    for (const r of rows) {
      const closed = r.type === 'dir' && collapsedDirs.has(r.path);
      const row = el('div', `ft-row ft-${r.type}${r.type === 'dir' ? (closed ? ' closed' : ' open') : ' file-item'}`);
      row.style.setProperty('--d', r.depth);
      row.dataset.path = r.path;
      if (r.type !== 'dir' && changed.has(r.path)) row.classList.add('just-changed');
      row.title = r.type === 'dir' ? `${r.path}/（点击${collapsedDirs.has(r.path) ? '展开' : '折叠'}，共 ${r.count} 个文件）` : r.path;
      if (r.type === 'dir') {
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.setAttribute('aria-expanded', String(!closed));
        row.innerHTML = `<span class="ft-chev">${ICON.chevRight}</span>`
          + `<span class="ft-ico">${closed ? ICON.folder : ICON.folderOpen}</span>`
          + `<span class="ft-name">${esc(r.name)}</span>`
          + `<span class="ft-meta">${Number(r.count) || 0} 个文件 · ${fmtSize(Number(r.size) || 0)}</span>`
          + `<span class="ft-actions"><button class="files-icon-btn ft-copy" type="button" title="复制文件名">${ICON.copy}</button><button class="files-icon-btn ft-zip" type="button" title="打包 ${esc(r.path)}/">${ICON.download}</button></span>`;
        const toggle = () => {
          if (collapsedDirs.has(r.path)) collapsedDirs.delete(r.path); else collapsedDirs.add(r.path);
          renderFiles();
        };
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        $('.ft-copy', row).addEventListener('click', (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(r.name).then(() => toast('已复制文件名', 'ok', 1200), () => toast('复制失败：浏览器拒绝了剪贴板权限', 'err'));
        });
        $('.ft-zip', row).addEventListener('click', (e) => {
          e.stopPropagation();
          saveZip(zipEntriesOf(collectPaths(r)), `dubhe-${r.name || 'folder'}`);
        });
      } else {
        const fr = wsFiles.find((ff) => ff.path === r.path);
        const isSvgFile = !!(fr && fr.isSvg);
        row.innerHTML = `<span class="ft-sp"></span>`
          + `<span class="ft-ico">${videoSet.has(r.path) ? (ICON.video || '🎬') : (imageSet.has(r.path) || isSvgFile ? ICON.image : ICON.file)}</span>`
          + `<span class="ft-name file-path">${esc(r.name)}</span>`
          + `<span class="ft-actions"><button class="files-icon-btn ft-copy" type="button" title="复制文件名">${ICON.copy}</button><button class="files-icon-btn file-dl" type="button" title="下载此文件">${ICON.download}</button></span>`;
        $('.ft-copy', row).addEventListener('click', (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(r.name).then(() => toast('已复制文件名', 'ok', 1200), () => toast('复制失败：浏览器拒绝了剪贴板权限', 'err'));
        });
        $('.file-dl', row).addEventListener('click', (e) => { e.stopPropagation(); downloadFile(r.path); });
        row.addEventListener('click', () => openFileViewer(r.path));
      }
      box.appendChild(row);
    }
  }

  const FV_TEXT_MAX = 1 * 1024 * 1024; // 沙箱预览：文本类文件上限 1MB（超出请下载后在本地编辑器查看）
  function openFileViewer(path) {
    const viewer = $('#file-viewer');
    let raw = '';
    try { raw = agent.fs.read(path); } catch { return toast('文件已不存在', 'err'); }
    const rawStr = String(raw);
    const byteLen = approxBytes(rawStr);
    const lower = path.toLowerCase();
    const imgSrc = /^data:image\//.test(rawStr) ? safeImgSrc(rawStr) : '';
    // SVG 文件：如果内容是 SVG XML（不管有没有 data: 头），渲染为内联 SVG
    let svgContent = '';
    if (!imgSrc) {
      if (/\.svg$/i.test(lower) || /<svg[\s>]/i.test(rawStr.slice(0, 2000))) {
        svgContent = sanitizeSvgRaw(rawStr);
      }
    }
    // 代码/文本文件扩展名白名单
    const isCode = /\.(js|mjs|cjs|ts|jsx|tsx|py|java|c|cpp|h|hpp|cc|cxx|cs|go|rs|rb|php|swift|kt|scala|dart|m|matlab|sh|bash|zsh|ps1|bat|cmd|sql|json|jsonc|yml|yaml|toml|ini|conf|xml|html|htm|css|scss|less|md|markdown|r|jl|pyi|vue|svelte|tex|latex|lua|hs|erl|ex|exs|clj|cljs|fs|fsx|ml|mli|asm|s|vhd|v|sv|cu|sol|graphql|gql|hbs|jinja|j2|dockerfile|mk|nginx|diff|patch|log|csv|tsv|txt|text)$/i.test(lower);
    const isTextual = isCode || /^text\//.test(lower);
    let bodyHtml = '';
    // 视频（uploads/*.mp4 等 data:video/…）：转 blob URL 交给 <video controls>（CSP media-src 放行 blob:）
    const videoUrl = /^data:video\//i.test(rawStr) ? videoBlobUrl(rawStr) : '';
    if (videoUrl) {
      bodyHtml = `<div class="fv-video"><video controls playsinline preload="metadata" src="${esc(videoUrl)}" title="${esc(path)}"></video><div class="fv-video-meta mono">${esc(path.split('/').pop())} · ${fmtSize(byteLen)}</div></div>`;
    } else if (imgSrc) {
      bodyHtml = `<div class="fv-img"><img src="${esc(imgSrc)}" alt="${esc(path)}"></div>`;
    } else if (svgContent) {
      bodyHtml = `<div class="fv-svg">${svgContent}</div>`;
    } else if (isTextual) {
      if (byteLen > FV_TEXT_MAX) {
        // 超过 1MB：不直接渲染（hljs 处理超大文本会卡主线程），只显示提示 + 下载按钮
        bodyHtml = `<div class="fv-too-big">
          <div class="fv-too-big-ico">⚠️</div>
          <div class="fv-too-big-text">
            <div>此文本文件大小为 <strong>${fmtSize(byteLen)}</strong>，超过预览上限 1MB。</div>
            <div class="fv-too-big-sub">为避免界面卡顿，已禁用内联预览，请点击下方按钮下载后用本地编辑器查看。</div>
          </div>
        </div>`;
      } else {
        const lang = (lower.split('.').pop() || 'text');
        bodyHtml = isCode
          ? `<div class="fv-code"><pre><code class="hljs">${highlightCode(rawStr, lang, esc)}</code></pre></div>`
          : `<div class="fv-code"><pre>${esc(rawStr)}</pre></div>`;
      }
    } else if (/\.pdf$/i.test(lower) || /^data:application\/pdf/i.test(rawStr)) {
      // PDF：用 pdf.js 把前几页画成图预览（不走 iframe，避免放宽 CSP frame-src）
      bodyHtml = `<div class="fv-pdf" data-path="${esc(path)}"><div class="fv-pdf-loading">正在渲染 PDF 预览…</div></div>`;
    } else {
      bodyHtml = `<div class="fv-too-big">
        <div class="fv-too-big-ico">📦</div>
        <div class="fv-too-big-text">
          <div>二进制文件 · <strong>${fmtSize(byteLen)}</strong></div>
          <div class="fv-too-big-sub">该文件无法在浏览器内预览，请下载后用对应程序打开。</div>
        </div>
      </div>`;
    }
    stopViewerMedia();
    viewer.innerHTML = `<div class="file-viewer-head mono">${esc(path)}<span class="fv-size">${fmtSize(byteLen)}</span><span class="fv-actions">`
      + `<button id="fv-dl" type="button" title="下载此文件">${ICON.download}<span>下载</span></button>`
      + `<button id="fv-close" type="button" title="关闭">${ICON.x}</button></span></div>`
      + bodyHtml;
    viewer.classList.add('open');
    if (videoUrl) {
      // 关闭 / 切换文件时释放 blob，避免反复打开把内存吃满
      const vid = $('.fv-video video', viewer);
      const release = () => { try { URL.revokeObjectURL(videoUrl); } catch { /* noop */ } };
      const mo = new MutationObserver(() => { if (!vid || !vid.isConnected || !viewer.classList.contains('open')) { release(); mo.disconnect(); } });
      mo.observe(viewer, { childList: true, attributes: true, attributeFilter: ['class'] });
    }
    $('#fv-close').addEventListener('click', () => closeViewer());
    $('#fv-dl').addEventListener('click', () => downloadFile(path));
    const pdfBox = $('.fv-pdf', viewer);
    if (pdfBox) renderPdfPreview(pdfBox, rawStr, path);
  }

  // 关闭查看器：只摘 .open 类的话 <video> 还挂在 DOM 里继续出声（.26 前的 bug：点 ✕ 后音频照放）。
  // 先把所有媒体元素停掉并卸载源，再收起；下一次 openFileViewer 会整体重建 innerHTML。
  function stopViewerMedia() {
    const viewer = $('#file-viewer');
    if (!viewer) return;
    for (const m of viewer.querySelectorAll('video, audio')) {
      try { m.pause(); } catch { /* noop */ }
      try { m.removeAttribute('src'); m.load(); } catch { /* noop */ }
    }
  }
  function closeViewer() {
    stopViewerMedia();
    const viewer = $('#file-viewer');
    if (viewer) viewer.classList.remove('open');
  }

  const FV_PDF_PAGES = 6;
  async function renderPdfPreview(box, rawStr, path) {
    let bytes;
    try {
      const comma = rawStr.indexOf(',');
      const b64 = /^data:/i.test(rawStr) && comma > 0 ? rawStr.slice(comma + 1) : '';
      if (!b64) throw new Error('不是 base64 PDF');
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (err) {
      box.innerHTML = `<div class="fv-too-big"><div class="fv-too-big-ico">📄</div><div class="fv-too-big-text"><div>无法预览此 PDF</div><div class="fv-too-big-sub">${esc(err.message || String(err))}，请下载后查看。</div></div></div>`;
      return;
    }
    let got;
    try {
      got = await pdfToImages(bytes, { name: path.split('/').pop(), maxPages: FV_PDF_PAGES, baseScale: 1.2, maxEdge: 1600, quality: 0.8 });
    } catch (err) { got = { ok: false, error: err.message || String(err), images: [] }; }
    if (!box.isConnected) return;
    if (!got || !got.ok || !got.images.length) {
      box.innerHTML = `<div class="fv-too-big"><div class="fv-too-big-ico">📄</div><div class="fv-too-big-text"><div>无法预览此 PDF</div><div class="fv-too-big-sub">${esc((got && got.error) || '渲染失败')}，请下载后查看。</div></div></div>`;
      return;
    }
    const more = got.truncated ? `<div class="fv-pdf-more">共 ${got.pages} 页，预览前 ${got.images.length} 页；完整内容请让 Agent 调用 analyze_pdf 或下载查看。</div>` : '';
    box.innerHTML = `<div class="fv-pdf-meta mono">PDF · ${got.pages} 页</div>`
      + got.images.map((img) => `<figure class="fv-pdf-page"><img src="${esc(img.dataUrl)}" alt="第 ${img.page} 页" loading="lazy"><figcaption>第 ${img.page} 页</figcaption></figure>`).join('')
      + more;
  }
  return { renderFiles, openFileViewer, closeViewer, downloadFile };
}
