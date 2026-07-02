// Lattice generation: SDF-based approach for multiple lattice types
// TPMS: Gyroid, Schwarz P, Schwarz D, Neovius, IWP
// Strut: BCC, Octet Truss, Diamond
// Stochastic: Voronoi Foam, Spinodal Decomposition
import type { Vec3 } from './vec3';
import type { MeshBVH } from './bvh';
import type { GridSdfSampler } from './marching-cubes';
import type { LatticeParams, LatticeType } from '../types/project';

const TWO_PI = 2 * Math.PI;
const SQRT3 = Math.sqrt(3);

export type SdfFunction = ((x: number, y: number, z: number) => number) & Partial<GridSdfSampler>;
type OptimizedTpmsType = 'gyroid' | 'schwarzP' | 'schwarzD' | 'neovius' | 'iwp';

type StrutCache = {
  L: number;
  h: number;
  corners: Vec3[];
  edges: [Vec3, Vec3][];
  faceCenters: Vec3[];
  diamondBins: [Vec3, Vec3][][];
};

let strutCache: StrutCache | null = null;

// Diamond bond segments are culled per spatial bin; distances below this margin
// (relative to cell size) are exact, so the SDF zero crossing is exact for any
// strut radius below DIAMOND_CULL_MARGIN * cellSize.
const DIAMOND_CULL_MARGIN = 0.3;
const DIAMOND_BINS_PER_AXIS = 4;

/** All diamond bond segments (including periodic images from neighbouring
 *  cells) that can come within the cull margin of the unit cell, grouped
 *  into a coarse spatial grid over [0,L]^3 for fast lookup. */
function buildDiamondBins(L: number): [Vec3, Vec3][][] {
  const q = L / 4;
  const fcc: Vec3[] = [
    [0, 0, 0], [L / 2, L / 2, 0], [L / 2, 0, L / 2], [0, L / 2, L / 2],
  ];
  // Tetrahedral bond directions: an even number of negative components.
  const offsets: Vec3[] = [
    [q, q, q], [-q, -q, q], [-q, q, -q], [q, -q, -q],
  ];

  const segments: [Vec3, Vec3][] = [];
  const margin = DIAMOND_CULL_MARGIN * L;
  for (let sx = -1; sx <= 1; sx++) {
    for (let sy = -1; sy <= 1; sy++) {
      for (let sz = -1; sz <= 1; sz++) {
        for (const f of fcc) {
          for (const o of offsets) {
            const a: Vec3 = [f[0] + sx * L, f[1] + sy * L, f[2] + sz * L];
            const b: Vec3 = [a[0] + o[0], a[1] + o[1], a[2] + o[2]];
            if (Math.max(a[0], b[0]) < -margin || Math.min(a[0], b[0]) > L + margin) continue;
            if (Math.max(a[1], b[1]) < -margin || Math.min(a[1], b[1]) > L + margin) continue;
            if (Math.max(a[2], b[2]) < -margin || Math.min(a[2], b[2]) > L + margin) continue;
            segments.push([a, b]);
          }
        }
      }
    }
  }

  const n = DIAMOND_BINS_PER_AXIS;
  const binSize = L / n;
  const bins: [Vec3, Vec3][][] = Array.from({ length: n * n * n }, () => []);
  const axisDist = (lo: number, hi: number, segLo: number, segHi: number) => {
    if (segHi < lo) return lo - segHi;
    if (segLo > hi) return segLo - hi;
    return 0;
  };
  for (let bz = 0; bz < n; bz++) {
    for (let by = 0; by < n; by++) {
      for (let bx = 0; bx < n; bx++) {
        const bin = bins[bx + by * n + bz * n * n];
        for (const seg of segments) {
          const [a, b] = seg;
          const dx = axisDist(bx * binSize, (bx + 1) * binSize, Math.min(a[0], b[0]), Math.max(a[0], b[0]));
          const dy = axisDist(by * binSize, (by + 1) * binSize, Math.min(a[1], b[1]), Math.max(a[1], b[1]));
          const dz = axisDist(bz * binSize, (bz + 1) * binSize, Math.min(a[2], b[2]), Math.max(a[2], b[2]));
          if (dx * dx + dy * dy + dz * dz <= margin * margin) bin.push(seg);
        }
      }
    }
  }
  return bins;
}

function supportsOptimizedTpms(t: LatticeType): t is OptimizedTpmsType {
  return t === 'gyroid' || t === 'schwarzP' || t === 'schwarzD' || t === 'neovius' || t === 'iwp';
}

