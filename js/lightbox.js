export const LIGHTBOX_MIN_SCALE = 0.25;
export const LIGHTBOX_MAX_SCALE = 8;

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
    // anchor is measured from the untransformed viewport origin to the pointer,
    // but as an offset from the currently transformed content's bounding box.
    tx: (Number(state?.tx) || 0) - x * (ratio - 1),
    ty: (Number(state?.ty) || 0) - y * (ratio - 1),
  };
}
