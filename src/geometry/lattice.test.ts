import { describe, expect, it } from 'vitest';
import {
  bccStrutSDF,
  buildAnalyticLattice,
  buildSphereLattice,
  diamondStrutSDF,
  isSheetType,
  octetSDF,
  smoothMin,
} from './lattice';
import { DEFAULT_PARAMS } from '../types/project';
import type { LatticeParams } from '../types/project';

const L = 10;
const R = 0.4; // strut radius for strutDiameter 0.8
const D = 0.8;

describe('diamondStrutSDF', () => {
  const q = L / 4;
  const fcc: number[][] = [[0, 0, 0], [L / 2, L / 2, 0], [L / 2, 0, L / 2], [0, L / 2, L / 2]];
  const offsets: number[][] = [[q, q, q], [-q, -q, q], [-q, q, -q], [q, -q, -q]];

  it('reports zero distance on every tetrahedral bond midpoint, including bonds leaving the cell', () => {
    for (const f of fcc) {
      for (const o of offsets) {
        const mx = f[0] + o[0] / 2;
        const my = f[1] + o[1] / 2;
        const mz = f[2] + o[2] / 2;
        expect(diamondStrutSDF(mx, my, mz, L, D)).toBeCloseTo(-R, 6);
      }
    }
  });

  it('has no material along the legacy spurious chord (regression)', () => {
    // The old implementation wrapped bond endpoints with modulo, creating a
    // phantom strut from (0,0,0) to (L-q, L-q, q). A point a quarter of the
    // way along that chord is ~0.1L away from any true diamond bond.
    const t = 0.25;
    const px = (L - q) * t;
    const py = (L - q) * t;
    const pz = q * t;
    const sdf = diamondStrutSDF(px, py, pz, L, D);
    expect(sdf).toBeGreaterThan(0.5);
  });

  it('is periodic across cells', () => {
    const points = [[1.3, 2.7, 0.4], [4.9, 9.1, 6.6], [0.05, 5.0, 9.95]];
    for (const [x, y, z] of points) {
      const base = diamondStrutSDF(x, y, z, L, D);
      expect(diamondStrutSDF(x + L, y, z, L, D)).toBeCloseTo(base, 9);
      expect(diamondStrutSDF(x, y - 2 * L, z, L, D)).toBeCloseTo(base, 9);
      expect(diamondStrutSDF(x + 3 * L, y + L, z - L, L, D)).toBeCloseTo(base, 9);
    }
  });

  it('is continuous across the cell boundary', () => {
    const eps = 1e-4;
    for (const [y, z] of [[2.5, 2.5], [5.0, 7.5], [1.0, 9.0]]) {
      const before = diamondStrutSDF(L - eps, y, z, L, D);
      const after = diamondStrutSDF(L + eps, y, z, L, D);
      expect(Math.abs(after - before)).toBeLessThan(1e-2);
    }
  });
});

describe('bccStrutSDF / octetSDF', () => {
  it('bcc has material at the cell center node', () => {
    expect(bccStrutSDF(L / 2, L / 2, L / 2, L, D)).toBeCloseTo(-R, 6);
  });

  it('bcc has material along cell edges', () => {
    expect(bccStrutSDF(L / 2, 0, 0, L, D)).toBeCloseTo(-R, 6);
  });

  it('octet has material at face centers and corners', () => {
    expect(octetSDF(L / 2, L / 2, 0, L, D)).toBeCloseTo(-R, 6);
    expect(octetSDF(0, 0, 0, L, D)).toBeCloseTo(-R, 6);
  });

  it('bcc is periodic', () => {
    const base = bccStrutSDF(1.2, 3.4, 5.6, L, D);
    expect(bccStrutSDF(1.2 + L, 3.4 - L, 5.6, L, D)).toBeCloseTo(base, 9);
  });
});

describe('smoothMin', () => {
  it('equals min when k <= 0', () => {
    expect(smoothMin(1, 2, 0)).toBe(1);
    expect(smoothMin(-3, 2, -1)).toBe(-3);
  });

  it('never exceeds the plain minimum and blends nearby values', () => {
    expect(smoothMin(1.0, 1.1, 0.5)).toBeLessThan(1.0);
    expect(smoothMin(1.0, 5.0, 0.5)).toBe(1.0);
  });
});

