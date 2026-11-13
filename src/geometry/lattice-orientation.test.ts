import { describe, expect, it } from 'vitest';
import { Euler, Matrix4 } from 'three';
import { buildCubeLattice, buildLatticeEvaluator } from './lattice';
import {
  isIdentityLatticeOrientation,
  latticeTransformFor,
  normalizedLatticeOrientation,
  rotationMatrixXYZ,
} from './lattice-transform';
import { marchingCubes } from './marching-cubes';
import type { Vec3 } from './vec3';
import { DEFAULT_PARAMS, type LatticeParams, type LatticeType } from '../types/project';

const ALL_TYPES: LatticeType[] = [
  'gyroid', 'schwarzP', 'schwarzD', 'neovius', 'iwp', 'bcc',
  'octet', 'diamond', 'hexagon', 'triangle', 'voronoi', 'spinodal',
];

function params(overrides: Partial<LatticeParams>): LatticeParams {
  return { ...DEFAULT_PARAMS, cellSize: 8, wallThickness: 1, strutDiameter: 1, ...overrides };
}

/** Deterministic pseudo-random points (no ambient randomness in tests either). */
function samplePoints(count: number, span: number, seed = 1): Vec3[] {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return Array.from({ length: count }, () => [
    (next() - 0.5) * span,
    (next() - 0.5) * span,
    (next() - 0.5) * span,
  ] as Vec3);
}

function rotate(R: Float64Array, v: Vec3): Vec3 {
  return [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ];
}

describe('lattice transform', () => {
  it('builds an exactly orthonormal rotation matching three.js XYZ Euler order', () => {
    const angles: Vec3 = [23, -41, 167];
    const R = rotationMatrixXYZ(angles);
    const toRad = Math.PI / 180;
    const three = new Matrix4().makeRotationFromEuler(new Euler(angles[0] * toRad, angles[1] * toRad, angles[2] * toRad, 'XYZ'));
    const e = three.elements; // column-major
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        expect(R[row * 3 + col]).toBeCloseTo(e[col * 4 + row], 12);
        let dot = 0;
        for (let k = 0; k < 3; k++) dot += R[k * 3 + row] * R[k * 3 + col];
        expect(dot).toBeCloseTo(row === col ? 1 : 0, 14);
      }
    }
  });

  it('treats identity, missing and malformed orientation entries as identity', () => {
    expect(isIdentityLatticeOrientation(DEFAULT_PARAMS)).toBe(true);
    expect(latticeTransformFor({})).toBeNull();
    expect(latticeTransformFor({ latticeRotationDeg: [0, -0, 0], cellScale: [1, 1, 1] })).toBeNull();
    const malformed = { latticeRotationDeg: [Number.NaN, 0, 0], cellScale: 'big' } as unknown as LatticeParams;
    expect(latticeTransformFor(malformed)).toBeNull();
    expect(normalizedLatticeOrientation({ cellScale: [100, 0.001, 2] }).scale).toEqual([4, 0.25, 2]);
    expect(latticeTransformFor({ latticeRotationDeg: [0, 0, 45] })).not.toBeNull();
    expect(latticeTransformFor({ cellScale: [1, 1, 2] })).not.toBeNull();
  });
});

