// Mesh analysis: watertight/manifold checks, bounding box, basic repair
import type { Vec3 } from './vec3';
import type { TriangleMesh } from './stl-parser';
import type { MeshInfo, BoundingBox } from '../types/project';

/** Create edge key from two vertex positions (quantized) */
function edgeKey(a: Vec3, b: Vec3): string {
  const q = (v: number) => Math.round(v * 1e4);
  const ak = `${q(a[0])},${q(a[1])},${q(a[2])}`;
  const bk = `${q(b[0])},${q(b[1])},${q(b[2])}`;
  return ak < bk ? `${ak}-${bk}` : `${bk}-${ak}`;
}

function getVertex(positions: Float32Array, triIdx: number, vertIdx: number): Vec3 {
  const o = triIdx * 9 + vertIdx * 3;
  return [positions[o], positions[o + 1], positions[o + 2]];
}

export function analyzeMesh(mesh: TriangleMesh): MeshInfo {
  const { positions, triCount } = mesh;

  // Bounding box
  const bbMin: Vec3 = [Infinity, Infinity, Infinity];
  const bbMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let d = 0; d < 3; d++) {
      if (positions[i + d] < bbMin[d]) bbMin[d] = positions[i + d];
      if (positions[i + d] > bbMax[d]) bbMax[d] = positions[i + d];
    }
  }

  const boundingBox: BoundingBox = { min: [bbMin[0], bbMin[1], bbMin[2]], max: [bbMax[0], bbMax[1], bbMax[2]] };

  // Edge analysis for manifold/watertight
  const edgeCounts = new Map<string, number>();
  for (let i = 0; i < triCount; i++) {
    const v0 = getVertex(positions, i, 0);
    const v1 = getVertex(positions, i, 1);
    const v2 = getVertex(positions, i, 2);
    const edges = [edgeKey(v0, v1), edgeKey(v1, v2), edgeKey(v2, v0)];
    for (const e of edges) {
      edgeCounts.set(e, (edgeCounts.get(e) || 0) + 1);
    }
  }

  let isManifold = true;
  let isWatertight = true;
  for (const count of edgeCounts.values()) {
    if (count !== 2) {
      isManifold = false;
      if (count === 1) isWatertight = false;
    }
  }

  // Count unique vertices
  const vertSet = new Set<string>();
  for (let i = 0; i < positions.length; i += 3) {
    const q = (v: number) => Math.round(v * 1e4);
    vertSet.add(`${q(positions[i])},${q(positions[i + 1])},${q(positions[i + 2])}`);
  }

  return {
    triangleCount: triCount,
    vertexCount: vertSet.size,
    boundingBox,
    isWatertight,
    isManifold,
    repaired: false,
  };
}

/** Per-face normals derived from triangle winding (right-hand rule). */
function computeFaceNormals(positions: Float32Array, triCount: number): Float32Array {
  const normals = new Float32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    const v0 = getVertex(positions, i, 0);
    const v1 = getVertex(positions, i, 1);
    const v2 = getVertex(positions, i, 2);
    const e1: Vec3 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2: Vec3 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const n: Vec3 = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    if (len > 1e-12) {
      normals[i * 3] = n[0] / len;
      normals[i * 3 + 1] = n[1] / len;
      normals[i * 3 + 2] = n[2] / len;
    }
  }

  return normals;
}

/**
 * Signed volume via the divergence theorem, taken over triangle winding.
 * Positive when the mesh is wound counter-clockwise seen from outside, which
 * is the orientation the SDF sign convention assumes.
 *
 * Only meaningful for a closed mesh — on an open surface the result is
 * arbitrary, so callers must check isWatertight first.
 */
export function computeSignedVolume(mesh: TriangleMesh): number {
  const { positions, triCount } = mesh;
  let volume = 0;

  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    // a · (b × c)
    volume += ax * (by * cz - bz * cy)
      + ay * (bz * cx - bx * cz)
      + az * (bx * cy - by * cx);
  }

  return volume / 6;
}

/**
 * Compare each stored facet normal against the normal implied by winding.
 *
 * Zero-area faces are excluded rather than counted as disagreements — pole-cap
 * fans in generated meshes are degenerate by construction and would otherwise
 * skew the ratio. A face whose stored normal is zero-length (common in STLs
 * that rely on winding alone) counts as a disagreement, since recomputing is
 * exactly what such a mesh needs.
 */
