// Keyboard-friendly bulk face selection: pick source faces by the direction they face.
import type { TriangleMesh } from './stl-parser';
import type { Vec3 } from './vec3';

export type FaceDirection = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export const FACE_DIRECTIONS: Record<FaceDirection, { label: string; vector: Vec3 }> = {
  '+z': { label: 'Top (+Z)', vector: [0, 0, 1] },
  '-z': { label: 'Bottom (−Z)', vector: [0, 0, -1] },
  '+x': { label: 'Right (+X)', vector: [1, 0, 0] },
  '-x': { label: 'Left (−X)', vector: [-1, 0, 0] },
  '+y': { label: 'Back (+Y)', vector: [0, 1, 0] },
  '-y': { label: 'Front (−Y)', vector: [0, -1, 0] },
};

/** Default cone half-angle: catches flat faces and gently curved ones near them. */
export const DEFAULT_FACING_TOLERANCE_DEG = 30;

/**
 * Indices of triangles whose outward normal lies within `toleranceDeg` of
 * `direction`. The normal is taken from the vertex winding (the convention
 * marching cubes and repaired imports share), not the stored STL normal, which
 * many exporters leave zero or stale. Degenerate triangles are never selected.
 */
export function facesFacingDirection(
  mesh: TriangleMesh,
  direction: Vec3,
  toleranceDeg = DEFAULT_FACING_TOLERANCE_DEG,
): number[] {
  const dirLength = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(dirLength > 0) || !Number.isFinite(toleranceDeg)) return [];
  const dx = direction[0] / dirLength;
  const dy = direction[1] / dirLength;
  const dz = direction[2] / dirLength;
  const clamped = Math.min(180, Math.max(0, toleranceDeg));
  const minCos = Math.cos((clamped * Math.PI) / 180);
  const p = mesh.positions;
  const selected: number[] = [];
  for (let t = 0; t < mesh.triCount; t++) {
    const o = t * 9;
    const e1x = p[o + 3] - p[o], e1y = p[o + 4] - p[o + 1], e1z = p[o + 5] - p[o + 2];
    const e2x = p[o + 6] - p[o], e2y = p[o + 7] - p[o + 1], e2z = p[o + 8] - p[o + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const length = Math.hypot(nx, ny, nz);
    // Relative to the edge lengths, so the cutoff is scale-independent.
    const edgeScale = Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z);
    if (!(length > edgeScale * 1e-9) || !Number.isFinite(length)) continue;
    const cos = (nx * dx + ny * dy + nz * dz) / length;
    if (cos >= minCos - 1e-12) selected.push(t);
  }
  return selected;
}