function getStrutCache(L: number): StrutCache {
  if (strutCache && strutCache.L === L) return strutCache;
  const h = L / 2;
  const corners: Vec3[] = [
    [0, 0, 0], [L, 0, 0], [0, L, 0], [L, L, 0],
    [0, 0, L], [L, 0, L], [0, L, L], [L, L, L],
  ];
  const edges: [Vec3, Vec3][] = [
    [[0, 0, 0], [L, 0, 0]], [[0, L, 0], [L, L, 0]], [[0, 0, L], [L, 0, L]], [[0, L, L], [L, L, L]],
    [[0, 0, 0], [0, L, 0]], [[L, 0, 0], [L, L, 0]], [[0, 0, L], [0, L, L]], [[L, 0, L], [L, L, L]],
    [[0, 0, 0], [0, 0, L]], [[L, 0, 0], [L, 0, L]], [[0, L, 0], [0, L, L]], [[L, L, 0], [L, L, L]],
  ];
  const faceCenters: Vec3[] = [
    [h, h, 0], [h, 0, h], [0, h, h], [h, h, L], [h, L, h], [L, h, h],
  ];

  strutCache = { L, h, corners, edges, faceCenters, diamondBins: buildDiamondBins(L) };
  return strutCache;
}

// ═══════════════════════════════════════════════════════════
//  Strut Lattice Functions
//  All return distance-to-nearest-strut minus radius
// ═══════════════════════════════════════════════════════════

/** BCC strut lattice: center-to-corner + edge struts */
export function bccStrutSDF(x: number, y: number, z: number, cellSize: number, strutDiameter: number): number {
  const r = strutDiameter / 2;
  const L = cellSize;
  const { corners, edges } = getStrutCache(L);
  const lx = ((x % L) + L) % L;
  const ly = ((y % L) + L) % L;
  const lz = ((z % L) + L) % L;

  const center: Vec3 = [L/2, L/2, L/2];

  let minDist = Infinity;
  for (const corner of corners) {
    const d = distToSegment([lx, ly, lz], center, corner);
    if (d < minDist) minDist = d;
  }
  // Edge struts
  for (const [a, b] of edges) {
    const d = distToSegment([lx,ly,lz], a, b);
    if (d < minDist) minDist = d;
  }
  return minDist - r;
}

/** Octet Truss (FCC): face-centre nodes connected to corner nodes.
 *  The stiffest periodic strut lattice at low density. Nearly isotropic. */
export function octetSDF(x: number, y: number, z: number, cellSize: number, strutDiameter: number): number {
  const r = strutDiameter / 2;
  const L = cellSize;
  const { h, corners, faceCenters } = getStrutCache(L);
  const lx = ((x % L) + L) % L;
  const ly = ((y % L) + L) % L;
  const lz = ((z % L) + L) % L;

  let minDist = Infinity;
  const p: Vec3 = [lx, ly, lz];

  // Each face centre connects to its 4 adjacent corners
  // +X face (L,h,h): corners with x=L
  for (const fc of faceCenters) {
    for (const cn of corners) {
      // A face centre at (fx,fy,fz) connects to corner (cx,cy,cz) if they
      // share two coordinates within h of each other — i.e. they're on the
      // same face of the cube.
      const dx = Math.abs(fc[0] - cn[0]);
      const dy = Math.abs(fc[1] - cn[1]);
      const dz = Math.abs(fc[2] - cn[2]);
      if (dx <= h && dy <= h && dz <= h) {
        const d = distToSegment(p, fc, cn);
        if (d < minDist) minDist = d;
      }
    }
  }
  return minDist - r;
}

/** Diamond strut lattice: two interpenetrating FCC lattices offset by (L/4,L/4,L/4).
 *  Each node has 4 tetrahedral neighbours. Isotropic, self-supporting for 3D printing.
 *  Bonds reaching across cell boundaries are handled via precomputed periodic
 *  images, so the field is seamless under tiling. */
export function diamondStrutSDF(x: number, y: number, z: number, cellSize: number, strutDiameter: number): number {
  const r = strutDiameter / 2;
  const L = cellSize;
  const { diamondBins } = getStrutCache(L);
  const lx = ((x % L) + L) % L;
  const ly = ((y % L) + L) % L;
  const lz = ((z % L) + L) % L;

  const n = DIAMOND_BINS_PER_AXIS;
  const binOf = (v: number) => Math.min(n - 1, Math.floor((v / L) * n));
  const bin = diamondBins[binOf(lx) + binOf(ly) * n + binOf(lz) * n * n];

  let minDist = Infinity;
  const p: Vec3 = [lx, ly, lz];
  for (const [a, b] of bin) {
    const d = distToSegment(p, a, b);
    if (d < minDist) minDist = d;
  }
  return minDist - r;
}

// ═══════════════════════════════════════════════════════════
//  Stochastic Lattice Functions
// ═══════════════════════════════════════════════════════════

