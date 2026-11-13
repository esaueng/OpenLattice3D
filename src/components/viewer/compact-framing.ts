// Camera framing for compact (phone-size) viewers, where the view cube sits in
// the top-right corner of the viewport instead of the bottom-right margin.
// A fitted model is centred in the viewport, so on a narrow screen its
// top-right reaches into the cube. This works out how far to move the fitted
// model's on-screen centre away from the cube (down-left) and, if the viewport
// leaves no room for that, how much farther to pull the camera back.
//
// Pure screen-space arithmetic in CSS pixels, no three.js: the fitted model is
// represented by its bounding sphere's silhouette and the cube gizmo by the
// circle it sweeps in any orientation. The sphere silhouette is the on-axis
// one; an off-axis sphere projects very slightly larger, which `gapPx` covers.

export interface ViewportSize {
  width: number;
  height: number;
}

/** A gizmo anchored to the top-right corner: its centre sits `marginX` from
 *  the right edge and `marginY` from the top, and nothing of it reaches
 *  farther than `radiusPx` from that centre. */
export interface CornerGizmo {
  marginX: number;
  marginY: number;
  radiusPx: number;
}

export interface CompactFramingOptions {
  /** Vertical field of view in degrees. */
  fovDeg: number;
  /** Fit padding: the camera distance multiplier the normal fit applies. */
  padding: number;
  gizmo: CornerGizmo;
  /** Clear space kept between the model's silhouette and the gizmo. */
  gapPx: number;
  /** Shifting never pushes the silhouette closer than this to the left or bottom edge. */
  edgePx: number;
  /** Lower bound on the model's on-screen size relative to the normal fit. */
  minScale?: number;
}

export interface ViewerFraming {
  /** Where the fitted model's centre moves on screen, in CSS px (+x right, +y down). */
  offsetX: number;
  offsetY: number;
  /** Multiplier on the normal fit distance (1 keeps the model's size). */
  distanceScale: number;
}

export const UNADJUSTED_FRAMING: ViewerFraming = { offsetX: 0, offsetY: 0, distanceScale: 1 };

const DEG = Math.PI / 180;

/** Angular radius of a bounding sphere fitted the normal way: it fills the
 *  tighter of the two fields of view, divided by the padding. */
function fittedAngularRadius(size: ViewportSize, fovDeg: number, padding: number): number {
  const halfV = (fovDeg * DEG) / 2;
  const halfH = Math.atan(Math.tan(halfV) * (size.width / size.height));
  return Math.asin(Math.min(Math.sin(halfV), Math.sin(halfH)) / padding);
}

/** On-screen radius (px) of a bounding sphere fitted the normal way and centred in view. */
export function fittedSphereScreenRadius(size: ViewportSize, fovDeg: number, padding: number): number {
  const halfV = (fovDeg * DEG) / 2;
  return (Math.tan(fittedAngularRadius(size, fovDeg, padding)) / Math.tan(halfV)) * (size.height / 2);
}

/** Where a fitted bounding sphere's silhouette lands under `framing` (px). */
export function framedSilhouette(
  size: ViewportSize,
  fovDeg: number,
  padding: number,
  framing: ViewerFraming,
): { centerX: number; centerY: number; radius: number } {
  const alpha = fittedAngularRadius(size, fovDeg, padding);
  const framedAlpha = Math.asin(Math.sin(alpha) / framing.distanceScale);
  const halfV = (fovDeg * DEG) / 2;
  return {
    centerX: size.width / 2 + framing.offsetX,
    centerY: size.height / 2 + framing.offsetY,
    radius: (Math.tan(framedAlpha) / Math.tan(halfV)) * (size.height / 2),
  };
}

/**
 * Framing that keeps a fitted model clear of a top-right corner gizmo. The
 * model's centre moves straight away from the gizmo's centre (down-left) just
 * far enough for the gap; only if the left or bottom edge stops that does the
 * model shrink, by the least amount that makes it fit. Returns
 * UNADJUSTED_FRAMING when the normal fit is already clear.
 */
export function compactViewerFraming(size: ViewportSize, options: CompactFramingOptions): ViewerFraming {
  const { width, height } = size;
  if (!(width > 0 && height > 0)) return UNADJUSTED_FRAMING;
  const { fovDeg, padding, gizmo, gapPx, edgePx } = options;
  const minScale = options.minScale ?? 0.5;

  const radius = fittedSphereScreenRadius(size, fovDeg, padding);
  const centerX = width / 2;
  const centerY = height / 2;
  const gizmoX = width - gizmo.marginX;
  const gizmoY = gizmo.marginY;
  const clearance = gizmo.radiusPx + gapPx;

  let awayX = centerX - gizmoX;
  let awayY = centerY - gizmoY;
  const startDistance = Math.hypot(awayX, awayY);
  if (startDistance >= radius + clearance) return UNADJUSTED_FRAMING;
  if (startDistance > 1e-9) {
    awayX /= startDistance;
    awayY /= startDistance;
  } else {
    awayX = -Math.SQRT1_2;
    awayY = Math.SQRT1_2;
  }

  // Shifting by s along `away` keeps the silhouette (radius k·r) inside the
  // left and bottom edges while s <= (room - k·r) / component. Moving away
  // from a top-right gizmo, the right and top edges only get farther.
  const limits: Array<{ room: number; component: number }> = [];
  if (awayX < -1e-9) limits.push({ room: centerX - edgePx, component: -awayX });
  if (awayY > 1e-9) limits.push({ room: height - edgePx - centerY, component: awayY });
  const maxShift = (scale: number) => limits.reduce(
    (shift, { room, component }) => Math.min(shift, (room - scale * radius) / component),
    Infinity,
  );

  // Largest scale k <= 1 with startDistance + maxShift(k) >= k·r + clearance.
  // Each limit is linear in k, so solve each and keep the smallest.
  let scale = 1;
  for (const { room, component } of limits) {
    const k = (startDistance - clearance + room / component) / (radius * (1 + 1 / component));
    scale = Math.min(scale, k);
  }
  scale = Math.max(minScale, Math.min(1, scale));

  const shift = Math.max(0, Math.min(scale * radius + clearance - startDistance, maxShift(scale)));

  // A smaller silhouette means a farther camera: tan(α') = k·tan(α), d ∝ 1/sin(α).
  const alpha = fittedAngularRadius(size, fovDeg, padding);
  const scaledAlpha = Math.atan(scale * Math.tan(alpha));
  const distanceScale = scale < 1 ? Math.sin(alpha) / Math.sin(scaledAlpha) : 1;

  return { offsetX: awayX * shift, offsetY: awayY * shift, distanceScale };
}
