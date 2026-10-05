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
        <header class="photo-editor-head"><div class="photo-editor-title">编辑照片</div><button class="photo-editor-close" type="button" aria-label="取消编辑" title="取消">×</button></header>
        <div class="photo-editor-toolbar">
          <button type="button" data-photo-action="rotate-left" title="向左旋转 90°">↶ <span>左旋</span></button>
          <button type="button" data-photo-action="rotate-right" title="向右旋转 90°">↷ <span>右旋</span></button>
          <button type="button" data-photo-action="crop" title="拖动选取裁剪区域">裁剪</button>
          <button type="button" data-photo-action="draw" title="在照片上绘制">画笔</button>
          <label class="photo-pen-color" title="画笔颜色"><span>颜色</span><input type="color" value="#ff3b30" aria-label="画笔颜色"></label>
          <label class="photo-pen-size" title="画笔粗细"><span>粗细</span><input type="range" min="2" max="18" value="6" aria-label="画笔粗细"></label>
        </div>
        <div class="photo-editor-hint" aria-live="polite">旋转、裁剪或标注后，保存的照片会作为附件加入本轮。</div>
        <div class="photo-stage"><canvas class="photo-canvas" aria-label="照片预览"></canvas><canvas class="photo-overlay" aria-hidden="true"></canvas></div>
        <footer class="photo-editor-foot"><button type="button" data-photo-action="cancel">取消</button><button type="button" class="photo-save" data-photo-action="save">保存并添加附件</button></footer>
      </section>`;
    doc.body.appendChild(modal);

    const canvas = modal.querySelector('.photo-canvas');
    const overlay = modal.querySelector('.photo-overlay');
    const stage = modal.querySelector('.photo-stage');
    const ctx = canvas.getContext && canvas.getContext('2d');
    const overlayCtx = overlay.getContext && overlay.getContext('2d');
    const hint = modal.querySelector('.photo-editor-hint');
    const color = modal.querySelector('input[type="color"]');
    const penSize = modal.querySelector('input[type="range"]');
    const buttons = [...modal.querySelectorAll('[data-photo-action]')];
    const objectUrl = win.URL.createObjectURL(file);
    const image = new ImageCtor();
    const state = { crop: false, draw: false, drawing: false, start: null, last: null, selection: null, finished: false };

    const cleanup = () => {
      if (state.finished) return;
      state.finished = true;
      try { win.URL.revokeObjectURL(objectUrl); } catch { /* no-op */ }
      modal.remove();
    };
    const finish = (value) => { cleanup(); resolve(value); };
    const setHint = (text) => { if (hint) hint.textContent = text; };
    const setMode = (mode) => {
      state.crop = mode === 'crop';
      state.draw = mode === 'draw';
      for (const button of buttons) button.classList.toggle('active', button.dataset.photoAction === mode);
      if (state.crop) setHint('在照片上拖动，松开后应用裁剪；选择太小会被忽略。');
      else if (state.draw) setHint('在照片上拖动进行标注；再次点击画笔可退出。');
      else setHint('旋转、裁剪或标注后，保存的照片会作为附件加入本轮。');
      if (overlayCtx) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
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
    const drawSelection = (a, b) => {
      if (!overlayCtx) return;
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      const rect = cropRectFromDrag(a.x, a.y, b.x, b.y, canvas.width, canvas.height, 1);
      if (!rect) return;
      overlayCtx.fillStyle = 'rgba(0,0,0,.35)';
      overlayCtx.fillRect(0, 0, overlay.width, overlay.height);
      overlayCtx.clearRect(rect.x, rect.y, rect.width, rect.height);
      overlayCtx.strokeStyle = '#ffffff';
      overlayCtx.lineWidth = Math.max(2, canvas.width / 1000);
      overlayCtx.setLineDash([8, 5]);
      overlayCtx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      overlayCtx.setLineDash([]);
    };
    const syncOverlay = () => {
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      if (overlayCtx) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      if (stage) stage.setAttribute('data-size', `${canvas.width}×${canvas.height}`);
    };
    const applyCrop = (a, b) => {
      const rect = cropRectFromDrag(a.x, a.y, b.x, b.y, canvas.width, canvas.height);
      if (!rect) { setHint('裁剪选区太小，照片保持不变。'); return; }
      const next = doc.createElement('canvas');
      next.width = rect.width; next.height = rect.height;
      const nextCtx = next.getContext('2d');
      if (!nextCtx) { setHint('裁剪不可用，照片保持不变。'); return; }
      nextCtx.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      canvas.width = next.width; canvas.height = next.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(next, 0, 0);
      syncOverlay();
      setMode(null);
      setHint(`已裁剪至 ${canvas.width} × ${canvas.height}。`);
    };
    const rotate = (dir) => {
      try {
        const next = rotatePhotoCanvas(canvas, dir);
        canvas.width = next.width; canvas.height = next.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(next, 0, 0);
        syncOverlay();
        setMode(null);
      } catch (error) { setHint(`旋转失败：${error.message}`); }
    };

    canvas.addEventListener('pointerdown', (event) => {
      if (!state.crop && !state.draw) return;
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
      const p = point(event);
      state.start = p; state.last = p; state.drawing = true;
      if (state.crop) drawSelection(p, p);
      else if (ctx) {
        const rect = canvas.getBoundingClientRect();
        ctx.beginPath(); ctx.moveTo(p.x, p.y);
        ctx.strokeStyle = color.value || '#ff3b30';
        ctx.lineWidth = Math.max(1, Number(penSize.value) * (rect.width ? canvas.width / rect.width : 1));
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      }
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!state.drawing || !state.start) return;
      const p = point(event);
      if (state.crop) drawSelection(state.start, p);
      else if (ctx) { ctx.lineTo(p.x, p.y); ctx.stroke(); }
      state.last = p;
    });
    const endPointer = (event) => {
      if (!state.drawing) return;
      const p = point(event);
      if (state.crop && state.start) applyCrop(state.start, p);
      state.drawing = false; state.start = null; state.last = null;
      if (!state.crop && overlayCtx) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    for (const button of buttons) button.addEventListener('click', async () => {
      const action = button.dataset.photoAction;
      if (action === 'cancel') { finish(null); return; }
      if (action === 'rotate-left') { rotate(-1); return; }
      if (action === 'rotate-right') { rotate(1); return; }
      if (action === 'crop') { setMode(state.crop ? null : 'crop'); return; }
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
    modal.addEventListener('keydown', (event) => { if (event.key === 'Escape') finish(null); });
    image.onload = () => {
      try {
        if (!ctx || !overlayCtx || !image.naturalWidth || !image.naturalHeight) throw new Error('无法读取照片');
        const fitted = fitPhotoSize(image.naturalWidth, image.naturalHeight);
        canvas.width = fitted.width; canvas.height = fitted.height;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        syncOverlay();
        modal.querySelector('.photo-editor-title').textContent = `${file.name || '照片'} · ${canvas.width}×${canvas.height}`;
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
    image.src = objectUrl;
  });
}