/** Voronoi foam: F2-F1 technique with hashed cell sites */
export function voronoiSDF(x: number, y: number, z: number, cellSize: number, strutDiameter: number): number {
  const r = strutDiameter / 2;
  const invL = 1 / cellSize;
  const ix = Math.floor(x * invL);
  const iy = Math.floor(y * invL);
  const iz = Math.floor(z * invL);

  let f1 = Infinity;
  let f2 = Infinity;

  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const jx = hash3f(cx, cy, cz, 0);
        const jy = hash3f(cx, cy, cz, 1);
        const jz = hash3f(cx, cy, cz, 2);
        const sx = (cx + jx) * cellSize;
        const sy = (cy + jy) * cellSize;
        const sz = (cz + jz) * cellSize;
        const ddx = x - sx, ddy = y - sy, ddz = z - sz;
        const d = Math.sqrt(ddx*ddx + ddy*ddy + ddz*ddz);
        if (d < f1) { f2 = f1; f1 = d; }
        else if (d < f2) { f2 = d; }
      }
    }
  }
  return (f2 - f1) * 0.5 - r;
}

// Spinodal wave count: controls quality (more = smoother). The wave set is
// deterministic, derived from hashed indices in buildLatticeEvaluator.
const N_WAVES = 64;

// ═══════════════════════════════════════════════════════════
//  2D Lattice Helpers (extruded to 3D)
// ═══════════════════════════════════════════════════════════

function distToSegment2D(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby + 1e-20)));
  const dx = ax + t * abx - px;
  const dy = ay + t * aby - py;
  return Math.sqrt(dx * dx + dy * dy);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len < 1e-8) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function estimateNormal(
  sdf: (x: number, y: number, z: number) => number,
  x: number,
  y: number,
  z: number,
  eps: number
): Vec3 {
  const dx = sdf(x + eps, y, z) - sdf(x - eps, y, z);
  const dy = sdf(x, y + eps, z) - sdf(x, y - eps, z);
  const dz = sdf(x, y, z + eps) - sdf(x, y, z - eps);
  return normalize([dx, dy, dz]);
}

function conformalCoords(
  sdf: (x: number, y: number, z: number) => number,
  x: number,
  y: number,
  z: number,
  dObj: number,
  cellSize: number
): Vec3 {
  const eps = Math.max(0.05, cellSize * 0.02);
  const n = estimateNormal(sdf, x, y, z, eps);
  const up: Vec3 = Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  const t1 = normalize(cross(up, n));
  const t2 = cross(n, t1);
  const px = x - n[0] * dObj;
  const py = y - n[1] * dObj;
  const pz = z - n[2] * dObj;
  const projectedU = dot([px, py, pz], t1);
  const projectedV = dot([px, py, pz], t2);
  const pLen = Math.sqrt(px * px + py * py + pz * pz);
  if (pLen > 1e-6) {
    const align = Math.abs((px / pLen) * n[0] + (py / pLen) * n[1] + (pz / pLen) * n[2]);
    if (align > 0.95) {
      const ax = Math.abs(n[0]);
      const ay = Math.abs(n[1]);
      const az = Math.abs(n[2]);
      if (ax >= ay && ax >= az) {
        return [py, pz, dObj];
      }
      if (ay >= ax && ay >= az) {
        return [px, pz, dObj];
      }
      return [px, py, dObj];
    }
  }
  return [projectedU, projectedV, dObj];
}

// Unit-circle vertices for regular polygons, cached per side count. Polygon
// SDFs are evaluated per sample point, so vertex tables must not be rebuilt
// inside the distance functions.
const unitPolygonVertexCache = new Map<number, ReadonlyArray<readonly [number, number]>>();

function unitPolygonVertices(sides: number): ReadonlyArray<readonly [number, number]> {
  let verts = unitPolygonVertexCache.get(sides);
  if (!verts) {
    verts = Array.from({ length: sides }, (_, i) => {
      const angle = (TWO_PI / sides) * i;
      return [Math.cos(angle), Math.sin(angle)] as const;
    });
    unitPolygonVertexCache.set(sides, verts);
  }
  return verts;
}

function sdRegularPolygon2D(px: number, py: number, radius: number, sides: number): number {
  const verts = unitPolygonVertices(sides);
  let minDist = Infinity;
  let inside = true;

  for (let i = 0; i < verts.length; i++) {
    const ax = verts[i][0] * radius;
    const ay = verts[i][1] * radius;
    const next = verts[(i + 1) % verts.length];
    const bx = next[0] * radius;
    const by = next[1] * radius;
    const edgeCross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (edgeCross < 0) inside = false;
    const d = distToSegment2D(px, py, ax, ay, bx, by);
    if (d < minDist) minDist = d;
  }

  return inside ? -minDist : minDist;
}

function sdHexagon2D(px: number, py: number, radius: number): number {
  return sdRegularPolygon2D(px, py, radius, 6);
}

function hexCellCenter(x: number, y: number, side: number): [number, number] {
  const hexRadius = Math.cos(Math.PI / 6) * side;
  const hexWidth = 2 * hexRadius;
  const verticalSpacing = 1.5 * side;

  const approxRow = Math.round(y / verticalSpacing);
  const baseOffset = (approxRow % 2) * hexRadius;
  const approxCol = Math.round((x - baseOffset) / hexWidth);

  let bestX = 0;
  let bestY = 0;
  let bestDist = Infinity;

  for (let row = approxRow - 1; row <= approxRow + 1; row++) {
    const rowOffset = (row % 2) * hexRadius;
    for (let col = approxCol - 1; col <= approxCol + 1; col++) {
      const cx = col * hexWidth + rowOffset;
      const cy = row * verticalSpacing;
      const dx = x - cx;
      const dy = y - cy;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestX = cx;
        bestY = cy;
      }
    }
  }

  return [bestX, bestY];
}

