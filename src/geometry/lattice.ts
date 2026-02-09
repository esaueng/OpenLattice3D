// Lattice generation: SDF-based approach for multiple lattice types
// TPMS: Gyroid, Schwarz P, Schwarz D, Neovius, IWP
// Strut: BCC, Octet Truss, Diamond
// Stochastic: Voronoi Foam, Spinodal Decomposition
import type { Vec3 } from './vec3';
import type { MeshBVH } from './bvh';
import type { LatticeParams, LatticeType } from '../types/project';

const TWO_PI = 2 * Math.PI;
const SQRT3 = Math.sqrt(3);

type StrutCache = {
  L: number;
  h: number;
  q: number;
  corners: Vec3[];
  edges: [Vec3, Vec3][];
  faceCenters: Vec3[];
  fcc: Vec3[];
  offsets: Vec3[];
};

let strutCache: StrutCache | null = null;

function getStrutCache(L: number): StrutCache {
  if (strutCache && strutCache.L === L) return strutCache;
  const h = L / 2;
  const q = L / 4;
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
  const fcc: Vec3[] = [
    [0, 0, 0], [L / 2, L / 2, 0], [L / 2, 0, L / 2], [0, L / 2, L / 2],
  ];
  const offsets: Vec3[] = [
    [q, q, q], [-q, -q, q], [-q, q, -q], [q, -q, -q],
  ];

  strutCache = { L, h, q, corners, edges, faceCenters, fcc, offsets };
  return strutCache;
}

// ═══════════════════════════════════════════════════════════
//  TPMS Lattice Functions
//  All return a sheet-type SDF: |f(p)| - c  where c sets thickness
// ═══════════════════════════════════════════════════════════

/** Gyroid: sin(kx)cos(ky) + sin(ky)cos(kz) + sin(kz)cos(kx) */
export function gyroidSDF(x: number, y: number, z: number, cellSize: number, wallThickness: number): number {
  const k = TWO_PI / cellSize;
  const val = Math.sin(k*x)*Math.cos(k*y) + Math.sin(k*y)*Math.cos(k*z) + Math.sin(k*z)*Math.cos(k*x);
  const c = wallThickness * Math.PI / cellSize;
  return Math.abs(val) - c;
}

/** Schwarz P (Primitive): cos(kx) + cos(ky) + cos(kz)
 *  Cubic channels along axes. Highest axial stiffness among TPMS. */
export function schwarzPSDF(x: number, y: number, z: number, cellSize: number, wallThickness: number): number {
  const k = TWO_PI / cellSize;
  const val = Math.cos(k*x) + Math.cos(k*y) + Math.cos(k*z);
  // Range [-3, 3], Lipschitz ≈ k√3. Normalize thickness: c ~ wallThickness * k / 2
  const c = wallThickness * Math.PI / cellSize;
  return Math.abs(val) - c * 3;  // scale c to match the wider range
}

/** Schwarz D (Diamond): sin(kx)sin(ky)sin(kz) + sin(kx)cos(ky)cos(kz)
 *                       + cos(kx)sin(ky)cos(kz) + cos(kx)cos(ky)sin(kz)
 *  Two interleaved labyrinths with diamond symmetry. Near-isotropic. */
export function schwarzDSDF(x: number, y: number, z: number, cellSize: number, wallThickness: number): number {
  const k = TWO_PI / cellSize;
  const sx = Math.sin(k*x), sy = Math.sin(k*y), sz = Math.sin(k*z);
  const cx = Math.cos(k*x), cy = Math.cos(k*y), cz = Math.cos(k*z);
  const val = sx*sy*sz + sx*cy*cz + cx*sy*cz + cx*cy*sz;
  // Range ~ [-1.4, 1.4]
  const c = wallThickness * Math.PI / cellSize;
  return Math.abs(val) - c * 1.4;
}

/** Neovius: 3(cos(kx) + cos(ky) + cos(kz)) + 4·cos(kx)cos(ky)cos(kz)
 *  Higher genus (9 per cell). More junctions → better load distribution. */
export function neoviusSDF(x: number, y: number, z: number, cellSize: number, wallThickness: number): number {
  const k = TWO_PI / cellSize;
  const cx = Math.cos(k*x), cy = Math.cos(k*y), cz = Math.cos(k*z);
  const val = 3*(cx + cy + cz) + 4*cx*cy*cz;
  // Range ~ [-13, 13]
  const c = wallThickness * Math.PI / cellSize;
  return Math.abs(val) - c * 13;
}

/** IWP (Schoen I-WP): 2(cos(kx)cos(ky) + cos(ky)cos(kz) + cos(kz)cos(kx))
 *                     - (cos(2kx) + cos(2ky) + cos(2kz))
 *  Body-centred cubic symmetry. Very high specific stiffness. */
