// Standalone, offline micro-interactions. No API, fetch, storage, imports or application state.
(() => {
  const en = document.documentElement.lang === 'en';
  const say = (zh, english) => en ? english : zh;
  const setExpanded = (open) => { document.querySelectorAll('.md-fold,.tool-call-chip').forEach(n => n.classList.toggle('expanded', open)); document.querySelectorAll('.share-reason').forEach(n => { n.open = open; }); };
  const fallbackCopy = (value) => {
    const ta = document.createElement('textarea'); ta.value = value; ta.style.cssText = 'position:fixed;left:-9999px'; document.body.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); if (!ok) throw new Error();
  };
  const copy = async (value, button) => {
    try {
      if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(value); } catch { fallbackCopy(value); } }
      else fallbackCopy(value);
      const old = button.textContent; button.textContent = say('已复制', 'Copied'); setTimeout(() => { button.textContent = old; }, 1200);
    } catch { button.title = say('浏览器拒绝了复制，请手动选择文本', 'Copy was denied. Select the text manually.'); }
  };
  let overlay;
  const preview = (source, video) => {
    overlay?.remove(); overlay = document.createElement('div'); overlay.className = 'share-overlay'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', say('预览', 'Preview'));
    const media = document.createElement(video ? 'video' : 'img'); media.src = source; if (video) media.controls = true;
    const close = document.createElement('button'); close.textContent = '×'; close.ariaLabel = say('关闭', 'Close');
    overlay.append(close, media); document.body.append(overlay); close.focus();
    close.onclick = () => { overlay.remove(); overlay = null; }; overlay.onclick = e => { if (e.target === overlay) close.click(); };
  };
  document.addEventListener('click', e => {
    const target = e.target;
    if (target.closest('#share-theme')) { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; return; }
    if (target.closest('#share-expand')) { setExpanded(true); return; }
    if (target.closest('#share-collapse')) { setExpanded(false); return; }
    const b = target.closest('.copy-code,.chip-copy');
    if (b) { e.stopPropagation(); const pre = b.closest('.chip-win,.code-block')?.querySelector('pre'); if (pre) copy(pre.textContent, b); return; }
    const v = target.closest('[data-share-video]'); if (v) { preview(v.dataset.shareVideo, true); return; }
    if (target.tagName === 'IMG' && target.getAttribute('src')?.startsWith('data:')) { preview(target.src, false); return; }
    const expand = target.closest('.md-chart-expand');
    if (expand) { const svg = expand.closest('.md-chart,.md-diagram')?.querySelector('svg.md-chart-svg'); if (svg) { const c = svg.cloneNode(true); preview('', false); overlay.querySelector('img').replaceWith(c); c.style.cssText = 'width:min(95vw,1100px);height:85vh;background:var(--bg);color:var(--fg);border-radius:12px'; } return; }
    const action = target.closest('[data-map-act]');
    if (action) { e.preventDefault(); zoom(action.closest('.md-chart-map')?.querySelector('svg'), action.dataset.mapAct === 'in' ? 1.3 : action.dataset.mapAct === 'out' ? 1 / 1.3 : 0); return; }
    if (target.closest('a,button,pre,code,details')) return;
    target.closest('.md-fold,.tool-call-chip')?.classList.toggle('expanded');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay) { overlay.remove(); overlay = null; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.md-fold,.tool-call-chip')) { e.preventDefault(); e.target.classList.toggle('expanded'); }
  });
  const original = new WeakMap();
  function zoom(svg, factor) {
    if (!svg) return; const current = svg.viewBox.baseVal;
    if (!original.has(svg)) original.set(svg, [current.x, current.y, current.width, current.height]);
    const base = original.get(svg);
    if (!factor) { svg.setAttribute('viewBox', base.join(' ')); return; }
    const w = Math.min(base[2], Math.max(base[2] / 8, current.width / factor)), h = w * base[3] / base[2];
    svg.setAttribute('viewBox', [current.x + (current.width - w) / 2, current.y + (current.height - h) / 2, w, h].join(' '));
  }
  document.addEventListener('wheel', e => { const svg = e.target.closest('svg'); if (svg?.closest('.md-chart') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); zoom(svg, e.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });
  let drag;
  document.addEventListener('pointerdown', e => { const svg = e.target.closest('svg'); if (!svg?.closest('.md-chart') || !original.has(svg)) return; drag = { svg, x: e.clientX, y: e.clientY, box: svg.getAttribute('viewBox').split(/[ ,]+/).map(Number) }; svg.setPointerCapture?.(e.pointerId); });
  document.addEventListener('pointermove', e => { if (!drag) return; const r = drag.svg.getBoundingClientRect(), b = drag.box; drag.svg.setAttribute('viewBox', [b[0] - (e.clientX - drag.x) * b[2] / r.width, b[1] - (e.clientY - drag.y) * b[3] / r.height, b[2], b[3]].join(' ')); });
  document.addEventListener('pointerup', () => { drag = null; });
})();
