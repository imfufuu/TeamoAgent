// Local-only canvas editor used by the explicit camera capture entry.
export function fitPhotoSize(width, height, maxEdge = 4096) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const edge = Math.max(1, Number(maxEdge) || 4096);
  const scale = Math.min(1, edge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
}

export function cropRectFromDrag(x1, y1, x2, y2, width, height, minSize = 12) {
  const maxW = Math.max(1, Number(width) || 1);
  const maxH = Math.max(1, Number(height) || 1);
  const left = Math.max(0, Math.min(maxW, Math.min(Number(x1) || 0, Number(x2) || 0)));
  const top = Math.max(0, Math.min(maxH, Math.min(Number(y1) || 0, Number(y2) || 0)));
  const right = Math.max(0, Math.min(maxW, Math.max(Number(x1) || 0, Number(x2) || 0)));
  const bottom = Math.max(0, Math.min(maxH, Math.max(Number(y1) || 0, Number(y2) || 0)));
  const rect = { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
  return rect.width >= minSize && rect.height >= minSize ? rect : null;
}

export function resizeCropRect(rect, handle, point, width, height, minSize = 12) {
  if (!rect || !point || !/^(?:nw|n|ne|e|se|s|sw|w)$/.test(String(handle))) return null;
  const maxW = Math.max(1, Number(width) || 1);
  const maxH = Math.max(1, Number(height) || 1);
  const min = Math.max(1, Math.min(Number(minSize) || 1, maxW, maxH));
  let left = Math.max(0, Math.min(maxW, Number(rect.x) || 0));
  let right = Math.max(left, Math.min(maxW, left + (Number(rect.width) || 0)));
  let top = Math.max(0, Math.min(maxH, Number(rect.y) || 0));
  let bottom = Math.max(top, Math.min(maxH, top + (Number(rect.height) || 0)));
  const px = Math.max(0, Math.min(maxW, Number(point.x) || 0));
  const py = Math.max(0, Math.min(maxH, Number(point.y) || 0));
  if (handle.includes('w')) left = Math.max(0, Math.min(right - min, px));
  if (handle.includes('e')) right = Math.min(maxW, Math.max(left + min, px));
  if (handle.includes('n')) top = Math.max(0, Math.min(bottom - min, py));
  if (handle.includes('s')) bottom = Math.min(maxH, Math.max(top + min, py));
  return {
    x: Math.round(left), y: Math.round(top),
    width: Math.max(1, Math.round(right - left)), height: Math.max(1, Math.round(bottom - top)),
  };
}

export function rotatePhotoCanvas(source, direction = 1) {
  const doc = source && source.ownerDocument;
  if (!doc || typeof doc.createElement !== 'function') throw new Error('Canvas 不可用');
  const target = doc.createElement('canvas');
  target.width = source.height;
  target.height = source.width;
  const ctx = target.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D 不可用');
  if (Number(direction) < 0) {
    ctx.translate(0, target.height);
    ctx.rotate(-Math.PI / 2);
  } else {
    ctx.translate(target.width, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.drawImage(source, 0, 0);
  return target;
}

export function openPhotoEditor(file, options = {}) {
  const doc = options.document || globalThis.document;
  if (!doc || !file) return Promise.resolve(null);
  const win = doc.defaultView || globalThis;
  const ImageCtor = win.Image || globalThis.Image;
  if (!ImageCtor || typeof win.URL?.createObjectURL !== 'function') return Promise.reject(new Error('此浏览器不支持本地照片编辑'));

  return new Promise((resolve, reject) => {
    const modal = doc.createElement('div');
    modal.className = 'photo-editor-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '编辑拍摄的照片');
    modal.innerHTML = `
      <section class="photo-editor" role="document">
        <header class="photo-editor-head">
          <div class="photo-editor-head-left">
            <span class="photo-editor-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7.5h3l1.5-2h5l1.5 2h3A2 2 0 0 1 20 9.5v8A2 2 0 0 1 18 19.5H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13.5" r="3.5"/><path d="M16.8 10.5h.01"/></svg></span>
            <div class="photo-editor-heading">
              <div class="photo-editor-eyebrow">LOCAL PHOTO STUDIO</div>
              <div class="photo-editor-title">照片编辑工作台</div>
              <div class="photo-file-name" aria-live="polite">正在读取照片…</div>
            </div>
          </div>
          <div class="photo-editor-head-right">
            <span class="photo-local-badge"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5 16 5v4.6c0 3.7-2.5 6.4-6 7.9-3.5-1.5-6-4.2-6-7.9V5l6-2.5Z"/><path d="m7.2 9.9 1.8 1.8 3.8-4"/></svg>仅本地处理</span>
            <button class="photo-editor-close" type="button" aria-label="取消编辑" title="关闭编辑器">×</button>
          </div>
        </header>
        <div class="photo-editor-main">
          <aside class="photo-editor-sidebar" aria-label="照片编辑工具">
            <div class="photo-section-caption"><span>编辑工具</span><span>TOOLS</span></div>
            <div class="photo-tool-grid">
              <button class="photo-tool-button" type="button" data-photo-action="undo" title="撤销最近一次编辑（⌘/Ctrl+Z）" aria-label="撤销" disabled>
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 8 5 12l4 4"/><path d="M5.5 12H14a5 5 0 0 1 0 10h-1" transform="translate(0 -5)"/></svg><span class="photo-tool-name">撤销</span><span class="photo-tool-hint">⌘ Z</span>
              </button>
              <button class="photo-tool-button" type="button" data-photo-action="rotate-left" title="向左旋转 90°" aria-label="向左旋转 90 度">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 10V5m0 0h5M4.5 5.5A8 8 0 1 1 3 12"/><path d="M12 8v4l2.5 1.5"/></svg><span class="photo-tool-name">左旋</span><span class="photo-tool-hint">90°</span>
              </button>
              <button class="photo-tool-button" type="button" data-photo-action="rotate-right" title="向右旋转 90°" aria-label="向右旋转 90 度">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 10V5m0 0h-5m4.5.5A8 8 0 1 0 21 12"/><path d="M12 8v4l-2.5 1.5"/></svg><span class="photo-tool-name">右旋</span><span class="photo-tool-hint">90°</span>
              </button>
              <button class="photo-tool-button" type="button" data-photo-action="crop" title="拖动裁剪框或手柄调整区域" aria-label="裁剪" aria-pressed="false">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3v13a2 2 0 0 0 2 2h12M3 7h13a2 2 0 0 1 2 2v12"/><path d="M7 7h10v10H7z"/></svg><span class="photo-tool-name">裁剪</span><span class="photo-tool-hint">自由选区</span>
              </button>
              <button class="photo-tool-button photo-tool-wide" type="button" data-photo-action="draw" title="在照片上绘制标注" aria-label="画笔" aria-pressed="false">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4 16.5-.8 4.3 4.3-.8L19 8.5 15.5 5 4 16.5Z"/><path d="m13.8 6.7 3.5 3.5M4 20.8l3.5-.8"/></svg><span class="photo-tool-name">画笔标注</span><span class="photo-tool-hint">自由绘制</span>
              </button>
            </div>
            <section class="photo-editor-context-panel" hidden>
              <div class="photo-context-heading"><span class="photo-context-spark"></span><strong>裁剪区域</strong></div>
              <p>拖动照片创建选区，再移动边缘或手柄微调。</p>
              <div class="photo-context-actions">
                <button class="photo-context-apply" type="button" data-photo-action="apply-crop" title="应用当前裁剪"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>应用</button>
                <button class="photo-context-cancel" type="button" data-photo-action="cancel-crop" title="取消当前裁剪">取消</button>
              </div>
            </section>
            <section class="photo-brush-panel" aria-label="画笔设置">
              <div class="photo-section-caption photo-brush-caption"><span>画笔样式</span><span>BRUSH</span></div>
              <label class="photo-pen-color" title="画笔颜色">
                <input type="color" value="#ff3b30" aria-label="画笔颜色">
                <span><strong>颜色</strong><small class="photo-color-value">#FF3B30</small></span>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg>
              </label>
              <label class="photo-pen-size" title="画笔粗细">
                <span class="photo-size-line"><span>笔触粗细</span><output class="photo-pen-size-value">6 px</output></span>
                <input type="range" min="2" max="18" value="6" aria-label="画笔粗细">
              </label>
            </section>
            <div class="photo-sidebar-note"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 9V6.5a5 5 0 0 1 10 0V9"/><rect x="3.5" y="9" width="13" height="9" rx="2"/><path d="M10 12v3"/></svg><span>照片只在此设备本地处理</span></div>
          </aside>
          <div class="photo-workspace">
            <div class="photo-stage-head">
              <div class="photo-stage-status"><span class="photo-stage-live-dot"></span><strong>预览工作区</strong><span class="photo-stage-tag">LIVE PREVIEW</span></div>
              <div class="photo-dimensions">— × — px</div>
            </div>
            <div class="photo-stage"><div class="photo-canvas-wrap"><canvas class="photo-canvas" aria-label="照片预览"></canvas><canvas class="photo-overlay" aria-hidden="true"></canvas></div></div>
            <div class="photo-editor-hint" role="status" aria-live="polite"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.25"/><path d="M10 9v4M10 6.5h.01"/></svg><span>旋转、裁剪或标注后，保存的照片会作为附件加入本轮。</span></div>
          </div>
        </div>
        <footer class="photo-editor-foot">
          <div class="photo-footer-note"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 10 3.2 3.2L15 6.5"/></svg><span>编辑完成后，照片将添加到本轮对话</span></div>
          <div class="photo-footer-actions"><button class="photo-cancel" type="button" data-photo-action="cancel">取消</button><button type="button" class="photo-save" data-photo-action="save"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.5v9m0 0 3.5-3.5M10 12.5 6.5 9M4.5 16.5h11"/></svg>保存并添加附件</button></div>
        </footer>
      </section>`;
    doc.body.appendChild(modal);

    const canvas = modal.querySelector('.photo-canvas');
    const overlay = modal.querySelector('.photo-overlay');
    const stage = modal.querySelector('.photo-stage');
    const ctx = canvas.getContext && canvas.getContext('2d');
    const overlayCtx = overlay.getContext && overlay.getContext('2d');
    const hint = modal.querySelector('.photo-editor-hint');
    const hintText = hint && hint.querySelector('span');
    const color = modal.querySelector('input[type="color"]');
    const penSize = modal.querySelector('input[type="range"]');
    const buttons = [...modal.querySelectorAll('[data-photo-action]')];
    const undoHistory = [];
    const pendingSnapshots = new Set();
    const objectUrl = win.URL.createObjectURL(file);
    const image = new ImageCtor();
    const state = {
      crop: false, draw: false, drawing: false, start: null, last: null,
      selection: null, dragType: null, dragHandle: null, dragStart: null,
      dragInitial: null, ready: false, undoing: false, finished: false,
      historySequence: 0, historyBytes: 0,
    };
    const applyCropButton = modal.querySelector('[data-photo-action="apply-crop"]');
    const cancelCropButton = modal.querySelector('[data-photo-action="cancel-crop"]');
    const undoButton = modal.querySelector('[data-photo-action="undo"]');
    const contextPanel = modal.querySelector('.photo-editor-context-panel');
    const penSizeValue = modal.querySelector('.photo-pen-size-value');
    const colorValue = modal.querySelector('.photo-color-value');
    const MAX_UNDO_ENTRIES = 8;
    const MAX_UNDO_BYTES = 96 * 1024 * 1024;

    const syncBrushControls = () => {
      if (penSizeValue && penSize) penSizeValue.textContent = `${Number(penSize.value) || 6} px`;
      if (colorValue && color) colorValue.textContent = String(color.value || '#ff3b30').toUpperCase();
    };
    if (penSize) penSize.addEventListener('input', syncBrushControls);
    if (color) color.addEventListener('input', syncBrushControls);
    syncBrushControls();

    const cleanup = () => {
      if (state.finished) return;
      state.finished = true;
      try { win.URL.revokeObjectURL(objectUrl); } catch { /* no-op */ }
      modal.remove();
    };
    const finish = (value) => { cleanup(); resolve(value); };
    const setHint = (text) => { if (hintText) hintText.textContent = text; else if (hint) hint.textContent = text; };
    const syncActionButtons = () => {
      const blocked = !state.ready || state.undoing || state.drawing;
      if (undoButton) undoButton.disabled = blocked || (!undoHistory.length && !pendingSnapshots.size);
      for (const button of buttons) {
        const action = button.dataset.photoAction;
        if (action === 'undo') continue;
        if (action === 'cancel') { button.disabled = false; continue; }
        if (action === 'apply-crop') { button.disabled = blocked || !state.selection || state.selection.width < 12 || state.selection.height < 12; continue; }
        if (action === 'cancel-crop') { button.disabled = blocked || !state.crop; continue; }
        button.disabled = blocked;
      }
    };
    const pushUndoSnapshot = () => {
      if (!state.ready || !canvas.width || !canvas.height || typeof canvas.toBlob !== 'function') return Promise.resolve(false);
      const sequence = ++state.historySequence;
      const width = canvas.width;
      const height = canvas.height;
      const task = new Promise((resolveSnapshot) => {
        const complete = (blob) => {
          if (blob && !state.finished && blob.size <= MAX_UNDO_BYTES) {
            const snapshot = { sequence, width, height, blob, size: blob.size };
            undoHistory.push(snapshot);
            undoHistory.sort((a, b) => a.sequence - b.sequence);
            state.historyBytes += snapshot.size;
            while (undoHistory.length > MAX_UNDO_ENTRIES || state.historyBytes > MAX_UNDO_BYTES) {
              const removed = undoHistory.shift();
              if (removed) state.historyBytes -= removed.size;
            }
          } else if (blob && blob.size > MAX_UNDO_BYTES) {
            setHint('这张照片的撤销快照过大；当前编辑仍可继续，但该步无法撤销。');
          }
          resolveSnapshot(!!blob);
        };
        try { canvas.toBlob(complete, 'image/png'); } catch { complete(null); }
      });
      pendingSnapshots.add(task);
      task.then(() => { pendingSnapshots.delete(task); syncActionButtons(); });
      syncActionButtons();
      return task;
    };
    const setMode = (mode) => {
      state.crop = mode === 'crop';
      state.draw = mode === 'draw';
      state.drawing = false;
      state.start = null;
      state.dragType = null;
      state.dragHandle = null;
      state.dragInitial = null;
      if (!state.crop) state.selection = null;
      if (contextPanel) contextPanel.hidden = !state.crop;
      canvas.style.cursor = state.crop ? 'crosshair' : state.draw ? 'crosshair' : '';
      for (const button of buttons) {
        const active = button.dataset.photoAction === mode;
        button.classList.toggle('active', active);
        if (button.dataset.photoAction === 'crop' || button.dataset.photoAction === 'draw') button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      if (applyCropButton) applyCropButton.hidden = !state.crop || !state.selection;
      if (cancelCropButton) cancelCropButton.hidden = !state.crop;
      if (state.crop) setHint('拖动裁剪框边缘或八个手柄调整选区；也可在框内移动，完成后点“应用裁剪”。');
      else if (state.draw) setHint('在照片上拖动进行标注；再次点击画笔可退出。');
      else setHint('旋转、裁剪或标注后，保存的照片会作为附件加入本轮。');
      if (overlayCtx) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      syncActionButtons();
    };
    const point = (event) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width ? canvas.width / rect.width : 1;
      const scaleY = rect.height ? canvas.height / rect.height : 1;
      return {
        x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * scaleX)),
        y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * scaleY)),
      };
    };
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const cropHandles = (rect) => ({
      nw: { x: rect.x, y: rect.y },
      n: { x: rect.x + rect.width / 2, y: rect.y },
      ne: { x: rect.x + rect.width, y: rect.y },
      e: { x: rect.x + rect.width, y: rect.y + rect.height / 2 },
      se: { x: rect.x + rect.width, y: rect.y + rect.height },
      s: { x: rect.x + rect.width / 2, y: rect.y + rect.height },
      sw: { x: rect.x, y: rect.y + rect.height },
      w: { x: rect.x, y: rect.y + rect.height / 2 },
    });
    const hitCropHandle = (p, rect) => {
      if (!rect) return null;
      const bounds = canvas.getBoundingClientRect();
      const tx = Math.max(8, 13 * (bounds.width ? canvas.width / bounds.width : 1));
      const ty = Math.max(8, 13 * (bounds.height ? canvas.height / bounds.height : 1));
      let closest = null;
      let score = Infinity;
      for (const [name, handle] of Object.entries(cropHandles(rect))) {
        const dx = (p.x - handle.x) / tx;
        const dy = (p.y - handle.y) / ty;
        const current = dx * dx + dy * dy;
        if (current <= 1 && current < score) { closest = name; score = current; }
      }
      return closest;
    };
    const pointInCrop = (p, rect) => !!rect && p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
    const drawSelection = () => {
      if (!overlayCtx) return;
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      if (applyCropButton) applyCropButton.hidden = !state.crop || !state.selection;
      if (!state.crop || !state.selection) { syncActionButtons(); return; }
      const rect = state.selection;
      overlayCtx.fillStyle = 'rgba(0,0,0,.38)';
      overlayCtx.fillRect(0, 0, overlay.width, overlay.height);
      overlayCtx.clearRect(rect.x, rect.y, rect.width, rect.height);
      overlayCtx.strokeStyle = '#fff';
      overlayCtx.lineWidth = Math.max(2, canvas.width / 1000);
      overlayCtx.setLineDash([8, 5]);
      overlayCtx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      overlayCtx.setLineDash([]);
      const bounds = canvas.getBoundingClientRect();
      const rx = Math.max(5, 5 * (bounds.width ? canvas.width / bounds.width : 1));
      const ry = Math.max(5, 5 * (bounds.height ? canvas.height / bounds.height : 1));
      overlayCtx.lineWidth = Math.max(1, canvas.width / 1800);
      for (const handle of Object.values(cropHandles(rect))) {
        overlayCtx.fillStyle = '#fff';
        overlayCtx.strokeStyle = 'rgba(20,20,20,.88)';
        overlayCtx.fillRect(handle.x - rx, handle.y - ry, rx * 2, ry * 2);
        overlayCtx.strokeRect(handle.x - rx, handle.y - ry, rx * 2, ry * 2);
      }
      if (applyCropButton) applyCropButton.hidden = false;
      syncActionButtons();
    };
    const syncOverlay = () => {
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      if (overlayCtx) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      if (stage) stage.setAttribute('data-size', `${canvas.width}×${canvas.height}`);
      const dimensions = modal.querySelector('.photo-dimensions');
      if (dimensions) dimensions.textContent = `${canvas.width.toLocaleString()} × ${canvas.height.toLocaleString()} px`;
    };
    const beginCropDrag = (event, p) => {
      const handle = hitCropHandle(p, state.selection);
      const inside = !handle && pointInCrop(p, state.selection);
      state.dragType = handle ? 'resize' : inside ? 'move' : 'create';
      state.dragHandle = handle;
      state.dragStart = p;
      state.dragInitial = state.selection ? { ...state.selection } : null;
      if (state.dragType === 'create') state.selection = null;
      canvas.style.cursor = state.dragType === 'move' ? 'move' : state.dragType === 'resize' ? `${handle}-resize` : 'crosshair';
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
      state.drawing = true;
      if (state.dragType === 'create') state.selection = { x: p.x, y: p.y, width: 0, height: 0 };
      drawSelection();
    };
    const updateCropDrag = (p) => {
      const start = state.dragStart;
      if (!start || !state.dragType) return;
      if (state.dragType === 'create') {
        state.selection = cropRectFromDrag(start.x, start.y, p.x, p.y, canvas.width, canvas.height, 1);
      } else if (state.dragType === 'move' && state.dragInitial) {
        const initial = state.dragInitial;
        state.selection = {
          ...initial,
          x: Math.round(clamp(initial.x + p.x - start.x, 0, canvas.width - initial.width)),
          y: Math.round(clamp(initial.y + p.y - start.y, 0, canvas.height - initial.height)),
        };
      } else if (state.dragType === 'resize' && state.dragInitial) {
        const initial = state.dragInitial;
        state.selection = resizeCropRect(initial, state.dragHandle, p, canvas.width, canvas.height);
      }
      drawSelection();
    };
    const applyCrop = () => {
      const rect = state.selection && cropRectFromDrag(
        state.selection.x, state.selection.y,
        state.selection.x + state.selection.width, state.selection.y + state.selection.height,
        canvas.width, canvas.height,
      );
      if (!rect) { setHint('裁剪选区太小，照片保持不变。'); return; }
      const next = doc.createElement('canvas');
      next.width = rect.width; next.height = rect.height;
      const nextCtx = next.getContext('2d');
      if (!nextCtx) { setHint('裁剪不可用，照片保持不变。'); return; }
      nextCtx.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      pushUndoSnapshot();
      canvas.width = next.width; canvas.height = next.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(next, 0, 0);
      syncOverlay();
      setMode(null);
      setHint(`已裁剪至 ${canvas.width} × ${canvas.height}。可用“撤销”恢复。`);
    };
    const rotate = (dir) => {
      try {
        const next = rotatePhotoCanvas(canvas, dir);
        pushUndoSnapshot();
        canvas.width = next.width; canvas.height = next.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(next, 0, 0);
        syncOverlay();
        setMode(null);
      } catch (error) { setHint(`旋转失败：${error.message}`); }
    };
    const restoreSnapshot = async (snapshot) => {
      const snapshotUrl = win.URL.createObjectURL(snapshot.blob);
      try {
        const restoredImage = await new Promise((res, rej) => {
          const source = new ImageCtor();
          source.onload = () => res(source);
          source.onerror = () => rej(new Error('无法恢复照片快照'));
          source.src = snapshotUrl;
        });
        canvas.width = snapshot.width;
        canvas.height = snapshot.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(restoredImage, 0, 0, canvas.width, canvas.height);
        syncOverlay();
        setMode(null);
        setHint(`已撤销；照片恢复至 ${canvas.width} × ${canvas.height}。`);
      } finally {
        try { win.URL.revokeObjectURL(snapshotUrl); } catch { /* no-op */ }
      }
    };
    const undo = async () => {
      if (state.undoing || state.drawing || !state.ready) return;
      state.undoing = true;
      syncActionButtons();
      try {
        await Promise.all([...pendingSnapshots]);
        const snapshot = undoHistory.pop();
        if (!snapshot) { setHint('没有可撤销的编辑。'); return; }
        state.historyBytes -= snapshot.size;
        await restoreSnapshot(snapshot);
      } catch (error) {
        setHint(`撤销失败：${error.message}`);
      } finally {
        state.undoing = false;
        syncActionButtons();
      }
    };

    canvas.addEventListener('pointerdown', (event) => {
      if (!state.ready || state.undoing || (!state.crop && !state.draw) || state.drawing) return;
      const p = point(event);
      if (state.crop) { beginCropDrag(event, p); return; }
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
      state.start = p; state.last = p; state.drawing = true;
      pushUndoSnapshot();
      if (ctx) {
        const rect = canvas.getBoundingClientRect();
        ctx.beginPath(); ctx.moveTo(p.x, p.y);
        ctx.strokeStyle = color.value || '#ff3b30';
        ctx.lineWidth = Math.max(1, Number(penSize.value) * (rect.width ? canvas.width / rect.width : 1));
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      }
    });
    canvas.addEventListener('pointermove', (event) => {
      const p = point(event);
      if (!state.drawing || !state.start && !state.dragStart) {
        if (state.crop && state.selection) {
          const handle = hitCropHandle(p, state.selection);
          canvas.style.cursor = handle ? `${handle}-resize` : pointInCrop(p, state.selection) ? 'move' : 'crosshair';
        }
        return;
      }
      if (state.crop) updateCropDrag(p);
      else if (ctx && state.draw) { ctx.lineTo(p.x, p.y); ctx.stroke(); }
      state.last = p;
    });
    const endPointer = (event, cancelled = false) => {
      if (!state.drawing) return;
      if (state.crop && state.dragStart) {
        if (cancelled) state.selection = state.dragInitial ? { ...state.dragInitial } : null;
        else updateCropDrag(point(event));
      }
      state.drawing = false;
      state.start = null; state.last = null;
      state.dragStart = null; state.dragType = null; state.dragHandle = null; state.dragInitial = null;
      if (state.crop) {
        drawSelection();
        canvas.style.cursor = state.selection ? 'move' : 'crosshair';
      } else if (overlayCtx) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      syncActionButtons();
    };
    canvas.addEventListener('pointerup', (event) => endPointer(event, false));
    canvas.addEventListener('pointercancel', (event) => endPointer(event, true));

    for (const button of buttons) button.addEventListener('click', async () => {
      const action = button.dataset.photoAction;
      if (action === 'cancel') { finish(null); return; }
      if (action === 'undo') { await undo(); return; }
      if (action === 'rotate-left') { rotate(-1); return; }
      if (action === 'rotate-right') { rotate(1); return; }
      if (action === 'crop') { setMode(state.crop ? null : 'crop'); return; }
      if (action === 'apply-crop') { applyCrop(); return; }
      if (action === 'cancel-crop') { setMode(null); return; }
      if (action === 'draw') { setMode(state.draw ? null : 'draw'); return; }
      if (action === 'save') {
        button.disabled = true;
        setHint('正在生成编辑后的照片…');
        const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const ext = type === 'image/png' ? 'png' : 'jpg';
        const name = String(file.name || `camera-photo.${ext}`).replace(/\.[^.]+$/, '') + `-edited.${ext}`;
        try {
          const blob = await new Promise((res, rej) => canvas.toBlob((value) => value ? res(value) : rej(new Error('照片导出失败')), type, 0.92));
          const output = new (win.File || File)([blob], name, { type, lastModified: Date.now() });
          finish(output);
        } catch (error) {
          button.disabled = false;
          setHint(`保存失败：${error.message}`);
        }
      }
    });
    modal.querySelector('.photo-editor-close').addEventListener('click', () => finish(null));
    modal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (state.crop) { setMode(null); return; }
        finish(null); return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
    });
    image.onload = () => {
      try {
        if (!ctx || !overlayCtx || !image.naturalWidth || !image.naturalHeight) throw new Error('无法读取照片');
        const fitted = fitPhotoSize(image.naturalWidth, image.naturalHeight);
        canvas.width = fitted.width; canvas.height = fitted.height;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        syncOverlay();
        state.ready = true;
        const fileName = modal.querySelector('.photo-file-name');
        if (fileName) fileName.textContent = file.name || '拍摄照片';
        syncActionButtons();
        modal.querySelector('[data-photo-action="save"]').focus();
      } catch (error) {
        setHint(`打开照片失败：${error.message}`);
        modal.querySelector('[data-photo-action="save"]').disabled = true;
      }
    };
    image.onerror = () => {
      setHint('浏览器无法解码这张照片；请取消后用普通附件入口添加。');
      modal.querySelector('[data-photo-action="save"]').disabled = true;
    };
    syncActionButtons();
    image.src = objectUrl;
  });
}