export function iwpSDF(x: number, y: number, z: number, cellSize: number, wallThickness: number): number {
  const k = TWO_PI / cellSize;
  const cx = Math.cos(k*x), cy = Math.cos(k*y), cz = Math.cos(k*z);
  const val = 2*(cx*cy + cy*cz + cz*cx) - (Math.cos(2*k*x) + Math.cos(2*k*y) + Math.cos(2*k*z));
  // Range ~ [-5, 5]
  const c = wallThickness * Math.PI / cellSize;
  return Math.abs(val) - c * 5;
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
 *  Each node has 4 tetrahedral neighbours. Isotropic, self-supporting for 3D printing. */
export function diamondStrutSDF(x: number, y: number, z: number, cellSize: number, strutDiameter: number): number {
  const r = strutDiameter / 2;
  const L = cellSize;
  const { fcc, offsets } = getStrutCache(L);
  const lx = ((x % L) + L) % L;
  const ly = ((y % L) + L) % L;
  const lz = ((z % L) + L) % L;

  // Each FCC node connects to 4 nearest offset nodes (tetrahedral).
  // Connection pattern: FCC node at (a,b,c) connects to offset nodes at
  // (a±q, b±q, c±q) where an even number of signs are negative.

  let minDist = Infinity;
  const p: Vec3 = [lx, ly, lz];

  for (const f of fcc) {
    for (const o of offsets) {
      // Target (wrapping)
      const tx = ((f[0] + o[0]) % L + L) % L;
      const ty = ((f[1] + o[1]) % L + L) % L;
      const tz = ((f[2] + o[2]) % L + L) % L;
      const d = distToSegment(p, f, [tx, ty, tz]);
      if (d < minDist) minDist = d;
    }
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

/** Spinodal decomposition: sum of cosines with deterministic random wave vectors.
 *  Mimics biological bone / phase-separated materials. Near-optimal isotropic stiffness.
 *  N_WAVES controls quality (more = smoother). Evaluated entirely from hashed indices. */
const N_WAVES = 64;

export function spinodalSDF(x: number, y: number, z: number, cellSize: number, wallThickness: number): number {
  const k0 = TWO_PI / cellSize;
  let sum = 0;
  for (let i = 0; i < N_WAVES; i++) {
    // Deterministic random direction on the unit sphere (Fibonacci lattice)
    const phi = TWO_PI * hashF(i, 0);
    const cosTheta = 1 - 2 * hashF(i, 1);
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    const kx = k0 * sinTheta * Math.cos(phi);
    const ky = k0 * sinTheta * Math.sin(phi);
    const kz = k0 * cosTheta;
    const phase = TWO_PI * hashF(i, 2);
    sum += Math.cos(kx * x + ky * y + kz * z + phase);
  }
  sum /= Math.sqrt(N_WAVES);
  // Threshold to control wall thickness: larger c → more material
  const c = wallThickness * 0.6 / cellSize;
  return Math.abs(sum) - c * 2;
}

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

function sdHexagon2D(px: number, py: number, radius: number): number {
  const verts = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i;
    return [radius * Math.cos(angle), radius * Math.sin(angle)] as const;
  });

  let minDist = Infinity;
  let inside = true;

  for (let i = 0; i < verts.length; i++) {
    const [ax, ay] = verts[i];
    const [bx, by] = verts[(i + 1) % verts.length];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross < 0) inside = false;
    const d = distToSegment2D(px, py, ax, ay, bx, by);
    if (d < minDist) minDist = d;
  }

  return inside ? -minDist : minDist;
}

function hexCellCenter(x: number, y: number, radius: number): [number, number] {
  const q = (SQRT3 / 3 * x - (1 / 3) * y) / radius;
  const r = (2 / 3 * y) / radius;
  let rx = Math.round(q);
  let ry = Math.round(r);
  let rz = Math.round(-q - r);

  const xDiff = Math.abs(rx - q);
  const yDiff = Math.abs(ry - r);
  const zDiff = Math.abs(rz + q + r);

  if (xDiff > yDiff && xDiff > zDiff) rx = -ry - rz;
  else if (yDiff > zDiff) ry = -rx - rz;
  else rz = -rx - ry;

  const cx = radius * SQRT3 * (rx + ry / 2);
  const cy = radius * 1.5 * ry;
  return [cx, cy];
}

