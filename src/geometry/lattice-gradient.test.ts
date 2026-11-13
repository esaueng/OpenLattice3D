import { readFileSync } from 'node:fs';
import { arch } from 'node:os';
import { describe, expect, it } from 'vitest';
import { MeshBVH } from './bvh';
import {
  buildAnalyticLattice,
  buildCombinedSDF,
  buildLatticeGrader,
  buildSphereLattice,
  gradientBaseHalfThickness,
  GRADIENT_FALLOFF_CELLS,
  type SdfFunction,
} from './lattice';
import { parseSTL } from './stl-parser';
import { DEFAULT_PARAMS, type LatticeParams, type LatticeType } from '../types/project';
import type { Vec3 } from './vec3';

const ALL_TYPES: LatticeType[] = [
  'gyroid', 'schwarzP', 'schwarzD', 'neovius', 'iwp', 'spinodal',
  'bcc', 'octet', 'diamond', 'hexagon', 'triangle', 'voronoi',
];

function loadSphereBvh(): MeshBVH {
  const source = readFileSync(new URL('../../public/assets/sphere-25mm.stl', import.meta.url));
  const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  const mesh = parseSTL(buffer);
  return new MeshBVH(mesh.positions, mesh.normals, mesh.triCount);
}

/** FNV-1a over the IEEE-754 bytes, so any bit change is caught. */
function fieldHash(values: number[]): string {
  let hash = 2166136261;
  const bytes = new Uint8Array(new Float64Array(values).buffer);
  for (const byte of bytes) hash = Math.imul((hash ^ byte) >>> 0, 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

/** Pointwise samples of the analytic and imported-mesh fields, plus both grid samplers. */
function characterizeField(params: LatticeParams, bvh: MeshBVH): string {
  const analytic = buildSphereLattice(11, params, 1234);
  const imported = buildCombinedSDF({ bvh, params, generationSeed: 1234 });
  const values: number[] = [];
  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++) {
      for (let k = 0; k <= 10; k++) {
        const x = -12 + 2.4 * i + 0.13;
        const y = -12 + 2.4 * j + 0.07;
        const z = -12 + 2.4 * k + 0.05;
        values.push(analytic(x, y, z), imported(x, y, z));
      }
    }
  }
  const grid = new Float32Array(13 ** 3);
  for (const sdf of [analytic, imported]) {
    if (!sdf.sampleField) continue;
    sdf.sampleField({ min: [-12, -12, -12], max: [12, 12, 12] }, 12, grid);
    values.push(...grid);
  }
  return fieldHash(values);
}

// Captured from the multiplicative implementation before graded density was
// fixed. Gradient-off output must stay bit-identical.
const MODES: Array<Partial<LatticeParams>> = [
  {},
  { noShell: true },
  { surfaceOnly: true },
  { variant: 'implicit_conformal' },
];
const UNGRADED_FIELD_HASHES: Record<string, string> = {
  'gyroid:0': 'c166b46d', 'gyroid:1': 'fa84d016', 'gyroid:2': 'ed7a1216', 'gyroid:3': 'c6f2c35c',
  'schwarzP:0': '0722db90', 'schwarzP:1': '36db0fcb', 'schwarzP:2': 'e64b319b', 'schwarzP:3': 'a9346d43',
  'schwarzD:0': 'fdc176e4', 'schwarzD:1': 'c411ffef', 'schwarzD:2': 'cf3facac', 'schwarzD:3': 'd237f0b2',
  'neovius:0': 'ef957d76', 'neovius:1': '54d3487d', 'neovius:2': 'a8a457c2', 'neovius:3': '05f9ec5a',
  'iwp:0': 'd3f606c1', 'iwp:1': '96f5012b', 'iwp:2': '0fb9a02e', 'iwp:3': '268d555e',
  'spinodal:0': '4e35a9b4', 'spinodal:1': 'aa5d3a99', 'spinodal:2': '7477eeff', 'spinodal:3': '8e87aeff',
  'bcc:0': 'daa4d17c', 'bcc:1': '48e76b07', 'bcc:2': 'ed56c89a', 'bcc:3': 'b359c064',
  'octet:0': '3bbddb85', 'octet:1': 'eb7bbb1c', 'octet:2': '8962775c', 'octet:3': 'a0f54039',
  'diamond:0': 'bb8f80e3', 'diamond:1': 'b9a9641d', 'diamond:2': '24f8ae05', 'diamond:3': '981cbcd7',
  'hexagon:0': 'c08a8c33', 'hexagon:1': '5eceab90', 'hexagon:2': '5eceab90', 'hexagon:3': 'd1180e31',
  'triangle:0': 'acd367c2', 'triangle:1': '94752dcb', 'triangle:2': 'b6dea06d', 'triangle:3': '5f198394',
  'voronoi:0': '29b538bb', 'voronoi:1': '9f913d3a', 'voronoi:2': 'c7e52981', 'voronoi:3': 'e2f0be26',
};