describe('rotated lattices', () => {
  // These cells have the full cubic point group about the origin, so a quarter
  // turn about Z maps the lattice onto itself. (Gyroid, Schwarz D and diamond
  // only map onto themselves with an added translation.)
  it.each(['schwarzP', 'neovius', 'iwp', 'bcc', 'octet'] as const)(
    'maps a cubic-symmetric %s lattice onto itself after a 90° turn about Z',
    (latticeType) => {
      const base = buildLatticeEvaluator(params({ latticeType }));
      const turned = buildLatticeEvaluator(params({ latticeType, latticeRotationDeg: [0, 0, 90] }));
      for (const [x, y, z] of samplePoints(400, 40)) {
        expect(turned(x, y, z)).toBeCloseTo(base(x, y, z), 9);
      }
    },
  );

  it.each(ALL_TYPES)('rotates the %s field rigidly: f_R(R·v) = f(v)', (latticeType) => {
    const angles: Vec3 = [23, -41, 67];
    const R = rotationMatrixXYZ(angles);
    const base = buildLatticeEvaluator(params({ latticeType }), 0xbeef);
    const rotated = buildLatticeEvaluator(params({ latticeType, latticeRotationDeg: angles }), 0xbeef);
    for (const v of samplePoints(300, 40, 7)) {
      const p = rotate(R, v);
      const expected = base(v[0], v[1], v[2]);
      const actual = rotated(p[0], p[1], p[2]);
      // Hexagon cell lookup and Voronoi F1/F2 switch discontinuously, so a
      // rounding-level difference may land on the other side of a boundary;
      // both sides then agree on the distance to that boundary.
      expect(Math.abs(actual - expected)).toBeLessThan(1e-7);
    }
  });

  it('disables the separable TPMS grid sampler only for transformed lattices', () => {
    const axisAligned = buildCubeLattice(15, params({ latticeType: 'gyroid' }));
    const rotated = buildCubeLattice(15, params({ latticeType: 'gyroid', latticeRotationDeg: [0, 0, 45] }));
    expect(typeof axisAligned.sampleField).toBe('function');
    expect(rotated.sampleField).toBeUndefined();
  });
});

/**
 * Wall thickness of a sheet field, measured along the world-space normal of
 * the mid-surface at points where the sheet is centred: march out both ways
 * until the field turns positive, then bisect.
 */
function measureSheetThickness(
  field: (x: number, y: number, z: number) => number,
  implicit: (p: Vec3) => number,
  starts: Vec3[],
): number[] {
  const out: number[] = [];
  const h = 1e-5;
  for (const start of starts) {
    // Project onto the mid-surface (implicit = 0) by Newton steps.
    let p: Vec3 = [...start];
    let ok = false;
    for (let iter = 0; iter < 40; iter++) {
      const f = implicit(p);
      const g: Vec3 = [
        (implicit([p[0] + h, p[1], p[2]]) - implicit([p[0] - h, p[1], p[2]])) / (2 * h),
        (implicit([p[0], p[1] + h, p[2]]) - implicit([p[0], p[1] - h, p[2]])) / (2 * h),
        (implicit([p[0], p[1], p[2] + h]) - implicit([p[0], p[1], p[2] - h])) / (2 * h),
      ];
      const g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (g2 < 1e-6) break;
      p = [p[0] - f * g[0] / g2, p[1] - f * g[1] / g2, p[2] - f * g[2] / g2];
      if (Math.abs(f) < 1e-12) { ok = true; break; }
    }
    if (!ok || field(p[0], p[1], p[2]) >= 0) continue;
    const g: Vec3 = [
      (implicit([p[0] + h, p[1], p[2]]) - implicit([p[0] - h, p[1], p[2]])) / (2 * h),
      (implicit([p[0], p[1] + h, p[2]]) - implicit([p[0], p[1] - h, p[2]])) / (2 * h),
      (implicit([p[0], p[1], p[2] + h]) - implicit([p[0], p[1], p[2] - h])) / (2 * h),
    ];
    const len = Math.hypot(g[0], g[1], g[2]);
    // Skip near-degenerate (saddle-flat) points, where any sheet offset is ill-defined.
    if (len < 0.5) continue;
    const n: Vec3 = [g[0] / len, g[1] / len, g[2] / len];
    const exit = (sign: number) => {
      const at = (t: number) => field(p[0] + sign * t * n[0], p[1] + sign * t * n[1], p[2] + sign * t * n[2]);
      let lo = 0;
      let hi = 0.05;
      while (at(hi) < 0 && hi < 5) { lo = hi; hi += 0.05; }
      for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        if (at(mid) < 0) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    };
    out.push(exit(1) + exit(-1));
  }
  return out;
}