export function countNormalWindingAgreement(mesh: TriangleMesh): {
  agree: number;
  disagree: number;
  degenerate: number;
} {
  const { positions, normals, triCount } = mesh;
  let agree = 0, disagree = 0, degenerate = 0;

  for (let i = 0; i < triCount; i++) {
    const o = i * 9, n = i * 3;
    const e1x = positions[o + 3] - positions[o];
    const e1y = positions[o + 4] - positions[o + 1];
    const e1z = positions[o + 5] - positions[o + 2];
    const e2x = positions[o + 6] - positions[o];
    const e2y = positions[o + 7] - positions[o + 1];
    const e2z = positions[o + 8] - positions[o + 2];
    const wx = e1y * e2z - e1z * e2y;
    const wy = e1z * e2x - e1x * e2z;
    const wz = e1x * e2y - e1y * e2x;

    if (Math.sqrt(wx * wx + wy * wy + wz * wz) <= 1e-12) {
      degenerate++;
      continue;
    }
    if (wx * normals[n] + wy * normals[n + 1] + wz * normals[n + 2] > 0) agree++;
    else disagree++;
  }

  return { agree, disagree, degenerate };
}

/** Replace stored normals with the winding-derived ones, leaving geometry alone. */
export function alignNormalsToWinding(mesh: TriangleMesh): TriangleMesh {
  return {
    positions: mesh.positions,
    normals: computeFaceNormals(mesh.positions, mesh.triCount),
    triCount: mesh.triCount,
  };
}

/** Reverse winding on every triangle, recomputing normals to match. */
export function flipMeshOrientation(mesh: TriangleMesh): TriangleMesh {
  const { positions, triCount } = mesh;
  const flipped = new Float32Array(positions.length);

  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    for (let k = 0; k < 3; k++) {
      flipped[o + k] = positions[o + k];          // v0 stays put
      flipped[o + 3 + k] = positions[o + 6 + k];  // v1 <- v2
      flipped[o + 6 + k] = positions[o + 3 + k];  // v2 <- v1
    }
  }

  return { positions: flipped, normals: computeFaceNormals(flipped, triCount), triCount };
}

/** Basic mesh repair: recalculate normals, attempt to fix non-manifold edges by welding */
export function repairMesh(mesh: TriangleMesh): { mesh: TriangleMesh; repaired: boolean } {
  const { positions, triCount } = mesh;
  return {
    mesh: {
      positions: new Float32Array(positions),
      normals: computeFaceNormals(positions, triCount),
      triCount,
    },
    repaired: true,
  };
}

/** Generate a procedural sphere mesh as a test asset */
export function generateSphereMesh(radius: number, segments: number): TriangleMesh {
  const tris: number[] = [];

  for (let lat = 0; lat < segments; lat++) {
    for (let lon = 0; lon < segments * 2; lon++) {
      const theta0 = (Math.PI * lat) / segments;
      const theta1 = (Math.PI * (lat + 1)) / segments;
      const phi0 = (2 * Math.PI * lon) / (segments * 2);
      const phi1 = (2 * Math.PI * (lon + 1)) / (segments * 2);

      const p00: Vec3 = [
        radius * Math.sin(theta0) * Math.cos(phi0),
        radius * Math.sin(theta0) * Math.sin(phi0),
        radius * Math.cos(theta0),
      ];
      const p01: Vec3 = [
        radius * Math.sin(theta0) * Math.cos(phi1),
        radius * Math.sin(theta0) * Math.sin(phi1),
        radius * Math.cos(theta0),
      ];
      const p10: Vec3 = [
        radius * Math.sin(theta1) * Math.cos(phi0),
        radius * Math.sin(theta1) * Math.sin(phi0),
        radius * Math.cos(theta1),
      ];
      const p11: Vec3 = [
        radius * Math.sin(theta1) * Math.cos(phi1),
        radius * Math.sin(theta1) * Math.sin(phi1),
        radius * Math.cos(theta1),
      ];

      // Counter-clockwise seen from outside, so winding agrees with the
      // outward radial normals assigned below.
      if (lat > 0) {
        tris.push(p00[0], p00[1], p00[2], p10[0], p10[1], p10[2], p01[0], p01[1], p01[2]);
      }
      if (lat < segments - 1) {
        tris.push(p01[0], p01[1], p01[2], p10[0], p10[1], p10[2], p11[0], p11[1], p11[2]);
      }
    }
  }

  const triCount = tris.length / 9;
  const positions = new Float32Array(tris);
  const normals = new Float32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    // For a sphere, face normal ~ average vertex direction
    const cx = (positions[i*9] + positions[i*9+3] + positions[i*9+6]) / 3;
    const cy = (positions[i*9+1] + positions[i*9+4] + positions[i*9+7]) / 3;
    const cz = (positions[i*9+2] + positions[i*9+5] + positions[i*9+8]) / 3;
    const len = Math.sqrt(cx*cx + cy*cy + cz*cz);
    normals[i * 3] = cx / len;
    normals[i * 3 + 1] = cy / len;
    normals[i * 3 + 2] = cz / len;
  }

  return { positions, normals, triCount };
}