describe('isSheetType', () => {
  it('classifies TPMS and spinodal as sheet types', () => {
    for (const t of ['gyroid', 'schwarzP', 'schwarzD', 'neovius', 'iwp', 'spinodal'] as const) {
      expect(isSheetType(t)).toBe(true);
    }
    for (const t of ['bcc', 'octet', 'diamond', 'hexagon', 'triangle', 'voronoi'] as const) {
      expect(isSheetType(t)).toBe(false);
    }
  });
});

describe('buildSphereLattice', () => {
  const params: LatticeParams = { ...DEFAULT_PARAMS };

  it('is positive (empty) well outside the sphere', () => {
    const sdf = buildSphereLattice(20, params);
    expect(sdf(40, 0, 0)).toBeGreaterThan(0);
    expect(sdf(0, -35, 12)).toBeGreaterThan(0);
  });

  it('keeps the outer shell solid', () => {
    const sdf = buildSphereLattice(20, params);
    // Just inside the surface, within shellThickness: must be material.
    expect(sdf(19.5, 0, 0)).toBeLessThan(0);
    expect(sdf(0, 0, -19.3)).toBeLessThan(0);
  });

  it('grid sampler agrees with pointwise evaluation for TPMS types', () => {
    const sdf = buildSphereLattice(15, params);
    expect(sdf.sampleField).toBeTypeOf('function');
    const res = 8;
    const bounds = { min: [-16, -16, -16] as [number, number, number], max: [16, 16, 16] as [number, number, number] };
    const out = new Float32Array((res + 1) ** 3);
    sdf.sampleField!(bounds, res, out);
    const step = 32 / res;
    let checked = 0;
    for (let z = 0; z <= res; z += 2) {
      for (let y = 0; y <= res; y += 2) {
        for (let x = 0; x <= res; x += 2) {
          const idx = x + y * (res + 1) + z * (res + 1) * (res + 1);
          const direct = sdf(-16 + x * step, -16 + y * step, -16 + z * step);
          expect(out[idx]).toBeCloseTo(direct, 4);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('escape holes', () => {
  it('subtracts a through-hole along the selected build axis', () => {
    const enabled: LatticeParams = {
      ...DEFAULT_PARAMS,
      escapeHoles: true,
      escapeHoleCount: 1,
      escapeHoleDiameter: 5,
      escapeHoleAxis: 'z',
    };
    const disabled: LatticeParams = { ...enabled, escapeHoles: false };
    const withHole = buildSphereLattice(20, enabled);
    const withoutHole = buildSphereLattice(20, disabled);
    expect(withHole(0, 0, 19)).toBeGreaterThan(0);
    expect(withoutHole(0, 0, 19)).toBeLessThan(0);
    expect(withHole(4, 0, 19)).toBeLessThan(0);
  });

  it('does not apply escape holes to no-shell lattices', () => {
    const params: LatticeParams = {
      ...DEFAULT_PARAMS,
      noShell: true,
      escapeHoles: true,
      escapeHoleCount: 1,
      escapeHoleAxis: 'z',
    };
    const sdf = buildSphereLattice(20, params);
    expect(Number.isFinite(sdf(0, 0, 0))).toBe(true);
  });
});

describe('buildAnalyticLattice modes', () => {
  const cube = (x: number, y: number, z: number) => {
    const dx = Math.abs(x) - 15;
    const dy = Math.abs(y) - 15;
    const dz = Math.abs(z) - 15;
    const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
    const inside = Math.min(Math.max(dx, dy, dz), 0);
    return outside + inside;
  };

  it('noShell leaves no shell band but clips lattice to the object', () => {
    const params: LatticeParams = { ...DEFAULT_PARAMS, noShell: true };
    const sdf = buildAnalyticLattice(cube, params);
    expect(sdf(25, 0, 0)).toBeGreaterThan(0); // outside object: empty
  });

  it('surfaceOnly hollows out the deep interior', () => {
    const params: LatticeParams = { ...DEFAULT_PARAMS, surfaceOnly: true, surfaceDepth: 3 };
    const sdf = buildAnalyticLattice(cube, params);
    expect(sdf(0, 0, 0)).toBeGreaterThan(0); // center is far deeper than the band
  });
});
