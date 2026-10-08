// Dubhe Agent · 全屏预览（Lightbox，从 ui.js 的 mountUI 拆出，V1.7.1）
// 支持光栅图片 / 内联 SVG / 语法渲染图表（Mermaid / Flow / Mind）的全屏查看，缩放、拖动、键盘与滚轮。
// 自带事件委派（document 级 click / keydown），installLightbox() 调一次即可；返回 { openLightbox, closeLightbox }。
import { zoomLightboxState, lightboxWheelFactor } from './lightbox.js?v=2026.10.5.34';

const $ = (sel, root = document) => root.querySelector(sel);

export function installLightbox() {
  // ── 全屏预览：支持光栅图片 / SVG / 语法渲染的图表（Mermaid/Flow/Mind），缩放与拖动 ──
  let lbState = { scale: 1, tx: 0, ty: 0, dragging: false, sx: 0, sy: 0, sTx: 0, sTy: 0 };
  function lbApplyTransform() {
    const stage = $('#img-lightbox-pic');
    if (!stage) return;
    stage.style.transform = `translate3d(${lbState.tx}px, ${lbState.ty}px, 0) scale(${lbState.scale})`;
    const lbl = $('.lb-zoom-label', $('#img-lightbox'));
    if (lbl) lbl.textContent = `${Math.round(lbState.scale * 100)}%`;
  }
  function lbReset() {
    lbState.scale = 1; lbState.tx = 0; lbState.ty = 0;
    lbState.dragging = false; lbState.sx = 0; lbState.sy = 0; lbState.sTx = 0; lbState.sTy = 0;
    lbApplyTransform();
  }
  function lbZoomAt(factor, cx, cy) {
    const stage = $('#img-lightbox-pic');
    const box = $('#img-lightbox');
    const viewport = box && box.querySelector('.img-lightbox-stage');
    if (!stage || !viewport) return;
    const rect = stage.getBoundingClientRect();
    const viewRect = viewport.getBoundingClientRect();
    const anchorX = Number.isFinite(cx) ? cx : viewRect.left + viewRect.width / 2;
    const anchorY = Number.isFinite(cy) ? cy : viewRect.top + viewRect.height / 2;
    const next = zoomLightboxState(lbState, factor, { x: anchorX - rect.left, y: anchorY - rect.top });
    Object.assign(lbState, next);
    lbApplyTransform();
  }
  function openLightbox(content, opts = {}) {
    const box = $('#img-lightbox');
    const stage = $('#img-lightbox-pic');
    if (!box || !stage || !content) return;
    stage.innerHTML = '';
    if (typeof content === 'string') {
      // 光栅图片 URL
      const im = document.createElement('img');
      im.src = content;
      im.alt = opts.alt || '';
      im.draggable = false;
      stage.appendChild(im);
    } else if (content instanceof Node) {
      // 传入的 DOM（SVG / 图表容器）→ 深克隆后放入（避免移动原节点）。
      // 视图框为 SVG 补上固有宽高，防止没有 width/height 的图表在 flex viewer 中塌成一个点。
      const clone = content.cloneNode(true);
      clone.removeAttribute('id');
      const svgs = clone.matches?.('svg') ? [clone] : [...(clone.querySelectorAll?.('svg') || [])];
      for (const svg of svgs) {
        const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
        if (vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0) continue;
        const widthAttr = (svg.getAttribute('width') || '').trim();
        const heightAttr = (svg.getAttribute('height') || '').trim();
        if (!(Number.parseFloat(widthAttr) > 0) || /%$/.test(widthAttr)) svg.setAttribute('width', String(vb[2]));
        if (!(Number.parseFloat(heightAttr) > 0) || /%$/.test(heightAttr)) svg.setAttribute('height', String(vb[3]));
      }
      stage.appendChild(clone);
    }
    lbReset();
    box.hidden = false;
  }
  function closeLightbox() {
    const box = $('#img-lightbox');
    if (!box) return;
    box.hidden = true;
    const stage = $('#img-lightbox-pic');
    if (stage) stage.innerHTML = '';
  }
  const lightbox = $('#img-lightbox');
  if (lightbox) {
    // 点击关闭逻辑：只在直接点到遮罩背景（img-lightbox 本体空白区域）或 × 按钮时关闭。
    // 工具栏/stage/图片/按钮内的点击都不关闭（之前点 +/− 会冒泡到 .img-lightbox 被误判成"点空白"）。
    lightbox.addEventListener('click', (e) => {
      if (e.target.closest('.img-lightbox-x')) { closeLightbox(); return; }
      // 只有点击到 lightbox 自身（而不是它的子元素：toolbar/stage/transform/img/button）才视为空白点击
      if (e.target === lightbox) closeLightbox();
    });
    // 工具栏
    const btnIn = lightbox.querySelector('.lb-zoom-in');
    const btnOut = lightbox.querySelector('.lb-zoom-out');
    const btnReset = lightbox.querySelector('.lb-reset');
    if (btnIn) btnIn.addEventListener('click', (e) => { e.stopPropagation(); lbZoomAt(1.25); });
    if (btnOut) btnOut.addEventListener('click', (e) => { e.stopPropagation(); lbZoomAt(0.8); });
    if (btnReset) btnReset.addEventListener('click', (e) => { e.stopPropagation(); lbReset(); });
    // 拖动 + 双指缩放（Pointer Events 原生支持多点）
    const stageWrap = lightbox.querySelector('.img-lightbox-stage');
    const pointers = new Map(); // pointerId → {x,y}
    let lastPinchDist = 0;
    if (stageWrap) {
      stageWrap.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.lb-btn') || e.target.closest('button')) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        stageWrap.setPointerCapture?.(e.pointerId);
        lastPinchDist = 0;
        if (pointers.size === 1) {
          lbState.dragging = true;
          lbState.sx = e.clientX; lbState.sy = e.clientY;
          lbState.sTx = lbState.tx; lbState.sTy = lbState.ty;
        }
      });
      stageWrap.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size >= 2) {
          // 双指缩放
          const pts = [...pointers.values()];
          const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
          const dist = Math.hypot(dx, dy);
          if (lastPinchDist > 0) {
            const factor = dist / lastPinchDist;
            const cx = (pts[0].x + pts[1].x) / 2;
            const cy = (pts[0].y + pts[1].y) / 2;
            lbZoomAt(factor, cx, cy);
          }
          lastPinchDist = dist;
          lbState.dragging = false;
        } else if (pointers.size === 1 && lbState.dragging) {
          lbState.tx = lbState.sTx + (e.clientX - lbState.sx);
          lbState.ty = lbState.sTy + (e.clientY - lbState.sy);
          lbApplyTransform();
        }
      });
      const endPtr = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) lastPinchDist = 0;
        if (pointers.size === 1) {
          // Seamlessly continue a pinch as a one-finger pan when the other finger lifts.
          const remaining = [...pointers.values()][0];
          lbState.dragging = true;
          lbState.sx = remaining.x; lbState.sy = remaining.y;
          lbState.sTx = lbState.tx; lbState.sTy = lbState.ty;
        } else if (pointers.size === 0) lbState.dragging = false;
      };
      stageWrap.addEventListener('pointerup', endPtr);
      stageWrap.addEventListener('pointercancel', endPtr);
      // Pointer capture keeps drags/pinches continuous even if a finger crosses the stage edge.
      // Wheel deltas are normalized so a high-rate trackpad feels finer than a stepped mouse wheel.
      stageWrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        const pageSize = stageWrap.clientHeight || window.innerHeight || 800;
        lbZoomAt(lightboxWheelFactor(e.deltaY, e.deltaMode, pageSize), e.clientX, e.clientY);
      }, { passive: false });
      // 双击重置
      stageWrap.addEventListener('dblclick', (e) => { e.preventDefault(); lbReset(); });
    }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#img-lightbox') && !$('#img-lightbox').hidden) closeLightbox();
    if (!$('#img-lightbox') || $('#img-lightbox').hidden) return;
    if (e.key === '+' || e.key === '=') lbZoomAt(1.2);
    if (e.key === '-' || e.key === '_') lbZoomAt(1 / 1.2);
    if (e.key === '0') lbReset();
  });
  // 点击委派：图片 / SVG / 图表 → 全屏
  document.addEventListener('click', (e) => {
    if (e.target.closest('.img-lightbox')) return;
    const expandChart = e.target.closest('.md-chart-expand');
    if (expandChart) {
      e.preventDefault(); e.stopPropagation();
      const svg = expandChart.closest('.md-chart, .md-diagram')?.querySelector('.md-chart-svg');
      if (svg) openLightbox(svg, { alt: svg.getAttribute('aria-label') || '图表' });
      return;
    }
    // 1) 普通 <img>（消息正文 / 附件 / 文件预览）
    const img = e.target.closest('img');
    if (img && img.id !== 'img-lightbox-pic') {
      if (img.closest('.md-body, .att-img, .fv-img, .file-viewer')) {
        const src = img.currentSrc || img.src;
        if (!src) return;
        e.preventDefault();
        openLightbox(src, { alt: img.alt });
        return;
      }
    }
    // 2) 内嵌 SVG（fv-svg 文件预览里的 SVG、消息正文中的内联 SVG）
    const svg = e.target.closest('svg');
    if (svg) {
      if (svg.closest('.fv-svg, .katex-display-block, .fv-img')) {
        // KaTeX 不要全屏（公式点击全屏意义不大且会干扰选择文本）
        if (svg.closest('.katex *')) return;
        e.preventDefault();
        openLightbox(svg, {});
        return;
      }
      // 3) 语法渲染的图表（Mermaid 流程图 / 思维导图）：md-chart-svg / md-diagram-svg
      const chartSvg = svg.closest('.md-chart-svg, .md-diagram-svg');
      if (chartSvg) {
        // Quick charts use an explicit expand button; diagrams retain their direct-click shortcut.
        if (chartSvg.closest('.md-chart') && !e.target.closest('.md-chart-expand')) return;
        e.preventDefault();
        openLightbox(chartSvg, { alt: chartSvg.getAttribute('aria-label') || '图表' });
        return;
      }
    }
  });
  return { openLightbox, closeLightbox };
}