export function hexagonPrismSDF(x: number, y: number, z: number, cellSize: number, strutDiameter: number): number {
  const r = strutDiameter / 2;
  const side = cellSize / SQRT3;
  const [cx, cy] = hexCellCenter(x, y, side);
  const lx = x - cx;
  const ly = y - cy;
  const d = Math.abs(sdHexagon2D(lx, ly, side));
  return d - r;
}

export function trianglePrismSDF(x: number, y: number, z: number, cellSize: number, strutDiameter: number): number {
  const r = strutDiameter / 2;
  const spacing = cellSize * SQRT3 / 2;
  const n0 = [0, 1];
  const n1 = [-SQRT3 / 2, 0.5];
  const n2 = [SQRT3 / 2, 0.5];

  const distFamily = (nx: number, ny: number) => {
    const proj = x * nx + y * ny;
    const m = ((proj % spacing) + spacing) % spacing;
    return Math.min(m, spacing - m);
  };

  const d = Math.min(distFamily(n0[0], n0[1]), distFamily(n1[0], n1[1]), distFamily(n2[0], n2[1]));
  return d - r;
}

// ═══════════════════════════════════════════════════════════
//  Hash / Helper Functions
// ═══════════════════════════════════════════════════════════

/** Deterministic float hash for 3-int input + component selector. Returns [0.1, 0.9]. */
function hash3f(x: number, y: number, z: number, comp: number): number {
  let h = x * 374761393 + y * 668265263 + z * 1274126177 + comp * 1911520717;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h & 0x7fffffff) / 0x7fffffff) * 0.8 + 0.1;
}

/** Deterministic float hash from (index, component). Returns [0, 1). */
function hashF(index: number, comp: number): number {
  let h = index * 1597334677 + comp * 3812015801;
  h = (h ^ (h >> 13)) * 2654435761;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

/** Distance from point p to line segment ab */
function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b[0]-a[0], aby = b[1]-a[1], abz = b[2]-a[2];
  const apx = p[0]-a[0], apy = p[1]-a[1], apz = p[2]-a[2];
  const t = Math.max(0, Math.min(1,
    (apx*abx + apy*aby + apz*abz) / (abx*abx + aby*aby + abz*abz + 1e-20)
  ));
  const cx = a[0]+t*abx - p[0];
  const cy = a[1]+t*aby - p[1];
  const cz = a[2]+t*abz - p[2];
  return Math.sqrt(cx*cx + cy*cy + cz*cz);
}

/** Smooth minimum (polynomial) for blending SDFs */
export function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h*h*h*k*(1/6);
}

// ═══════════════════════════════════════════════════════════
//  Unified lattice evaluator
// ═══════════════════════════════════════════════════════════