// Captured from the same pre-fix implementation on arm64, where some
// transcendental operations produce different low bits in the spinodal field.
const ARM64_SPINODAL_HASHES = ['e3632ddd', '57f9ee8f', 'c6c7160f', '32a25382'];

/** Deterministic, well-spread points in a spherical shell between two radii. */
function shellPoints(innerRadius: number, outerRadius: number, count: number): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const u = (i * 0.6180339887498949) % 1;
    const v = (i * 0.7548776662466927) % 1;
    const w = (i * 0.5698402909980532) % 1;
    const theta = Math.acos(1 - 2 * u);
    const phi = 2 * Math.PI * v;
    const r = innerRadius + (outerRadius - innerRadius) * w;
    points.push([
      r * Math.sin(theta) * Math.cos(phi),
      r * Math.sin(theta) * Math.sin(phi),
      r * Math.cos(theta),
    ]);
  }
  return points;
}

function insideFraction(sdf: SdfFunction, points: Vec3[]): number {
  let inside = 0;
  for (const p of points) if (sdf(p[0], p[1], p[2]) < 0) inside++;
  return inside / points.length;
}

/** Distance along `direction` from `point` (inside material) to the zero level set. */
function distanceToBoundary(evaluate: SdfFunction, point: Vec3, direction: Vec3): number {
  const at = (t: number) => evaluate(
    point[0] + direction[0] * t,
    point[1] + direction[1] * t,
    point[2] + direction[2] * t,
  );
  let low = 0;
  let high = 0.5;
  while (at(high) <= 0 && high < 16) high *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) * 0.5;
    if (at(mid) <= 0) low = mid;
    else high = mid;
  }
  return (low + high) * 0.5;
}

function thicknessAcross(evaluate: SdfFunction, point: Vec3, direction: Vec3): number {
  return distanceToBoundary(evaluate, point, direction)
    + distanceToBoundary(evaluate, point, [-direction[0], -direction[1], -direction[2]]);
}

/** Material fills z < skinZ; depth below the skin is constant along x and y. */
const halfSpaceBelow = (skinZ: number) => (_x: number, _y: number, z: number) => z - skinZ;

describe('graded density: ungraded characterization', () => {
  const bvh = loadSphereBvh();
  it.each(ALL_TYPES)('%s field is bit-identical to the pre-fix implementation when grading is off', (latticeType) => {
    for (const [modeIndex, mode] of MODES.entries()) {
      // A non-default strength must not leak into the field while grading is off.
      const params: LatticeParams = {
        ...DEFAULT_PARAMS,
        latticeType,
        ...mode,
        gradientEnabled: false,
        gradientStrength: 0.8,
      };
      const key = `${latticeType}:${modeIndex}`;
      const expected = arch() === 'arm64' && latticeType === 'spinodal'
        ? ARM64_SPINODAL_HASHES[modeIndex]
        : UNGRADED_FIELD_HASHES[key];
      expect(characterizeField(params, bvh), key).toBe(expected);
    }
  });
});

