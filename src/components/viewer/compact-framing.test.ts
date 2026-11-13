import { describe, expect, it } from 'vitest';
import {
  UNADJUSTED_FRAMING,
  compactViewerFraming,
  fittedSphereScreenRadius,
  framedSilhouette,
  type CompactFramingOptions,
  type ViewportSize,
} from './compact-framing';

// The compact view cube as Viewer3D places it on phones.
const OPTIONS: CompactFramingOptions = {
  fovDeg: 50,
  padding: 1.2,
  gizmo: { marginX: 64, marginY: 68, radiusPx: 48 },
  gapPx: 8,
  edgePx: 8,
};

function gizmoClearance(size: ViewportSize, options = OPTIONS) {
  const framing = compactViewerFraming(size, options);
  const silhouette = framedSilhouette(size, options.fovDeg, options.padding, framing);
  const gap = Math.hypot(
    silhouette.centerX - (size.width - options.gizmo.marginX),
    silhouette.centerY - options.gizmo.marginY,
  ) - silhouette.radius - options.gizmo.radiusPx;
  return { framing, silhouette, gap };
}

describe('fittedSphereScreenRadius', () => {
  it('fills the tighter field of view, divided by the padding', () => {
    // Square viewport: sin(α) = sin(25°)/1.2.
    const radius = fittedSphereScreenRadius({ width: 400, height: 400 }, 50, 1.2);
    const alpha = Math.asin(Math.sin(25 * Math.PI / 180) / 1.2);
    expect(radius).toBeCloseTo(Math.tan(alpha) / Math.tan(25 * Math.PI / 180) * 200, 9);
    // A portrait viewport is limited by its width.
    expect(fittedSphereScreenRadius({ width: 300, height: 600 }, 50, 1.2)).toBeLessThan(150);
  });
});

describe('compactViewerFraming', () => {
  it('moves the model down-left on an iPhone 13 viewer, clear of the view cube, at full size', () => {
    const size = { width: 390, height: 365 };
    // The normal fit reaches into the cube.
    const before = framedSilhouette(size, OPTIONS.fovDeg, OPTIONS.padding, UNADJUSTED_FRAMING);
    expect(Math.hypot(before.centerX - (390 - 64), before.centerY - 68)).toBeLessThan(before.radius + 48);

    const { framing, silhouette, gap } = gizmoClearance(size);
    expect(framing.offsetX).toBeLessThan(0);
    expect(framing.offsetY).toBeGreaterThan(0);
    expect(framing.distanceScale).toBe(1);
    expect(gap).toBeGreaterThanOrEqual(OPTIONS.gapPx - 1e-6);
    // A small nudge, and the model stays inside the left and bottom edges.
    expect(Math.hypot(framing.offsetX, framing.offsetY)).toBeLessThan(40);
    expect(silhouette.centerX - silhouette.radius).toBeGreaterThanOrEqual(OPTIONS.edgePx);
    expect(silhouette.centerY + silhouette.radius).toBeLessThanOrEqual(365 - OPTIONS.edgePx);
  });

  it('leaves a viewer alone when the fitted model is already clear', () => {
    expect(compactViewerFraming({ width: 590, height: 900 }, OPTIONS)).toEqual(UNADJUSTED_FRAMING);
    expect(compactViewerFraming({ width: 0, height: 300 }, OPTIONS)).toEqual(UNADJUSTED_FRAMING);
  });

  it('pulls the camera back only when the edges leave no room to shift', () => {
    const size = { width: 300, height: 220 };
    const { framing, silhouette, gap } = gizmoClearance(size);
    expect(framing.distanceScale).toBeGreaterThan(1);
    expect(gap).toBeGreaterThanOrEqual(OPTIONS.gapPx - 1e-6);
    // Shrunk by the least amount: the silhouette touches the limiting edge.
    const leftRoom = silhouette.centerX - silhouette.radius - OPTIONS.edgePx;
    const bottomRoom = size.height - OPTIONS.edgePx - silhouette.centerY - silhouette.radius;
    expect(Math.min(leftRoom, bottomRoom)).toBeCloseTo(0, 6);
  });

  it('keeps every phone-size viewer clear of the cube unless the size floor is reached', () => {
    for (let width = 280; width < 600; width += 20) {
      for (let height = 180; height <= 900; height += 30) {
        const size = { width, height };
        const { framing, silhouette, gap } = gizmoClearance(size);
        const scale = silhouette.radius / fittedSphereScreenRadius(size, OPTIONS.fovDeg, OPTIONS.padding);
        expect(framing.distanceScale, `${width}×${height}`).toBeGreaterThanOrEqual(1);
        if (scale > 0.5 + 1e-6) expect(gap, `${width}×${height}`).toBeGreaterThanOrEqual(OPTIONS.gapPx - 1e-6);
        // Never moves toward the cube.
        expect(framing.offsetX).toBeLessThanOrEqual(0);
        expect(framing.offsetY).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is deterministic', () => {
    expect(compactViewerFraming({ width: 390, height: 365 }, OPTIONS))
      .toEqual(compactViewerFraming({ width: 390, height: 365 }, OPTIONS));
  });
});