export function hexagonPrismSDF(x: number, y: number, z: number, cellSize: number, strutDiameter: number): number {
  const r = strutDiameter / 2;
  const radius = cellSize / SQRT3;
  const [cx, cy] = hexCellCenter(x, y, radius);
  const lx = x - cx;
  const ly = y - cy;
  const d = Math.abs(sdHexagon2D(lx, ly, radius));
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

/** Smooth maximum */
export function smoothMax(a: number, b: number, k: number): number {
  return -smoothMin(-a, -b, k);
}

// ═══════════════════════════════════════════════════════════
//  Unified lattice evaluator
// ═══════════════════════════════════════════════════════════

function buildLatticeEvaluator(params: LatticeParams): (x: number, y: number, z: number) => number {
  const { latticeType, cellSize, wallThickness, strutDiameter } = params;
  switch (latticeType) {
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

// ═══════════════════════════════════════════════════════════
//  Combined SDF builders
// ═══════════════════════════════════════════════════════════

export interface LatticeSdfOptions {
  bvh: MeshBVH;
  params: LatticeParams;
  keepOutTris: Set<number>;
}

export function buildCombinedSDF(opts: LatticeSdfOptions): (x: number, y: number, z: number) => number {
  const { bvh, params } = opts;
  const { shellThickness, noShell, surfaceOnly, surfaceDepth, cellSize, wallThickness, strutDiameter, variant, gradientEnabled, gradientStrength } = params;
  const blendK = Math.min(wallThickness, strutDiameter) * 0.3;
  const latticeFn = buildLatticeEvaluator(params);

  // ── Surface-only mode ──
  if (surfaceOnly) {
    return (x, y, z) => {
      const dObj = bvh.signedDistance([x, y, z]);
      const bandSdf = Math.max(dObj, -(dObj + surfaceDepth));
      let lat = latticeFn(x, y, z);
      if (gradientEnabled) {
        lat *= 1.0 - gradientStrength * Math.exp(-Math.max(0, -dObj) / (cellSize * 3));
      }
      return Math.max(lat, bandSdf);
    };
  }

  // ── No-shell mode ──
  if (noShell) {
    return (x, y, z) => {
      const dObj = bvh.signedDistance([x, y, z]);
      let lat = latticeFn(x, y, z);
      if (gradientEnabled) {
        lat *= 1.0 - gradientStrength * Math.exp(-Math.max(0, -dObj) / (cellSize * 3));
      }
      return Math.max(lat, dObj);
    };
  }

  if (variant === 'shell_core') {
    return (x, y, z) => {
      const dObj = bvh.signedDistance([x, y, z]);
      const shellSdf = Math.max(dObj, -(dObj + shellThickness));
      const coreSdf = -(dObj + shellThickness);
      let lat = latticeFn(x, y, z);
      if (gradientEnabled) {
        lat *= 1.0 - gradientStrength * Math.exp(-Math.max(0, -(dObj + shellThickness)) / (cellSize * 3));
      }
      return smoothMin(shellSdf, Math.max(-coreSdf, lat), blendK);
    };
  } else {
    return (x, y, z) => {
      const dObj = bvh.signedDistance([x, y, z]);
      let lat = latticeFn(x, y, z);
      if (gradientEnabled) {
        lat *= 1.0 - gradientStrength * Math.exp(-Math.max(0, -dObj) / (cellSize * 3));
      }
      const shellSdf = Math.max(dObj, -(dObj + shellThickness));
      return smoothMin(shellSdf, Math.max(lat, dObj), blendK);
    };
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
): (x: number, y: number, z: number) => number {
  const { shellThickness, noShell, surfaceOnly, surfaceDepth, cellSize, wallThickness, strutDiameter, variant, gradientEnabled, gradientStrength } = params;
  const blendK = Math.min(wallThickness, strutDiameter) * 0.3;
  const latticeFn = buildLatticeEvaluator(params);

  return (x, y, z) => {
    const dObj = objectSdf(x, y, z);

    let lat = latticeFn(x, y, z);
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
}

export function buildSphereLattice(
  radius: number,
  params: LatticeParams
): (x: number, y: number, z: number) => number {
  return buildAnalyticLattice((x, y, z) => Math.sqrt(x*x + y*y + z*z) - radius, params);
}

export function buildCubeLattice(
  halfSize: number,
  params: LatticeParams,
): (x: number, y: number, z: number) => number {
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
): (x: number, y: number, z: number) => number {
  return buildAnalyticLattice((x, y, z) => {
    const dRadial = Math.sqrt(x*x + z*z) - radius;
    const dAxial = Math.abs(y) - halfHeight;
    const outside = Math.sqrt(Math.max(dRadial,0)**2 + Math.max(dAxial,0)**2);
    const inside = Math.min(Math.max(dRadial, dAxial), 0);
    return outside + inside;
  }, params);
}

export function buildTorusLattice(
  majorRadius: number,
  tubeRadius: number,
  params: LatticeParams,
): (x: number, y: number, z: number) => number {
  return buildAnalyticLattice((x, y, z) => {
    const qx = Math.sqrt(x*x + z*z) - majorRadius;
    return Math.sqrt(qx*qx + y*y) - tubeRadius;
  }, params);
}

export function buildCapsuleLattice(
  radius: number,
  halfHeight: number,
  params: LatticeParams,
): (x: number, y: number, z: number) => number {
  return buildAnalyticLattice((x, y, z) => {
    // Clamp y to the cylinder body, then measure distance to that clamped point
    const cy = Math.max(-halfHeight, Math.min(halfHeight, y));
    return Math.sqrt(x*x + (y - cy)*(y - cy) + z*z) - radius;
  }, params);
}