describe('graded density: thickness', () => {
  it('picks the thickness parameter that each lattice field encodes', () => {
    const base = { ...DEFAULT_PARAMS, wallThickness: 1.2, strutDiameter: 0.8 };
    for (const type of ['gyroid', 'schwarzP', 'schwarzD', 'neovius', 'iwp', 'spinodal'] as const) {
      expect(gradientBaseHalfThickness({ ...base, latticeType: type })).toBeCloseTo(0.6, 12);
    }
    for (const type of ['bcc', 'octet', 'diamond', 'hexagon', 'triangle', 'voronoi'] as const) {
      expect(gradientBaseHalfThickness({ ...base, latticeType: type })).toBeCloseTo(0.4, 12);
    }
  });

  it('is disabled when off or at zero strength', () => {
    expect(buildLatticeGrader({ ...DEFAULT_PARAMS, gradientEnabled: false, gradientStrength: 1 }, false)).toBeNull();
    expect(buildLatticeGrader({ ...DEFAULT_PARAMS, gradientEnabled: true, gradientStrength: 0 }, false)).toBeNull();
  });

  it('measures depth from the inside of the shell when asked', () => {
    const params: LatticeParams = { ...DEFAULT_PARAMS, gradientEnabled: true, gradientStrength: 1, shellThickness: 2 };
    const amplitude = gradientBaseHalfThickness(params);
    const fromShell = buildLatticeGrader(params, true)!;
    const fromSkin = buildLatticeGrader(params, false)!;
    expect(fromShell(0, -2)).toBeCloseTo(-amplitude, 12);
    expect(fromSkin(0, 0)).toBeCloseTo(-amplitude, 12);
    const falloff = params.cellSize * GRADIENT_FALLOFF_CELLS;
    expect(fromShell(0, -2 - falloff)).toBeCloseTo(-amplitude * Math.exp(-1), 12);
  });

  // Schwarz P at (L/4, L/2, 0) has a sheet normal along x, parallel to the
  // skin plane, so the whole wall sits at one depth. The TPMS sheet distance is
  // a first-order estimate, so a large cell keeps it accurate to a few percent.
  it.each([0.25, 0.5, 1])('thickens a TPMS sheet near the skin by (1 + strength) at strength %s', (strength) => {
    const cellSize = 20;
    const wallThickness = 1;
    const depth = 0.1;
    const point: Vec3 = [cellSize / 4, cellSize / 2, 0];
    const base: LatticeParams = {
      ...DEFAULT_PARAMS,
      latticeType: 'schwarzP',
      cellSize,
      wallThickness,
      noShell: true,
    };
    const ungraded = buildAnalyticLattice(halfSpaceBelow(depth), base);
    const graded = buildAnalyticLattice(halfSpaceBelow(depth), { ...base, gradientEnabled: true, gradientStrength: strength });
    const nominal = thicknessAcross(ungraded, point, [1, 0, 0]);
    const thick = thicknessAcross(graded, point, [1, 0, 0]);
    const expectedFactor = 1 + strength * Math.exp(-depth / (cellSize * GRADIENT_FALLOFF_CELLS));
    expect(nominal).toBeGreaterThan(wallThickness * 0.97);
    expect(nominal).toBeLessThan(wallThickness * 1.03);
    expect(thick / nominal).toBeGreaterThan(expectedFactor * 0.97);
    expect(thick / nominal).toBeLessThan(expectedFactor * 1.03);
  });

  it('thickens a BCC strut near the skin exactly by (1 + strength) and fades with depth', () => {
    const cellSize = 8;
    const strutDiameter = 0.8;
    const strength = 0.75;
    // Midpoint of the x-axis edge strut; walk across it along y at constant depth.
    const point: Vec3 = [cellSize / 2, 0, 0];
    const falloff = cellSize * GRADIENT_FALLOFF_CELLS;
    for (const depth of [0.2, falloff, 4 * falloff]) {
      const params: LatticeParams = {
        ...DEFAULT_PARAMS,
        latticeType: 'bcc',
        cellSize,
        strutDiameter,
        noShell: true,
        gradientEnabled: true,
        gradientStrength: strength,
      };
      const graded = buildAnalyticLattice(halfSpaceBelow(depth), params);
      const diameter = thicknessAcross(graded, point, [0, 1, 0]);
      expect(diameter).toBeCloseTo(strutDiameter * (1 + strength * Math.exp(-depth / falloff)), 6);
    }
  });
});

