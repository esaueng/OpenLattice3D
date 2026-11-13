// Build-plate grid sizing for the viewer: a square of major/minor lines in mm
// under the part, so a 1.2 mm cube and a 20 mm one no longer look alike.
// Display only; nothing here feeds generation or export.

export interface GridBounds {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

export interface BuildPlateGridSpec {
  /** Spacing of the labelled lines, mm. */
  major: number;
  /** Spacing of the faint subdivisions, mm (divides major exactly). */
  minor: number;
  /** Grid centre in the XY plane, snapped to the major spacing, mm. */
  center: [number, number];
  /** Half the side length of the square grid, a whole number of majors, mm. */
  halfExtent: number;
  /** Plane height: just below the part's lowest point, mm. */
  z: number;
}

/** Major lines across the grid's longer side, roughly. */
const TARGET_MAJOR_DIVISIONS = 5;
/** The grid reaches this far past the part's XY footprint. */
const FOOTPRINT_MARGIN = 1.6;
const MIN_FEATURE_MM = 1e-3;
/** Keep the grid off a flat bottom face (no z-fighting) without a visible gap. */
const PLANE_OFFSET_FRACTION = 2e-3;
/** Hard cap so a pathological footprint cannot emit thousands of lines. */
const MAX_LINES_PER_AXIS = 401;

/**
 * The largest 1-2-5 step at or below `value` (e.g. 0.36 -> 0.2, 15 -> 10).
 * Values at or below zero fall back to 1.
 */
export function niceStepAtOrBelow(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  // Tolerance for float error such as 0.3 / 0.1 = 2.9999999999999996.
  const eps = 1e-9;
  const leading = fraction + eps >= 5 ? 5 : fraction + eps >= 2 ? 2 : 1;
  return leading * base;
}

/** Subdivision for a 1-2-5 major step: 10 -> 2, 20 -> 5, 50 -> 10. */
export function minorStepFor(major: number): number {
  const exponent = Math.floor(Math.log10(major) + 1e-9);
  const leading = Math.round(major / 10 ** exponent);
  return leading === 2 ? major / 4 : major / 5;
}

export function buildPlateGridSpec(bounds: GridBounds): BuildPlateGridSpec | null {
  const values = [...bounds.min, ...bounds.max];
  if (!values.every(Number.isFinite)) return null;
  const sizeX = bounds.max[0] - bounds.min[0];
  const sizeY = bounds.max[1] - bounds.min[1];
  const sizeZ = bounds.max[2] - bounds.min[2];
  const footprint = Math.max(sizeX, sizeY, sizeZ * 0.5, MIN_FEATURE_MM);
  if (footprint <= 0) return null;

  const span = footprint * FOOTPRINT_MARGIN;
  const major = niceStepAtOrBelow(span / TARGET_MAJOR_DIVISIONS);
  const minor = minorStepFor(major);
  const centerX = Math.round((bounds.min[0] + bounds.max[0]) / 2 / major) * major;
  const centerY = Math.round((bounds.min[1] + bounds.max[1]) / 2 / major) * major;
  // Cover the footprint from the snapped centre, plus the margin.
  const reach = Math.max(
    Math.abs(bounds.max[0] - centerX),
    Math.abs(bounds.min[0] - centerX),
    Math.abs(bounds.max[1] - centerY),
    Math.abs(bounds.min[1] - centerY),
    span / 2,
  );
  const halfExtent = Math.max(1, Math.ceil(reach / major - 1e-9)) * major;
  const offset = Math.max(footprint, sizeZ) * PLANE_OFFSET_FRACTION;
  return { major, minor, center: [centerX, centerY], halfExtent, z: bounds.min[2] - offset };
}

/**
 * Line segment endpoints (x, y, z triples, two per line) for the grid, split
 * into major and minor sets. Minor lines that coincide with a major line are
 * left out so the two layers never overdraw.
 */
export function buildPlateGridLines(spec: BuildPlateGridSpec): { major: Float32Array; minor: Float32Array } {
  const { center, halfExtent, z } = spec;
  // Drop the subdivisions rather than emit an unbounded number of lines.
  const minor = (2 * halfExtent) / spec.minor + 1 > MAX_LINES_PER_AXIS ? spec.major : spec.minor;
  const steps = Math.round((2 * halfExtent) / minor);
  const majorEvery = Math.max(1, Math.round(spec.major / minor));
  const major: number[] = [];
  const minorLines: number[] = [];
  const x0 = center[0] - halfExtent;
  const x1 = center[0] + halfExtent;
  const y0 = center[1] - halfExtent;
  const y1 = center[1] + halfExtent;
  for (let i = 0; i <= steps; i++) {
    const t = -halfExtent + i * minor;
    const target = i % majorEvery === 0 ? major : minorLines;
    target.push(center[0] + t, y0, z, center[0] + t, y1, z);
    target.push(x0, center[1] + t, z, x1, center[1] + t, z);
  }
  return { major: new Float32Array(major), minor: new Float32Array(minorLines) };
}

/** "10 mm", "0.5 mm", "0.05 mm": no trailing zeros, no float noise. */
export function formatGridSpacing(mm: number): string {
  return `${Number(mm.toPrecision(3))} mm`;
}
