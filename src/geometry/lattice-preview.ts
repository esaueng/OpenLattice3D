// Small 2D cross-sections of each lattice field, for the cell-type picker.
// Pure and deterministic: fixed parameters, the default generation seed, no DOM.
import { buildLatticeEvaluator } from './lattice';
import { DEFAULT_GENERATION_SEED } from './deterministic-random';
import { DEFAULT_PARAMS, type LatticeType } from '../types/project';
import type { Vec3 } from './vec3';

/** Pixels per side of a preview slice. */
export const LATTICE_PREVIEW_RESOLUTION = 48;

/** Cell size of the preview field (mm). The slice spans PREVIEW_CELLS cells. */
const PREVIEW_CELL_MM = 10;
const PREVIEW_CELLS = 2;

/** A slice plane: origin plus two in-plane unit axes, all in cell units. */
type SlicePlane = { origin: Vec3; u: Vec3; v: Vec3 };

const INV_SQRT2 = 1 / Math.SQRT2;
const AXIS_PLANE = (z: number): SlicePlane => ({ origin: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0] });
// A vertical plane along the (1,1,0) diagonal: it contains the body diagonals
// of a cubic cell, so diagonal struts read as struts rather than dots.
const DIAGONAL_PLANE: SlicePlane = { origin: [0, 0, 0], u: [INV_SQRT2, INV_SQRT2, 0], v: [0, 0, 1] };

// Planes chosen so each type's slice shows its characteristic pattern.
const PREVIEW_PLANES: Record<LatticeType, SlicePlane> = {
  gyroid: AXIS_PLANE(0.15),
  schwarzP: AXIS_PLANE(0.12),
  schwarzD: AXIS_PLANE(0.1),
  neovius: AXIS_PLANE(0.1),
  iwp: AXIS_PLANE(0.06),
  bcc: DIAGONAL_PLANE,
  octet: AXIS_PLANE(0),
  diamond: DIAGONAL_PLANE,
  hexagon: AXIS_PLANE(0),
  triangle: AXIS_PLANE(0),
  voronoi: AXIS_PLANE(0.5),
  spinodal: AXIS_PLANE(0.5),
};

export interface LatticeSlice {
  /** Samples per side; values is size × size, row-major, row 0 at the top. */
  size: number;
  /** Width of one sample in millimetres. */
  pixelMm: number;
  /** Signed distance (mm): negative inside material, positive in the voids. */
  values: Float32Array;
}

/**
 * Sample the lattice field of `type` on a square plane spanning two cells.
 * Uses fixed preview parameters and the default seed, so the stochastic types
 * (Voronoi, Spinodal) show the same representative pattern every time.
 */
export function latticeSlice(type: LatticeType, size = LATTICE_PREVIEW_RESOLUTION): LatticeSlice {
  const n = Math.max(2, Math.floor(size));
  const L = PREVIEW_CELL_MM;
  const evaluate = buildLatticeEvaluator({
    ...DEFAULT_PARAMS,
    latticeType: type,
    cellSize: L,
    wallThickness: 1.4,
    strutDiameter: 1.8,
  }, DEFAULT_GENERATION_SEED);
  const { origin, u, v } = PREVIEW_PLANES[type];
  const span = PREVIEW_CELLS * L;
  const pixelMm = span / n;
  const values = new Float32Array(n * n);
  for (let row = 0; row < n; row++) {
    // Row 0 is the top of the image, i.e. the far end of the v axis.
    const t = span - (row + 0.5) * pixelMm;
    for (let col = 0; col < n; col++) {
      const s = (col + 0.5) * pixelMm;
      const x = origin[0] * L + u[0] * s + v[0] * t;
      const y = origin[1] * L + u[1] * s + v[1] * t;
      const z = origin[2] * L + u[2] * s + v[2] * t;
      const d = evaluate(x, y, z);
      values[row * n + col] = Number.isFinite(d) ? d : span;
    }
  }
  return { size: n, pixelMm, values };
}

/**
 * Anti-aliased material coverage (0..255) for drawing a slice: a sample is
 * fully covered half a pixel inside the surface and empty half a pixel outside.
 * An approximation that treats the field as a distance across one pixel.
 */
export function sliceCoverage(slice: LatticeSlice): Uint8ClampedArray {
  const out = new Uint8ClampedArray(slice.values.length);
  const inv = 1 / slice.pixelMm;
  for (let i = 0; i < slice.values.length; i++) {
    const coverage = 0.5 - slice.values[i] * inv;
    out[i] = Math.round(Math.min(1, Math.max(0, coverage)) * 255);
  }
  return out;
}

/** Fraction of samples inside material (value < 0). */
export function sliceSolidFraction(slice: LatticeSlice): number {
  let inside = 0;
  for (const value of slice.values) if (value < 0) inside++;
  return inside / slice.values.length;
}