describe('graded density: inside-material fraction', () => {
  it('increases monotonically with strength in a band just under the skin', () => {
    const radius = 20;
    // Default shell + core: 1.5 mm shell, so the band starts at the shell's inside.
    const band = shellPoints(radius - 6, radius - 1.5, 20000);
    const fractions = [0, 0.25, 0.5, 0.75, 1].map((strength) => insideFraction(
      buildSphereLattice(radius, { ...DEFAULT_PARAMS, gradientEnabled: strength > 0, gradientStrength: strength }),
      band,
    ));
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThan(fractions[i - 1] + 0.01);
    }
    // Strength 1 roughly doubles wall thickness here, so the band gains a lot of material.
    expect(fractions[4]).toBeGreaterThan(fractions[0] * 1.4);
  });

  it('leaves the core unchanged far beyond the falloff', () => {
    const radius = 150;
    const cellSize = 4;
    const falloff = cellSize * GRADIENT_FALLOFF_CELLS; // 12 mm
    const base: LatticeParams = { ...DEFAULT_PARAMS, cellSize };
    // More than ten falloff lengths below the shell's inside.
    const core = shellPoints(5, radius - base.shellThickness - 10 * falloff, 20000);
    const ungraded = buildSphereLattice(radius, base);
    const graded = buildSphereLattice(radius, { ...base, gradientEnabled: true, gradientStrength: 1 });
    expect(insideFraction(graded, core)).toBeCloseTo(insideFraction(ungraded, core), 3);
    let maxShift = 0;
    for (const p of core) maxShift = Math.max(maxShift, Math.abs(graded(...p) - ungraded(...p)));
    expect(maxShift).toBeLessThan(gradientBaseHalfThickness(base) * Math.exp(-10) * 1.0001);
  });
});

describe('graded density: determinism and sampler parity', () => {
  const bvh = loadSphereBvh();
  const graded = (latticeType: LatticeType): LatticeParams => ({
    ...DEFAULT_PARAMS,
    latticeType,
    gradientEnabled: true,
    gradientStrength: 0.7,
  });

  it.each(['gyroid', 'bcc', 'voronoi', 'spinodal'] as const)('%s graded field is reproducible', (latticeType) => {
    const params = graded(latticeType);
    expect(characterizeField(params, bvh)).toBe(characterizeField(params, bvh));
    expect(characterizeField(params, bvh)).not.toBe(characterizeField({ ...params, gradientEnabled: false }, bvh));
  });

  it.each([
    ['analytic shell + core', (p: LatticeParams) => buildSphereLattice(11, p)],
    ['analytic no shell', (p: LatticeParams) => buildSphereLattice(11, { ...p, noShell: true })],
    ['imported shell + core', (p: LatticeParams) => buildCombinedSDF({ bvh, params: p })],
    ['imported conformal', (p: LatticeParams) => buildCombinedSDF({ bvh, params: { ...p, variant: 'implicit_conformal' } })],
  ] as const)('TPMS grid sampler applies the same grading as pointwise evaluation (%s)', (_label, build) => {
    const sdf = build(graded('gyroid'));
    expect(sdf.sampleField).toBeTypeOf('function');
    const res = 12;
    const out = new Float32Array((res + 1) ** 3);
    sdf.sampleField!({ min: [-12, -12, -12], max: [12, 12, 12] }, res, out);
    const step = 24 / res;
    for (let z = 0; z <= res; z += 3) {
      for (let y = 0; y <= res; y += 3) {
        for (let x = 0; x <= res; x += 3) {
          const index = x + y * (res + 1) + z * (res + 1) * (res + 1);
          expect(out[index]).toBeCloseTo(sdf(-12 + x * step, -12 + y * step, -12 + z * step), 4);
        }
      }
    }
  });
});