// TPMS sheet lattices return |f(p)| - c where c sets wall thickness, scaled to
// each field's value range (gyroid ±1.5, schwarz P ±3, schwarz D ±1.4,
// neovius ±13, IWP ±5). Strut lattices return distance-to-nearest-strut - r.
function buildLatticeEvaluator(params: LatticeParams): (x: number, y: number, z: number) => number {
  const { latticeType, cellSize, wallThickness, strutDiameter } = params;
  switch (latticeType) {
    // Gyroid: sin(kx)cos(ky) + sin(ky)cos(kz) + sin(kz)cos(kx)
    case 'gyroid': {
      const k = TWO_PI / cellSize;
      const c = wallThickness * Math.PI / cellSize;
      return (x, y, z) => {
        const kx = k * x;
        const ky = k * y;
        const kz = k * z;
        const val = Math.sin(kx) * Math.cos(ky)
          + Math.sin(ky) * Math.cos(kz)
          + Math.sin(kz) * Math.cos(kx);
        return Math.abs(val) - c;
      };
    }
    case 'schwarzP': {
      const k = TWO_PI / cellSize;
      const c = wallThickness * Math.PI / cellSize;
      return (x, y, z) => {
        const val = Math.cos(k * x) + Math.cos(k * y) + Math.cos(k * z);
        return Math.abs(val) - c * 3;
      };
    }
    case 'schwarzD': {
      const k = TWO_PI / cellSize;
      const c = wallThickness * Math.PI / cellSize;
      return (x, y, z) => {
        const sx = Math.sin(k * x), sy = Math.sin(k * y), sz = Math.sin(k * z);
        const cx = Math.cos(k * x), cy = Math.cos(k * y), cz = Math.cos(k * z);
        const val = sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz;
        return Math.abs(val) - c * 1.4;
      };
    }
    case 'neovius': {
      const k = TWO_PI / cellSize;
      const c = wallThickness * Math.PI / cellSize;
      return (x, y, z) => {
        const cx = Math.cos(k * x), cy = Math.cos(k * y), cz = Math.cos(k * z);
        const val = 3 * (cx + cy + cz) + 4 * cx * cy * cz;
        return Math.abs(val) - c * 13;
      };
    }
    case 'iwp': {
      const k = TWO_PI / cellSize;
      const k2 = 2 * k;
      const c = wallThickness * Math.PI / cellSize;
      return (x, y, z) => {
        const cx = Math.cos(k * x), cy = Math.cos(k * y), cz = Math.cos(k * z);
        const val = 2 * (cx * cy + cy * cz + cz * cx)
          - (Math.cos(k2 * x) + Math.cos(k2 * y) + Math.cos(k2 * z));
        return Math.abs(val) - c * 5;
      };
    }
    case 'spinodal': {
      const k0 = TWO_PI / cellSize;
      const waves = Array.from({ length: N_WAVES }, (_, i) => {
        const phi = TWO_PI * hashF(i, 0);
        const cosTheta = 1 - 2 * hashF(i, 1);
        const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
        return {
          kx: k0 * sinTheta * Math.cos(phi),
          ky: k0 * sinTheta * Math.sin(phi),
          kz: k0 * cosTheta,
          phase: TWO_PI * hashF(i, 2),
        };
      });
      const c = wallThickness * 0.6 / cellSize;
      return (x, y, z) => {
        let sum = 0;
        for (let i = 0; i < waves.length; i++) {
          const w = waves[i];
          sum += Math.cos(w.kx * x + w.ky * y + w.kz * z + w.phase);
        }
        sum /= Math.sqrt(N_WAVES);
        return Math.abs(sum) - c * 2;
      };
    }
    case 'bcc':
      return (x, y, z) => bccStrutSDF(x, y, z, cellSize, strutDiameter);
    case 'octet':
      return (x, y, z) => octetSDF(x, y, z, cellSize, strutDiameter);
    case 'diamond':
      return (x, y, z) => diamondStrutSDF(x, y, z, cellSize, strutDiameter);
    case 'hexagon':
      return (x, y, z) => hexagonPrismSDF(x, y, z, cellSize, strutDiameter);
    case 'triangle':
      return (x, y, z) => trianglePrismSDF(x, y, z, cellSize, strutDiameter);
    case 'voronoi':
      return (x, y, z) => voronoiSDF(x, y, z, cellSize, strutDiameter);
  }
}

/** Whether a lattice type uses wallThickness (TPMS/sheet) vs strutDiameter (strut) */
export function isSheetType(t: LatticeType): boolean {
  return t === 'gyroid' || t === 'schwarzP' || t === 'schwarzD'
    || t === 'neovius' || t === 'iwp' || t === 'spinodal';
}

function tpmsValueFromTrig(
  latticeType: OptimizedTpmsType,
  sx: number,
  sy: number,
  sz: number,
  cx: number,
  cy: number,
  cz: number,
  c2x: number,
  c2y: number,
  c2z: number,
  c: number
): number {
  switch (latticeType) {
    case 'gyroid': {
      const val = sx * cy + sy * cz + sz * cx;
      return Math.abs(val) - c;
    }
    case 'schwarzP': {
      const val = cx + cy + cz;
      return Math.abs(val) - c * 3;
    }
    case 'schwarzD': {
      const val = sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz;
      return Math.abs(val) - c * 1.4;
    }
    case 'neovius': {
      const val = 3 * (cx + cy + cz) + 4 * cx * cy * cz;
      return Math.abs(val) - c * 13;
    }
    case 'iwp': {
      const val = 2 * (cx * cy + cy * cz + cz * cx) - (c2x + c2y + c2z);
      return Math.abs(val) - c * 5;
    }
  }
}

function combinedLatticeSdfValue(
  dObj: number,
  lat: number,
  params: LatticeParams,
  blendK: number,
  useShellOffsetForDefaultGradient: boolean
): number {
  const { shellThickness, noShell, surfaceOnly, surfaceDepth, cellSize, gradientEnabled, gradientStrength, variant } = params;
  let adjustedLat = lat;
  if (gradientEnabled) {
    const gd = (noShell || surfaceOnly || (variant !== 'shell_core' && !useShellOffsetForDefaultGradient))
      ? Math.max(0, -dObj)
      : Math.max(0, -(dObj + shellThickness));
    adjustedLat *= 1.0 - gradientStrength * Math.exp(-gd / (cellSize * 3));
  }

  if (surfaceOnly) return Math.max(adjustedLat, Math.max(dObj, -(dObj + surfaceDepth)));
  if (noShell) return Math.max(adjustedLat, dObj);

  const shellSdf = Math.max(dObj, -(dObj + shellThickness));
  if (variant === 'shell_core') {
    const coreSdf = -(dObj + shellThickness);
    return smoothMin(shellSdf, Math.max(-coreSdf, adjustedLat), blendK);
  }
  return smoothMin(shellSdf, Math.max(adjustedLat, dObj), blendK);
}

