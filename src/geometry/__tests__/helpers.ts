// Shared measurements for the geometry suite.
//
// These deliberately re-derive topology from raw triangles rather than calling
// into validation.ts, so a bug there cannot mask a bug in the mesh itself.
import type { MarchingCubesResult } from '../marching-cubes';
import type { TriangleMesh } from '../stl-parser';

/** Signed volume by the divergence theorem. Sign follows triangle winding. */
export function signedVolume(mesh: MarchingCubesResult | TriangleMesh): number {
  const { positions, triCount } = mesh;
  let volume = 0;
  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    volume += ax * (by * cz - bz * cy)
      + ay * (bz * cx - bx * cz)
      + az * (bx * cy - by * cx);
  }
  return volume / 6;
}

export interface Topology {
  /** Edges used by exactly one triangle. Any non-zero count means an open surface. */
  boundaryEdges: number;
  /** Edges used by three or more triangles. */
  nonManifoldEdges: number;
  vertexCount: number;
  edgeCount: number;
  /** Non-degenerate triangles only. */
  triangleCount: number;
  degenerateTriangles: number;
  /** V - E + F. A closed genus-0 surface gives 2 per component. */
  eulerCharacteristic: number;
}

/**
 * Topology from exact vertex identity.
 *
 * Positions are keyed on their exact bits rather than a quantised bucket: a
 * correctly welded mesh shares vertices exactly, so any tolerance here would
 * hide precisely the defect these tests exist to catch.
 */
export function analyzeTopology(mesh: MarchingCubesResult): Topology {
  const { positions, triCount } = mesh;
  const vertexIds = new Map<string, number>();
  const corners = new Int32Array(triCount * 3);

  const idFor = (o: number): number => {
    const key = `${positions[o]},${positions[o + 1]},${positions[o + 2]}`;
    let id = vertexIds.get(key);
    if (id === undefined) {
      id = vertexIds.size;
      vertexIds.set(key, id);
    }
    return id;
  };

  for (let i = 0; i < triCount; i++) {
    corners[i * 3] = idFor(i * 9);
    corners[i * 3 + 1] = idFor(i * 9 + 3);
    corners[i * 3 + 2] = idFor(i * 9 + 6);
  }

  const edgeUse = new Map<string, number>();
  let faces = 0;
  for (let i = 0; i < triCount; i++) {
    const a = corners[i * 3], b = corners[i * 3 + 1], c = corners[i * 3 + 2];
    // Degenerate triangles carry no surface. They must be excluded from the
    // face count as well as the edge count, or they inflate V - E + F.
    if (a === b || b === c || a === c) continue;
    faces++;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edgeUse.values()) {
    if (count === 1) boundaryEdges++;
    else if (count > 2) nonManifoldEdges++;
  }

  return {
    boundaryEdges,
    nonManifoldEdges,
    vertexCount: vertexIds.size,
    edgeCount: edgeUse.size,
    triangleCount: faces,
    degenerateTriangles: triCount - faces,
    eulerCharacteristic: vertexIds.size - edgeUse.size + faces,
  };
}

/** Analytic reference solids, for volume assertions. */
export const SOLIDS = {
  sphere: (r: number) => ({
    sdf: (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z) - r,
    volume: (4 / 3) * Math.PI * r ** 3,
    bounds: { min: [-r * 1.2, -r * 1.2, -r * 1.2] as [number, number, number],
              max: [r * 1.2, r * 1.2, r * 1.2] as [number, number, number] },
  }),
  cube: (h: number) => ({
    sdf: (x: number, y: number, z: number) => {
      const dx = Math.abs(x) - h, dy = Math.abs(y) - h, dz = Math.abs(z) - h;
      const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
      return outside + Math.min(Math.max(dx, dy, dz), 0);
    },
    volume: (2 * h) ** 3,
    bounds: { min: [-h * 1.4, -h * 1.4, -h * 1.4] as [number, number, number],
              max: [h * 1.4, h * 1.4, h * 1.4] as [number, number, number] },
  }),
  torus: (major: number, tube: number) => ({
    sdf: (x: number, y: number, z: number) => {
      const q = Math.sqrt(x * x + y * y) - major;
      return Math.sqrt(q * q + z * z) - tube;
    },
    volume: 2 * Math.PI ** 2 * major * tube ** 2,
    bounds: { min: [-(major + tube) * 1.2, -(major + tube) * 1.2, -tube * 2] as [number, number, number],
              max: [(major + tube) * 1.2, (major + tube) * 1.2, tube * 2] as [number, number, number] },
  }),
};
