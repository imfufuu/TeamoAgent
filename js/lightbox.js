export const LIGHTBOX_MIN_SCALE = 0.25;
export const LIGHTBOX_MAX_SCALE = 8;

/** Normalize wheel input across mouse wheels, trackpads, and line/page delta modes. */
export function lightboxWheelFactor(deltaY, deltaMode = 0, pageSize = 800) {
  const delta = Number(deltaY);
  if (!Number.isFinite(delta) || delta === 0) return 1;
  const mode = Number(deltaMode) || 0;
  const unit = mode === 1 ? 16 : mode === 2 ? Math.max(1, Number(pageSize) || 800) : 1;
  const pixels = Math.max(-240, Math.min(240, delta * unit));
  return Math.max(.72, Math.min(1.4, Math.exp(-pixels * .00145)));
}

export function zoomLightboxState(state, factor, anchor = {}) {
  const currentScale = Math.min(LIGHTBOX_MAX_SCALE, Math.max(LIGHTBOX_MIN_SCALE, Number(state?.scale) || 1));
  const requestedFactor = Number(factor);
  const safeFactor = Number.isFinite(requestedFactor) && requestedFactor > 0 ? requestedFactor : 1;
  const scale = Math.min(LIGHTBOX_MAX_SCALE, Math.max(LIGHTBOX_MIN_SCALE, currentScale * safeFactor));
  const ratio = scale / currentScale;
  const x = Number.isFinite(Number(anchor.x)) ? Number(anchor.x) : 0;
  const y = Number.isFinite(Number(anchor.y)) ? Number(anchor.y) : 0;
  return {
    ...state,
    scale,
    // anchor is the pointer's screen-pixel offset from the current transformed content bounds.
    // The viewer disables CSS transform easing so this geometry stays in sync with state on every wheel/pinch event.
    tx: (Number(state?.tx) || 0) - x * (ratio - 1),
    ty: (Number(state?.ty) || 0) - y * (ratio - 1),
  };
}