function attachTpmsGridSampler(
  target: SdfFunction,
  objectSdf: (x: number, y: number, z: number) => number,
  params: LatticeParams,
  blendK: number,
  useShellOffsetForDefaultGradient: boolean
): SdfFunction {
  if (!supportsOptimizedTpms(params.latticeType)) return target;

  const latticeType = params.latticeType;
  const k = TWO_PI / params.cellSize;
  const k2 = 2 * k;
  const c = params.wallThickness * Math.PI / params.cellSize;

  target.sampleField = (bounds, resolution, out, onProgress) => {
    const count = resolution + 1;
    const strideY = count;
    const strideZ = count * count;
    const minX = bounds.min[0];
    const minY = bounds.min[1];
    const minZ = bounds.min[2];
    const dx = (bounds.max[0] - minX) / resolution;
    const dy = (bounds.max[1] - minY) / resolution;
    const dz = (bounds.max[2] - minZ) / resolution;

    const sinX = new Float64Array(count);
    const cosX = new Float64Array(count);
    const sinY = new Float64Array(count);
    const cosY = new Float64Array(count);
    const sinZ = new Float64Array(count);
    const cosZ = new Float64Array(count);
    const cos2X = latticeType === 'iwp' ? new Float64Array(count) : null;
    const cos2Y = latticeType === 'iwp' ? new Float64Array(count) : null;
    const cos2Z = latticeType === 'iwp' ? new Float64Array(count) : null;

    for (let i = 0; i < count; i++) {
      const x = minX + i * dx;
      const y = minY + i * dy;
      const z = minZ + i * dz;
      sinX[i] = Math.sin(k * x);
      cosX[i] = Math.cos(k * x);
      sinY[i] = Math.sin(k * y);
      cosY[i] = Math.cos(k * y);
      sinZ[i] = Math.sin(k * z);
      cosZ[i] = Math.cos(k * z);
      if (cos2X && cos2Y && cos2Z) {
        cos2X[i] = Math.cos(k2 * x);
        cos2Y[i] = Math.cos(k2 * y);
        cos2Z[i] = Math.cos(k2 * z);
      }
    }

    for (let z = 0; z < count; z++) {
      if (onProgress) onProgress(z / resolution);
      const pz = minZ + z * dz;
      const sz = sinZ[z];
      const cz = cosZ[z];
      const c2z = cos2Z ? cos2Z[z] : 0;
      for (let y = 0; y < count; y++) {
        const py = minY + y * dy;
        const sy = sinY[y];
        const cy = cosY[y];
        const c2y = cos2Y ? cos2Y[y] : 0;
        const rowOffset = y * strideY + z * strideZ;
        for (let x = 0; x < count; x++) {
          const px = minX + x * dx;
          const lat = tpmsValueFromTrig(
            latticeType,
            sinX[x],
            sy,
            sz,
            cosX[x],
            cy,
            cz,
            cos2X ? cos2X[x] : 0,
            c2y,
            c2z,
            c
          );
          out[rowOffset + x] = combinedLatticeSdfValue(
            objectSdf(px, py, pz),
            lat,
            params,
            blendK,
            useShellOffsetForDefaultGradient
          );
        }
      }
    }
  };

  return target;
}

// ═══════════════════════════════════════════════════════════
//  Combined SDF builders
// ═══════════════════════════════════════════════════════════

// Note: keep-out triangle selection does not alter the combined SDF; it only
// affects surface hex/triangle hole placement, which callers handle by
// filtering the surface samples they pass to buildSurfaceHexLattice.
export interface LatticeSdfOptions {
  bvh: MeshBVH;
  params: LatticeParams;
}

export interface SurfaceHexSample {
  pos: Vec3;
  normal: Vec3;
  holeScale?: number;
}

type SpatialHash = Map<string, SurfaceHexSample[]>;

function hashCell(p: Vec3, cellSize: number): string {
  return `${Math.floor(p[0] / cellSize)},${Math.floor(p[1] / cellSize)},${Math.floor(p[2] / cellSize)}`;
}

function buildSpatialHash(samples: SurfaceHexSample[], cellSize: number): SpatialHash {
  const grid: SpatialHash = new Map();
  for (const sample of samples) {
    const key = hashCell(sample.pos, cellSize);
    const bucket = grid.get(key);
    if (bucket) bucket.push(sample);
    else grid.set(key, [sample]);
  }
  return grid;
}

function basisFromNormal(n: Vec3): { t: Vec3; b: Vec3; n: Vec3 } {
  const normal = normalize(n);
  const ref: Vec3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t = normalize(cross(ref, normal));
  const b = normalize(cross(normal, t));
  return { t, b, n: normal };
}