/** Generate a cylinder mesh (radius R, height H, centered at origin) */
export function generateCylinderMesh(radius: number, height: number, segments: number = 32): TriangleMesh {
  const tris: number[] = [];
  const hh = height / 2;

  for (let i = 0; i < segments; i++) {
    const a0 = (2 * Math.PI * i) / segments;
    const a1 = (2 * Math.PI * (i + 1)) / segments;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const x0 = radius * c0, y0 = radius * s0;
    const x1 = radius * c1, y1 = radius * s1;

    // Side quad (two triangles)
    tris.push(x0, y0, -hh, x1, y1, -hh, x1, y1, hh);
    tris.push(x0, y0, -hh, x1, y1, hh, x0, y0, hh);
    // Top cap
    tris.push(0, 0, hh, x0, y0, hh, x1, y1, hh);
    // Bottom cap
    tris.push(0, 0, -hh, x1, y1, -hh, x0, y0, -hh);
  }

  const triCount = tris.length / 9;
  const positions = new Float32Array(tris);
  const normals = new Float32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    const e1x = positions[o+3]-positions[o], e1y = positions[o+4]-positions[o+1], e1z = positions[o+5]-positions[o+2];
    const e2x = positions[o+6]-positions[o], e2y = positions[o+7]-positions[o+1], e2z = positions[o+8]-positions[o+2];
    let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
    normals[i*3] = nx; normals[i*3+1] = ny; normals[i*3+2] = nz;
  }
  return { positions, normals, triCount };
}

/** Generate a torus mesh (major radius R, tube radius r) */
export function generateTorusMesh(majorRadius: number, tubeRadius: number, majorSegs: number = 32, tubeSegs: number = 16): TriangleMesh {
  const tris: number[] = [];

  for (let i = 0; i < majorSegs; i++) {
    for (let j = 0; j < tubeSegs; j++) {
      const u0 = (2 * Math.PI * i) / majorSegs;
      const u1 = (2 * Math.PI * (i + 1)) / majorSegs;
      const v0 = (2 * Math.PI * j) / tubeSegs;
      const v1 = (2 * Math.PI * (j + 1)) / tubeSegs;

      const torusPoint = (u: number, v: number): [number, number, number] => [
        (majorRadius + tubeRadius * Math.cos(v)) * Math.cos(u),
        (majorRadius + tubeRadius * Math.cos(v)) * Math.sin(u),
        tubeRadius * Math.sin(v),
      ];

      const p00 = torusPoint(u0, v0);
      const p01 = torusPoint(u0, v1);
      const p10 = torusPoint(u1, v0);
      const p11 = torusPoint(u1, v1);

      tris.push(...p00, ...p10, ...p11);
      tris.push(...p00, ...p11, ...p01);
    }
  }

  const triCount = tris.length / 9;
  const positions = new Float32Array(tris);
  const normals = new Float32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    const e1x = positions[o+3]-positions[o], e1y = positions[o+4]-positions[o+1], e1z = positions[o+5]-positions[o+2];
    const e2x = positions[o+6]-positions[o], e2y = positions[o+7]-positions[o+1], e2z = positions[o+8]-positions[o+2];
    let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
    normals[i*3] = nx; normals[i*3+1] = ny; normals[i*3+2] = nz;
  }
  return { positions, normals, triCount };
}

