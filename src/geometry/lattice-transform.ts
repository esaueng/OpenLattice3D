// Lattice orientation and stretched (anisotropic) cells.
//
// The lattice is defined in its own frame with cubic cells of `cellSize` mm.
// A world point p (mm) maps to the lattice cell coordinate
//
//   u = S⁻¹ · Rᵀ · p
//
// where R rotates the lattice (Euler XYZ, degrees, the three.js 'XYZ'
// convention: R = Rx · Ry · Rz) and S = diag(cellScale) stretches the cells
// along the lattice's own axes. Unit-cell geometry is evaluated at u.
//
// Distances: R is orthonormal, so a world distance |Δp| equals |S · Δu|. The
// lattice builders use that metric directly (strut, Voronoi and prism fields
// stay exact Euclidean distances in mm) or, for implicit sheets, normalise by
// the world-space gradient |S⁻¹ ∇ᵤ f| (see buildLatticeEvaluator), so wall and
// strut thickness remain in millimetres when cells are stretched.
import type { LatticeParams } from '../types/project';
import { CELL_SCALE_MAX, CELL_SCALE_MIN, LATTICE_ROTATION_LIMIT_DEG } from '../types/project';
import type { Vec3 } from './vec3';

/** Angles (deg) and scale deviations below these are treated as identity. */
const IDENTITY_ANGLE_EPS_DEG = 1e-9;
const IDENTITY_SCALE_EPS = 1e-12;

export interface LatticeTransform {
  /** Row-major 3×3 matrix taking world mm to lattice cell coordinates: u = m · p. */
  readonly m: Float64Array;
  /** Rotation matrix R (row-major); lattice axis i points along column i in world space. */
  readonly rotation: Float64Array;
  /** Per-axis cell stretch S along the lattice axes. */
  readonly scale: Vec3;
  readonly minScale: number;
  readonly maxScale: number;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Orientation entries of possibly partial or older params, with the same
 * bounds the sanitizer enforces. Missing or malformed entries fall back to
 * identity so older saved parameters keep their exact behaviour.
 */
export function normalizedLatticeOrientation(
  params: Partial<Pick<LatticeParams, 'latticeRotationDeg' | 'cellScale'>>,
): { rotationDeg: Vec3; scale: Vec3 } {
  const rot = Array.isArray(params.latticeRotationDeg) ? params.latticeRotationDeg : [];
  const scl = Array.isArray(params.cellScale) ? params.cellScale : [];
  const angle = (i: number) => Math.max(
    -LATTICE_ROTATION_LIMIT_DEG,
    Math.min(LATTICE_ROTATION_LIMIT_DEG, finiteOr(rot[i], 0)),
  );
  const stretch = (i: number) => Math.max(CELL_SCALE_MIN, Math.min(CELL_SCALE_MAX, finiteOr(scl[i], 1)));
  return {
    rotationDeg: [angle(0), angle(1), angle(2)],
    scale: [stretch(0), stretch(1), stretch(2)],
  };
}

/** Whether the params leave the lattice axis-aligned with cubic cells. */
export function isIdentityLatticeOrientation(
  params: Partial<Pick<LatticeParams, 'latticeRotationDeg' | 'cellScale'>>,
): boolean {
  const { rotationDeg, scale } = normalizedLatticeOrientation(params);
  return rotationDeg.every((a) => Math.abs(a) < IDENTITY_ANGLE_EPS_DEG)
    && scale.every((s) => Math.abs(s - 1) < IDENTITY_SCALE_EPS);
}

/** Row-major R = Rx(a) · Ry(b) · Rz(c), angles in degrees (three.js 'XYZ'). */
export function rotationMatrixXYZ(rotationDeg: Vec3): Float64Array {
  const toRad = Math.PI / 180;
  const a = rotationDeg[0] * toRad;
  const b = rotationDeg[1] * toRad;
  const c = rotationDeg[2] * toRad;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cc = Math.cos(c), sc = Math.sin(c);
  // Same expansion as three.js Matrix4.makeRotationFromEuler for order 'XYZ'.
  return new Float64Array([
    cb * cc, -cb * sc, sb,
    ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb,
    sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb,
  ]);
}

/**
 * The world → lattice transform for these params, or null at identity so
 * callers keep their untransformed (bit-identical) code paths.
 */
export function latticeTransformFor(
  params: Partial<Pick<LatticeParams, 'latticeRotationDeg' | 'cellScale'>>,
): LatticeTransform | null {
  if (isIdentityLatticeOrientation(params)) return null;
  const { rotationDeg, scale } = normalizedLatticeOrientation(params);
  const rotation = rotationMatrixXYZ(rotationDeg);
  // m = S⁻¹ · Rᵀ: row i is column i of R divided by scale i.
  const m = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) m[i * 3 + j] = rotation[j * 3 + i] / scale[i];
  }
  return {
    m,
    rotation,
    scale,
    minScale: Math.min(scale[0], scale[1], scale[2]),
    maxScale: Math.max(scale[0], scale[1], scale[2]),
  };
}