function polygonPrismSdf(local: Vec3, inRadius: number, depth: number, sides: number): number {
  const circumRadius = inRadius / Math.cos(Math.PI / sides);
  const d2 = sdRegularPolygon2D(local[0], local[1], circumRadius, sides);
  const dz = Math.abs(local[2]) - depth * 0.5;
  return Math.max(d2, dz);
}

function surfaceHexHolesSdf(
  p: Vec3,
  grid: SpatialHash,
  cellSize: number,
  inRadius: number,
  depth: number,
  sides: number
): number {
  if (grid.size === 0) return Infinity;
  const cx = Math.floor(p[0] / cellSize);
  const cy = Math.floor(p[1] / cellSize);
  const cz = Math.floor(p[2] / cellSize);
  let minD = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = `${cx + dx},${cy + dy},${cz + dz}`;
        const bucket = grid.get(key);
        if (!bucket) continue;
        for (const sample of bucket) {
          const delta: Vec3 = [
            p[0] - sample.pos[0],
            p[1] - sample.pos[1],
            p[2] - sample.pos[2],
          ];
          const { t, b, n } = basisFromNormal(sample.normal);
          const local: Vec3 = [dot(delta, t), dot(delta, b), dot(delta, n)];
          const radiusScale = Math.max(0.72, Math.min(1.0, sample.holeScale ?? 1.0));
          const d = polygonPrismSdf(local, inRadius * radiusScale, depth, sides);
          if (d < minD) minD = d;
        }
      }
    }
  }
  return minD;
}

export function buildSurfaceHexLattice(
  objectSdf: (x: number, y: number, z: number) => number,
  params: LatticeParams,
  samples: SurfaceHexSample[]
): (x: number, y: number, z: number) => number {
  const { surfaceDepth, cellSize, strutDiameter, shellThickness } = params;
  const shellDepth = shellThickness > 0 ? Math.min(surfaceDepth, shellThickness) : surfaceDepth;
  const targetDepth = Math.max(0.1, shellDepth);
  const holeDepth = targetDepth * 2.2;
  const wallThickness = Math.max(strutDiameter, cellSize * 0.05);
  const polygonSides = params.latticeType === 'triangle' ? 3 : 6;
  const radiusPacking = polygonSides === 3 ? 0.34 : 0.5;
  const inRadius = Math.max(0.1, (cellSize - wallThickness) * radiusPacking);
  const grid = buildSpatialHash(samples, cellSize);

  return (x: number, y: number, z: number) => {
    const dObj = objectSdf(x, y, z);
    const bandSdf = Math.max(dObj, -(dObj + shellDepth));
    const holeSdf = surfaceHexHolesSdf([x, y, z], grid, cellSize, inRadius, holeDepth, polygonSides);
    return Math.max(bandSdf, -holeSdf);
  };
}

export function buildCombinedSDF(opts: LatticeSdfOptions): SdfFunction {
  const { bvh, params } = opts;
  const { shellThickness, noShell, surfaceOnly, surfaceDepth, cellSize, wallThickness, strutDiameter, variant, latticeType, gradientEnabled, gradientStrength } = params;
  const blendK = Math.min(wallThickness, strutDiameter) * 0.3;
  const latticeFn = buildLatticeEvaluator(params);
  const sdf = (x: number, y: number, z: number) => bvh.signedDistance([x, y, z]);

  const sampleLattice = (x: number, y: number, z: number, dObj: number) => {
    if (variant !== 'implicit_conformal' || (latticeType !== 'hexagon' && latticeType !== 'triangle')) {
      return latticeFn(x, y, z);
    }
    const [u, v, w] = conformalCoords(sdf, x, y, z, dObj, cellSize);
    return latticeFn(u, v, w);
  };

  // ── Surface-only mode ──
  if (surfaceOnly) {
    const result: SdfFunction = (x, y, z) => {
      const dObj = sdf(x, y, z);
      const bandSdf = Math.max(dObj, -(dObj + surfaceDepth));
      let lat = sampleLattice(x, y, z, dObj);
      if (gradientEnabled) {
        lat *= 1.0 - gradientStrength * Math.exp(-Math.max(0, -dObj) / (cellSize * 3));
      }
      return Math.max(lat, bandSdf);
    };
    return attachTpmsGridSampler(result, sdf, params, blendK, false);
  }

  // ── No-shell mode ──
  if (noShell) {
    const result: SdfFunction = (x, y, z) => {
      const dObj = sdf(x, y, z);
      let lat = sampleLattice(x, y, z, dObj);
      if (gradientEnabled) {
        lat *= 1.0 - gradientStrength * Math.exp(-Math.max(0, -dObj) / (cellSize * 3));
      }
      return Math.max(lat, dObj);
    };
    return attachTpmsGridSampler(result, sdf, params, blendK, false);
  }

  if (variant === 'shell_core') {
    const result: SdfFunction = (x, y, z) => {
      const dObj = sdf(x, y, z);
      const shellSdf = Math.max(dObj, -(dObj + shellThickness));
      const coreSdf = -(dObj + shellThickness);
      let lat = sampleLattice(x, y, z, dObj);
      if (gradientEnabled) {
        lat *= 1.0 - gradientStrength * Math.exp(-Math.max(0, -(dObj + shellThickness)) / (cellSize * 3));
      }
      return smoothMin(shellSdf, Math.max(-coreSdf, lat), blendK);
    };
    return attachTpmsGridSampler(result, sdf, params, blendK, false);
  } else {
    const result: SdfFunction = (x, y, z) => {
      const dObj = sdf(x, y, z);
      let lat = sampleLattice(x, y, z, dObj);
      if (gradientEnabled) {
        lat *= 1.0 - gradientStrength * Math.exp(-Math.max(0, -dObj) / (cellSize * 3));
      }
      const shellSdf = Math.max(dObj, -(dObj + shellThickness));
      return smoothMin(shellSdf, Math.max(lat, dObj), blendK);
    };
    return attachTpmsGridSampler(result, sdf, params, blendK, false);
  }
}