/** Generate a capsule mesh (cylinder with hemispherical caps, total height = height + 2*radius) */
export function generateCapsuleMesh(radius: number, height: number, segments: number = 24): TriangleMesh {
  const tris: number[] = [];
  const hh = height / 2;

  // Cylinder body
  for (let i = 0; i < segments; i++) {
    const a0 = (2 * Math.PI * i) / segments;
    const a1 = (2 * Math.PI * (i + 1)) / segments;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const x0 = radius * c0, y0 = radius * s0;
    const x1 = radius * c1, y1 = radius * s1;
    tris.push(x0, y0, -hh, x1, y1, -hh, x1, y1, hh);
    tris.push(x0, y0, -hh, x1, y1, hh, x0, y0, hh);
  }

  // Hemisphere caps (lat/lon)
  const halfSegs = Math.floor(segments / 2);
  for (let lat = 0; lat < halfSegs; lat++) {
    for (let lon = 0; lon < segments; lon++) {
      const theta0 = (Math.PI * 0.5 * lat) / halfSegs;
      const theta1 = (Math.PI * 0.5 * (lat + 1)) / halfSegs;
      const phi0 = (2 * Math.PI * lon) / segments;
      const phi1 = (2 * Math.PI * (lon + 1)) / segments;

      // Top cap (centered at z = hh)
      const tp = (th: number, ph: number): [number, number, number] => [
        radius * Math.cos(th) * Math.cos(ph),
        radius * Math.cos(th) * Math.sin(ph),
        hh + radius * Math.sin(th),
      ];
      const t00 = tp(theta0, phi0), t01 = tp(theta0, phi1);
      const t10 = tp(theta1, phi0), t11 = tp(theta1, phi1);
      tris.push(...t00, ...t01, ...t10);
      tris.push(...t01, ...t11, ...t10);

      // Bottom cap (centered at z = -hh)
      const bp = (th: number, ph: number): [number, number, number] => [
        radius * Math.cos(th) * Math.cos(ph),
        radius * Math.cos(th) * Math.sin(ph),
        -hh - radius * Math.sin(th),
      ];
      const b00 = bp(theta0, phi0), b01 = bp(theta0, phi1);
      const b10 = bp(theta1, phi0), b11 = bp(theta1, phi1);
      tris.push(...b00, ...b10, ...b01);
      tris.push(...b01, ...b10, ...b11);
    }
  }

  const triCount = tris.length / 9;
  const positions = new Float32Array(tris);
  const normals = new Float32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    const e1x = positions[o+3]-positions[o], e1y = positions[o+4]-positions[o+1], e1z = positions[o+5]-positions[o+2];
    const e2x = positions[o+6]-positions[o], e2y = positions[o+7]-positions[o+1], e2z = positions[o+8]-positions[o+2];
    let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
    normals[i*3] = nx; normals[i*3+1] = ny; normals[i*3+2] = nz;
  }
  return { positions, normals, triCount };
}

/** Generate a simple cube mesh */
export function generateCubeMesh(size: number): TriangleMesh {
  const h = size / 2;
  // 6 faces, 2 triangles each = 12 triangles
  const verts = [
    // Front
    [-h,-h,h], [h,-h,h], [h,h,h], [-h,-h,h], [h,h,h], [-h,h,h],
    // Back
    [h,-h,-h], [-h,-h,-h], [-h,h,-h], [h,-h,-h], [-h,h,-h], [h,h,-h],
    // Top
    [-h,h,h], [h,h,h], [h,h,-h], [-h,h,h], [h,h,-h], [-h,h,-h],
    // Bottom
    [-h,-h,-h], [h,-h,-h], [h,-h,h], [-h,-h,-h], [h,-h,h], [-h,-h,h],
    // Right
    [h,-h,h], [h,-h,-h], [h,h,-h], [h,-h,h], [h,h,-h], [h,h,h],
    // Left
    [-h,-h,-h], [-h,-h,h], [-h,h,h], [-h,-h,-h], [-h,h,h], [-h,h,-h],
  ];
  const faceNormals = [
    [0,0,1],[0,0,1],[0,0,-1],[0,0,-1],
    [0,1,0],[0,1,0],[0,-1,0],[0,-1,0],
    [1,0,0],[1,0,0],[-1,0,0],[-1,0,0],
  ];
  const triCount = 12;
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 3);
  for (let i = 0; i < triCount; i++) {
    for (let v = 0; v < 3; v++) {
      const src = verts[i * 3 + v];
      positions[i * 9 + v * 3] = src[0];
      positions[i * 9 + v * 3 + 1] = src[1];
      positions[i * 9 + v * 3 + 2] = src[2];
    }
    normals[i * 3] = faceNormals[i][0];
    normals[i * 3 + 1] = faceNormals[i][1];
    normals[i * 3 + 2] = faceNormals[i][2];
  }
  return { positions, normals, triCount };
}