function gyroidImplicit(m: Float64Array | null, cellSize: number): (p: Vec3) => number {
  const k = 2 * Math.PI / cellSize;
  return ([x, y, z]) => {
    const u = m
      ? [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z]
      : [x, y, z];
    const [a, b, c] = [k * u[0], k * u[1], k * u[2]];
    return Math.sin(a) * Math.cos(b) + Math.sin(b) * Math.cos(c) + Math.sin(c) * Math.cos(a);
  };
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p05: sorted[Math.floor(sorted.length * 0.05)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

describe('wall and strut thickness in millimetres', () => {
  const wall = 1.2;
  const cellSize = 10;
  /** Thickness statistics of an axis-aligned gyroid with cubic cells of `size` mm. */
  const isotropic = (size: number) => stats(measureSheetThickness(
    buildLatticeEvaluator(params({ latticeType: 'gyroid', cellSize: size, wallThickness: wall })),
    gyroidImplicit(null, size),
    samplePoints(300, 40, 3),
  ));
  const reference = isotropic(cellSize);

  it('keeps the axis-aligned reference itself near nominal', () => {
    // Approximation: |f|/|∇f| is a first-order offset of the mid-surface, so
    // curvature makes gyroid walls a few percent thinner than nominal.
    expect(Math.abs(reference.median - wall) / wall).toBeLessThan(0.06);
  });

  it('keeps a rotated gyroid wall exactly as thick as the axis-aligned one', () => {
    const p = params({ latticeType: 'gyroid', cellSize, wallThickness: wall, latticeRotationDeg: [23, -41, 67] });
    const measured = stats(measureSheetThickness(
      buildLatticeEvaluator(p),
      gyroidImplicit(latticeTransformFor(p)!.m, cellSize),
      samplePoints(300, 40, 3),
    ));
    expect(measured.count).toBeGreaterThan(250);
    expect(Math.abs(measured.median - reference.median)).toBeLessThan(wall * 0.005);
    expect(measured.p05).toBeGreaterThan(reference.p05 - wall * 0.01);
    expect(measured.p95).toBeLessThan(reference.p95 + wall * 0.01);
  });

  it.each([
    ['(1, 1, 2)', [0, 0, 0], [1, 1, 2]],
    ['(0.5, 1, 2) and rotated', [30, 10, -50], [0.5, 1, 2]],
  ] as const)('keeps a gyroid stretched %s near its nominal wall thickness', (_label, rotation, scale) => {
    const p = params({
      latticeType: 'gyroid',
      cellSize,
      wallThickness: wall,
      latticeRotationDeg: [...rotation],
      cellScale: [...scale],
    });
    const measured = stats(measureSheetThickness(
      buildLatticeEvaluator(p),
      gyroidImplicit(latticeTransformFor(p)!.m, cellSize),
      samplePoints(300, 40, 3),
    ));
    expect(measured.count).toBeGreaterThan(250);
    // Walls stay near nominal in mm. Dividing by the Lipschitz factor instead
    // would scale them by up to max/min cellScale (2× and 4× here).
    expect(measured.p05).toBeGreaterThan(wall * 0.8);
    expect(measured.p95).toBeLessThan(wall * 1.1);
    // The first-order error is that of an axis-aligned gyroid whose cells are
    // as small as the most compressed stretched axis, and no worse.
    const smallest = isotropic(cellSize * Math.min(...scale));
    expect(Math.abs(measured.median - wall)).toBeLessThanOrEqual(Math.abs(smallest.median - wall) + wall * 0.02);
  });

  it('measures strut distance exactly in mm along stretched and unstretched axes', () => {
    const L = 8;
    const r = 0.6;
    const field = buildLatticeEvaluator(params({ latticeType: 'bcc', cellSize: L, strutDiameter: 2 * r, cellScale: [2, 1, 1] }));
    // The edge strut along the lattice x axis (stretched to 2L) through the origin.
    for (const d of [0.1, 0.4, 0.9]) {
      expect(field(L, d, 0)).toBeCloseTo(d - r, 12);
      expect(field(L, 0, d)).toBeCloseTo(d - r, 12);
    }
    // The edge strut along y (unstretched), offset from the stretched axis.
    for (const d of [0.1, 0.4]) expect(field(d, L * 0.5, 0)).toBeCloseTo(d - r, 12);
  });

  it('keeps the triangle prism wall width exact when stretched', () => {
    const L = 8;
    const r = 0.5;
    const field = buildLatticeEvaluator(params({ latticeType: 'triangle', cellSize: L, strutDiameter: 2 * r, cellScale: [1, 3, 1] }));
    // The n=(0,1) family has lines at y = 0 in cell coordinates; stretched 3×
    // along y they repeat every 3·L·√3/2 mm, and the wall stays 2r wide.
    const period = 3 * L * Math.sqrt(3) / 2;
    // x = L/2 sits halfway between the lines of the two slanted families.
    expect(field(L / 2, r, 0)).toBeCloseTo(0, 12);
    // Two y periods keep x = L/2 midway between the slanted lines as well.
    expect(field(L / 2, 2 * period - r, 0)).toBeCloseTo(0, 12);
    expect(field(L / 2, 0, 0)).toBeCloseTo(-r, 12);
  });
});

describe('stretched cells', () => {
  it.each(ALL_TYPES)('repeats the %s field with the stretched period', (latticeType) => {
    if (latticeType === 'voronoi' || latticeType === 'spinodal') return; // not periodic
    const L = 6;
    const scale: Vec3 = [1, 1.5, 2];
    const field = buildLatticeEvaluator(params({ latticeType, cellSize: L, cellScale: scale }));
    const periodFor = (axis: number) => {
      // Hexagon/triangle prisms repeat in-plane on their own (non-cubic) lattices.
      if (latticeType === 'hexagon') return axis === 1 ? 3 * L / Math.sqrt(3) : 2 * L;
      if (latticeType === 'triangle') return axis === 1 ? L * Math.sqrt(3) : 2 * L;
      return L;
    };
    for (const [x, y, z] of samplePoints(150, 30, 11)) {
      for (let axis = 0; axis < 3; axis++) {
        const step = periodFor(axis) * scale[axis];
        const q: Vec3 = [x, y, z];
        q[axis] += step;
        expect(field(q[0], q[1], q[2])).toBeCloseTo(field(x, y, z), 8);
      }
    }
  });

  it('changes the gyroid period along the stretched axis only', () => {
    const L = 8;
    const stretched = buildLatticeEvaluator(params({ latticeType: 'gyroid', cellSize: L, cellScale: [1, 1, 2] }));
    let differsAtOnePeriod = 0;
    for (const [x, y, z] of samplePoints(200, 30, 5)) {
      expect(stretched(x, y, z + 2 * L)).toBeCloseTo(stretched(x, y, z), 9);
      expect(stretched(x + L, y, z)).toBeCloseTo(stretched(x, y, z), 9);
      if (Math.abs(stretched(x, y, z + L) - stretched(x, y, z)) > 1e-3) differsAtOnePeriod++;
    }
    expect(differsAtOnePeriod).toBeGreaterThan(150);
  });

  it('produces closed, finite meshes for every type under a combined rotation and stretch', () => {
    for (const latticeType of ALL_TYPES) {
      const sdf = buildCubeLattice(10, params({
        latticeType,
        cellSize: 6,
        latticeRotationDeg: [15, 30, 45],
        cellScale: [0.75, 1, 1.5],
      }), 42);
      const result = marchingCubes(sdf, { min: [-12, -12, -12], max: [12, 12, 12] }, 24);
      expect(result.triCount, latticeType).toBeGreaterThan(100);
      for (let i = 0; i < result.positions.length; i++) {
        if (!Number.isFinite(result.positions[i])) throw new Error(`${latticeType}: non-finite vertex`);
      }
    }
  });
});