/**
 * Generic analytic-SDF lattice builder.
 * Provide a signed distance function for the object boundary and this
 * handles all the shell/noShell/surfaceOnly/variant logic.
 */
export function buildAnalyticLattice(
  objectSdf: (x: number, y: number, z: number) => number,
  params: LatticeParams,
): SdfFunction {
  const { shellThickness, noShell, surfaceOnly, surfaceDepth, cellSize, wallThickness, strutDiameter, variant, latticeType, gradientEnabled, gradientStrength } = params;
  const blendK = Math.min(wallThickness, strutDiameter) * 0.3;
  const latticeFn = buildLatticeEvaluator(params);

  const result: SdfFunction = (x, y, z) => {
    const dObj = objectSdf(x, y, z);

    let lat = latticeFn(x, y, z);
    if (variant === 'implicit_conformal' && (latticeType === 'hexagon' || latticeType === 'triangle')) {
      const [u, v, w] = conformalCoords(objectSdf, x, y, z, dObj, cellSize);
      lat = latticeFn(u, v, w);
    }
    if (gradientEnabled) {
      const gd = (noShell || surfaceOnly) ? Math.max(0, -dObj) : Math.max(0, -(dObj + shellThickness));
      lat *= 1.0 - gradientStrength * Math.exp(-gd / (cellSize * 3));
    }

    if (surfaceOnly) return Math.max(lat, Math.max(dObj, -(dObj + surfaceDepth)));
    if (noShell) return Math.max(lat, dObj);

    const shellSdf = Math.max(dObj, -(dObj + shellThickness));
    if (variant === 'shell_core') {
      const coreSdf = -(dObj + shellThickness);
      return smoothMin(shellSdf, Math.max(-coreSdf, lat), blendK);
    } else {
      return smoothMin(shellSdf, Math.max(lat, dObj), blendK);
    }
  };

  return attachTpmsGridSampler(result, objectSdf, params, blendK, true);
}

export function buildSphereLattice(
  radius: number,
  params: LatticeParams
): SdfFunction {
  return buildAnalyticLattice((x, y, z) => Math.sqrt(x*x + y*y + z*z) - radius, params);
}

export function buildCubeLattice(
  halfSize: number,
  params: LatticeParams,
): SdfFunction {
  return buildAnalyticLattice((x, y, z) => {
    const dx = Math.abs(x) - halfSize;
    const dy = Math.abs(y) - halfSize;
    const dz = Math.abs(z) - halfSize;
    const outside = Math.sqrt(Math.max(dx,0)**2 + Math.max(dy,0)**2 + Math.max(dz,0)**2);
    const inside = Math.min(Math.max(dx, dy, dz), 0);
    return outside + inside;
  }, params);
}

export function buildCylinderLattice(
  radius: number,
  halfHeight: number,
  params: LatticeParams,
): SdfFunction {
  return buildAnalyticLattice((x, y, z) => {
    const dRadial = Math.sqrt(x*x + y*y) - radius;
    const dAxial = Math.abs(z) - halfHeight;
    const outside = Math.sqrt(Math.max(dRadial,0)**2 + Math.max(dAxial,0)**2);
    const inside = Math.min(Math.max(dRadial, dAxial), 0);
    return outside + inside;
  }, params);
}

export function buildTorusLattice(
  majorRadius: number,
  tubeRadius: number,
  params: LatticeParams,
): SdfFunction {
  return buildAnalyticLattice((x, y, z) => {
    const qx = Math.sqrt(x*x + y*y) - majorRadius;
    return Math.sqrt(qx*qx + z*z) - tubeRadius;
  }, params);
}

export function buildCapsuleLattice(
  radius: number,
  halfHeight: number,
  params: LatticeParams,
): SdfFunction {
  return buildAnalyticLattice((x, y, z) => {
    // Clamp z to the cylinder body, then measure distance to that clamped point.
    const cz = Math.max(-halfHeight, Math.min(halfHeight, z));
    return Math.sqrt(x*x + y*y + (z - cz)*(z - cz)) - radius;
  }, params);
}
