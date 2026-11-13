// Characterization of closeBoundaryLoops on marching-cubes output. The digests
// below were captured from the position-hashing weld before marching cubes
// could emit grid vertex ids; the id weld must reproduce them byte for byte,
// for whole-grid and windowed extraction, including fields with many samples
// exactly at the iso value (vertices on grid corners, reached from several
// edges).
import { describe, expect, it } from 'vitest';
import { createDeterministicRandom } from './deterministic-random';
import {
  marchingCubesFromField,
  marchingCubesFromFieldWindow,
  sealFieldBoundary,
  type MarchingCubesResult,
} from './marching-cubes';
import { closeBoundaryLoops, type RepairWorkCounters } from './mesh-repair';
import type { Vec3 } from './vec3';

type Bounds = { min: Vec3; max: Vec3 };

function digest(result: MarchingCubesResult): string {
  let fnv = 2166136261;
  let mix = 0x9e3779b9;
  for (const array of [result.positions, result.normals]) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i++) fnv = Math.imul((fnv ^ bytes[i]) >>> 0, 16777619) >>> 0;
    const words = new Uint32Array(array.buffer, array.byteOffset, array.length);
    for (let i = 0; i < words.length; i++) {
      mix = Math.imul(mix ^ words[i], 0x85ebca6b) >>> 0;
      mix = (mix ^ (mix >>> 13)) >>> 0;
    }
  }
  return `${result.triCount}:${fnv.toString(16)}:${mix.toString(16)}`;
}

function sampleField(f: (x: number, y: number, z: number) => number, bounds: Bounds, cells: Vec3): Float32Array {
  const [nx, ny, nz] = cells;
  const dx = (bounds.max[0] - bounds.min[0]) / nx;
  const dy = (bounds.max[1] - bounds.min[1]) / ny;
  const dz = (bounds.max[2] - bounds.min[2]) / nz;
  const field = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  let i = 0;
  for (let z = 0; z <= nz; z++) {
    for (let y = 0; y <= ny; y++) {
      for (let x = 0; x <= nx; x++) {
        field[i++] = f(bounds.min[0] + x * dx, bounds.min[1] + y * dy, bounds.min[2] + z * dz);
      }
    }
  }
  return field;
}

// Self-contained fields, so edits to the lattice builders cannot move them.
function gyroid(x: number, y: number, z: number, cell: number, thickness: number): number {
  const k = (2 * Math.PI) / cell;
  const g = Math.sin(k * x) * Math.cos(k * y) + Math.sin(k * y) * Math.cos(k * z) + Math.sin(k * z) * Math.cos(k * x);
  return (Math.abs(g) - thickness) * (cell / (2 * Math.PI));
}

const sphereGyroid = (x: number, y: number, z: number) =>
  Math.max(Math.hypot(x, y, z) - 25, gyroid(x, y, z, 10, 0.4));
const cubeGyroid = (x: number, y: number, z: number) =>
  Math.max(Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) - 18, gyroid(x, y, z, 9, 0.5));
/** Quantized to quarter millimetres: a large share of samples are exactly zero. */
const quantizedGyroid = (x: number, y: number, z: number) => Math.round(sphereGyroid(x, y, z) * 4) / 4;
const quantizedCubeGyroid = (x: number, y: number, z: number) => Math.round(cubeGyroid(x, y, z) * 8) / 8;

interface FieldFixture {
  name: string;
  bounds: Bounds;
  cells: Vec3;
  field: () => Float32Array;
}

function analytic(name: string, f: (x: number, y: number, z: number) => number, bounds: Bounds, cells: Vec3): FieldFixture {
  return {
    name,
    bounds,
    cells,
    field: () => {
      const field = sampleField(f, bounds, cells);
      sealFieldBoundary(field, cells, 0);
      return field;
    },
  };
}

/** Samples drawn from {-1, 0, 1}: a third exact zeros, every ambiguous case. */
function ternaryField(name: string, cells: Vec3, seed: number, bounds: Bounds): FieldFixture {
  return {
    name,
    bounds,
    cells,
    field: () => {
      const random = createDeterministicRandom(seed, 'mc-vertex-ids-ternary');
      const field = new Float32Array((cells[0] + 1) * (cells[1] + 1) * (cells[2] + 1));
      for (let i = 0; i < field.length; i++) field[i] = Math.floor(random() * 3) - 1;
      return field;
    },
  };
}

/** Planes through grid corners: every surface vertex lies exactly on a corner. */
const cornerPlanes = (x: number, y: number, z: number) => {
  const s = Math.round(x + 2 * y - z);
  return ((s % 5) + 5) % 5 - 2;
};

const FIELD_FIXTURES: FieldFixture[] = [
  analytic('sphere-gyroid-64', sphereGyroid, { min: [-29, -29, -29], max: [29, 29, 29] }, [64, 64, 64]),
  analytic('cube-gyroid-64', cubeGyroid, { min: [-20, -20, -20], max: [20, 20, 20] }, [64, 64, 64]),
  analytic('quantized-gyroid-64', quantizedGyroid, { min: [-29, -29, -29], max: [29, 29, 29] }, [64, 64, 64]),
  analytic('quantized-cube-gyroid-64', quantizedCubeGyroid, { min: [-20, -20, -20], max: [20, 20, 20] }, [64, 64, 64]),
  analytic('offset-rect-gyroid', (x, y, z) => gyroid(x, y, z, 7.3, 0.3), { min: [60.1, 59.7, 61.3], max: [84.4, 80.2, 83.9] }, [57, 43, 61]),
  analytic('corner-planes-24', cornerPlanes, { min: [0, 0, 0], max: [24, 24, 24] }, [24, 24, 24]),
  ternaryField('ternary-20', [20, 20, 20], 3, { min: [-1, -1, -1], max: [1, 1, 1] }),
  ternaryField('ternary-rect', [17, 9, 13], 5, { min: [0.1, 0.2, 0.3], max: [1.7, 1.1, 1.6] }),
];

/** Copy the samples of one window of a whole-grid field. */
function windowField(field: Float32Array, cells: Vec3, origin: Vec3, size: Vec3): Float32Array {
  const out = new Float32Array((size[0] + 1) * (size[1] + 1) * (size[2] + 1));
  const sy = cells[0] + 1, sz = sy * (cells[1] + 1);
  let i = 0;
  for (let z = 0; z <= size[2]; z++) {
    for (let y = 0; y <= size[1]; y++) {
      for (let x = 0; x <= size[0]; x++) out[i++] = field[origin[0] + x + (origin[1] + y) * sy + (origin[2] + z) * sz];
    }
  }
  return out;
}

interface WindowedExtraction {
  result: MarchingCubesResult;
  ids: Uint32Array | null;
}

/**
 * Extract in windows of `tile` cells and interleave their rows into
 * whole-grid emission order, as mergeMeshTilesInGridOrder does.
 */
function extractWindowed(
  field: Float32Array,
  bounds: Bounds,
  cells: Vec3,
  tile: number,
  vertexIds: boolean,
): WindowedExtraction {
  const per = cells.map((c) => Math.ceil(c / tile));
  const windows: { origin: Vec3; size: Vec3; result: ReturnType<typeof marchingCubesFromFieldWindow> }[] = [];
  for (let tz = 0; tz < per[2]; tz++) {
    for (let ty = 0; ty < per[1]; ty++) {
      for (let tx = 0; tx < per[0]; tx++) {
        const origin: Vec3 = [tx * tile, ty * tile, tz * tile];
        const size: Vec3 = [0, 1, 2].map((a) => Math.min(tile, cells[a] - origin[a])) as Vec3;
        const sub = windowField(field, cells, origin, size);
        const result = marchingCubesFromFieldWindow(sub, bounds, cells, origin, size, 0, { vertexIds });
        windows.push({ origin, size, result });
      }
    }
  }
  const triCount = windows.reduce((sum, w) => sum + w.result.triCount, 0);
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 3);
  const allHaveIds = vertexIds && windows.every((w) => w.result.vertexIds);
  const ids = allHaveIds ? new Uint32Array(triCount * 3) : null;
  let written = 0;
  for (let gz = 0; gz < cells[2]; gz++) {
    const tz = Math.floor(gz / tile);
    for (let gy = 0; gy < cells[1]; gy++) {
      const ty = Math.floor(gy / tile);
      for (let tx = 0; tx < per[0]; tx++) {
        const w = windows[tx + per[0] * (ty + per[1] * tz)];
        const row = (gz - tz * tile) * w.size[1] + (gy - ty * tile);
        const start = w.result.rowTriangleStarts[row];
        const end = w.result.rowTriangleStarts[row + 1];
        positions.set(w.result.positions.subarray(start * 9, end * 9), written * 9);
        normals.set(w.result.normals.subarray(start * 3, end * 3), written * 3);
        if (ids) ids.set(w.result.vertexIds!.ids.subarray(start * 3, end * 3), written * 3);
        written += end - start;
      }
    }
  }
  return { result: { positions, normals, triCount }, ids };
}

const CAPTURE = process.env.CAPTURE_REPAIR_DIGESTS === '1';

// Captured from the position-hashing weld (raw extraction digest, repaired
// digest, report) before vertex ids existed.
const EXPECTED: Record<string, { raw: string; repaired: string; report: string }> = {
  'sphere-gyroid-64': { raw: '155528:df37dfd8:c83ca6d9', repaired: '155528:df37dfd8:c83ca6d9', report: '{"loopsClosed":0,"trianglesAdded":0,"loopsUnresolved":0}' },
  'cube-gyroid-64': { raw: '247470:de4848b4:680d312', repaired: '247488:99ae40a6:180d85c6', report: '{"loopsClosed":9,"trianglesAdded":18,"loopsUnresolved":0}' },
  'quantized-gyroid-64': { raw: '127576:2366b2c7:881b994', repaired: '127576:2366b2c7:881b994', report: '{"loopsClosed":0,"trianglesAdded":0,"loopsUnresolved":0}' },
  'quantized-cube-gyroid-64': { raw: '207759:e89891f5:2a96aab9', repaired: '207768:b8590f46:1ec92df7', report: '{"loopsClosed":9,"trianglesAdded":9,"loopsUnresolved":0}' },
  'offset-rect-gyroid': { raw: '168094:317b08c7:92a98ce9', repaired: '168116:2f4625f2:632ac948', report: '{"loopsClosed":11,"trianglesAdded":22,"loopsUnresolved":0}' },
  'corner-planes-24': { raw: '34482:9df76c30:65c0936c', repaired: '34482:9df76c30:65c0936c', report: '{"loopsClosed":0,"trianglesAdded":0,"loopsUnresolved":0}' },
  'ternary-20': { raw: '17603:cfd14d70:63e8d783', repaired: '17786:f74d699:a1b5e3b0', report: '{"loopsClosed":60,"trianglesAdded":183,"loopsUnresolved":333}' },
  'ternary-rect': { raw: '4266:514fedbe:aa01b9e1', repaired: '4403:993449f9:c5e2a69a', report: '{"loopsClosed":41,"trianglesAdded":137,"loopsUnresolved":124}' },
};

function newCounters(): RepairWorkCounters {
  return { corners: 0, weldProbes: 0, edgeVisits: 0, loopSteps: 0 };
}

function floatKey(positions: Float32Array, corner: number): string {
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const o = corner * 3;
  const word = (w: number) => (w === 0x80000000 ? 0 : w);
  return `${word(bits[o])},${word(bits[o + 1])},${word(bits[o + 2])}`;
}

/** Ids and float-bit positions must partition the vertex references identically. */
function expectSameClasses(result: MarchingCubesResult, ids: Uint32Array): { cornerIds: number; distinct: number } {
  const idToPosition = new Map<number, string>();
  const positionToId = new Map<string, number>();
  let cornerIds = 0;
  for (let k = 0; k < result.triCount * 3; k++) {
    const key = floatKey(result.positions, k);
    const id = ids[k];
    if ((id & 3) === 3) cornerIds++;
    const seenPosition = idToPosition.get(id);
    if (seenPosition !== undefined && seenPosition !== key) throw new Error(`id ${id} names two positions`);
    const seenId = positionToId.get(key);
    if (seenId !== undefined && seenId !== id) throw new Error(`position ${key} has ids ${seenId} and ${id}`);
    idToPosition.set(id, key);
    positionToId.set(key, id);
  }
  return { cornerIds, distinct: idToPosition.size };
}

function keyedExtraction(fixture: FieldFixture, field = fixture.field()): MarchingCubesResult {
  return marchingCubesFromField(field, fixture.bounds, fixture.cells, 0, undefined, { vertexIds: true });
}

describe('closeBoundaryLoops characterization on marching-cubes fields', () => {
  it.each(FIELD_FIXTURES.map((f) => [f.name, f] as const))('%s', (name, fixture) => {
    const field = fixture.field();
    const raw = marchingCubesFromField(field, fixture.bounds, fixture.cells, 0);
    const { result, report } = closeBoundaryLoops(raw);
    const windowed = extractWindowed(field, fixture.bounds, fixture.cells, 20, false);
    expect(digest(windowed.result)).toBe(digest(raw));
    const actual = { raw: digest(raw), repaired: digest(result), report: JSON.stringify(report) };
    if (CAPTURE) console.log(`  '${name}': ${JSON.stringify(actual)},`);
    else expect(actual).toEqual(EXPECTED[name]);

    // Whole grid with ids: the same triangles, and the id weld reproduces the
    // captured repair exactly.
    const keyed = keyedExtraction(fixture, field);
    expect(digest(keyed)).toBe(EXPECTED[name].raw);
    expect(keyed.vertexIds).toBeDefined();
    expect(keyed.vertexIds!.ids.length).toBe(keyed.triCount * 3);
    expect(keyed.vertexIds!.gridCells).toEqual(fixture.cells);
    const counters = newCounters();
    const fast = closeBoundaryLoops(keyed, counters, { vertexIds: keyed.vertexIds });
    expect(counters.gridIdCorners).toBe(keyed.triCount * 3);
    expect(digest(fast.result)).toBe(EXPECTED[name].repaired);
    expect(JSON.stringify(fast.report)).toBe(EXPECTED[name].report);
    if (fast.report.trianglesAdded === 0) expect(fast.result).toBe(keyed);

    // Windows interleaved into grid order carry the whole-grid ids.
    const tiled = extractWindowed(field, fixture.bounds, fixture.cells, 20, true);
    expect(tiled.ids).not.toBeNull();
    expect(tiled.ids).toEqual(keyed.vertexIds!.ids);
    const tiledCounters = newCounters();
    const tiledFast = closeBoundaryLoops(tiled.result, tiledCounters, {
      vertexIds: { ids: tiled.ids!, gridCells: fixture.cells },
    });
    expect(tiledCounters.gridIdCorners).toBe(keyed.triCount * 3);
    expect(digest(tiledFast.result)).toBe(EXPECTED[name].repaired);
  });

  it.each(FIELD_FIXTURES.map((f) => [f.name, f] as const))('ids partition %s exactly as float bits do', (_name, fixture) => {
    const keyed = keyedExtraction(fixture);
    expect(expectSameClasses(keyed, keyed.vertexIds!.ids).distinct).toBeGreaterThan(0);
  });

  it('canonicalizes vertices on exact-zero samples to one corner id', () => {
    // Exact zeros emit the same corner position from up to six edges; edge ids
    // alone would split vertices that the position weld joins.
    for (const name of ['quantized-gyroid-64', 'quantized-cube-gyroid-64', 'corner-planes-24', 'ternary-20']) {
      const fixture = FIELD_FIXTURES.find((f) => f.name === name)!;
      const field = fixture.field();
      const keyed = keyedExtraction(fixture, field);
      const { cornerIds } = expectSameClasses(keyed, keyed.vertexIds!.ids);
      expect(cornerIds, name).toBeGreaterThan(1000);
      // Every corner id names a sample holding exactly the iso value.
      for (const id of keyed.vertexIds!.ids) {
        if ((id & 3) === 3 && field[id >>> 2] !== 0) throw new Error(`${name}: corner id ${id} on a non-zero sample`);
      }
    }
  });

  it('names vertices at t = 0 and t = 1 by their sample, whichever edge emits them', () => {
    const extract = (field: number[], cells: Vec3) => {
      const bounds: Bounds = { min: [0, 0, 0], max: cells };
      const keyed = marchingCubesFromField(new Float32Array(field), bounds, cells, 0, undefined, { vertexIds: true });
      expect(keyed.triCount).toBeGreaterThan(0);
      expectSameClasses(keyed, keyed.vertexIds!.ids);
      return [...keyed.vertexIds!.ids];
    };
    // Sample (0,0,0) is zero and (0,1,0) inside: the y edge between them ends
    // at t = 0, on sample 0.
    expect(extract([0, 1, -1, 1, 1, 1, 1, 1], [1, 1, 1])).toContain(0 * 4 + 3);
    // Reversed: t = 1, on sample 2 = (0,1,0).
    expect(extract([-1, 1, 0, 1, 1, 1, 1, 1], [1, 1, 1])).toContain(2 * 4 + 3);
    // Two cubes reach the zero sample (1,0,0) along different x edges, at
    // t = 1 from the left and t = 0 from the right: one id.
    const ids = extract([-1, 0, -1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [2, 1, 1]);
    expect(ids.filter((id) => id === 1 * 4 + 3).length).toBeGreaterThanOrEqual(2);
    expect(ids.some((id) => id === 0 * 4 + 0 || id === 1 * 4 + 0)).toBe(false);
  });
});

describe('grid vertex id fallbacks', () => {
  const fixture = FIELD_FIXTURES.find((f) => f.name === 'cube-gyroid-64')!;
  const expected = EXPECTED['cube-gyroid-64'].repaired;

  it('falls back to hashing, with identical output, when ids do not match positions', () => {
    const keyed = keyedExtraction(fixture);
    const ids = keyed.vertexIds!.ids.slice();
    ids[1] = ids[0];
    const counters = newCounters();
    const out = closeBoundaryLoops(keyed, counters, { vertexIds: { ids, gridCells: fixture.cells } });
    expect(counters.gridIdCorners).toBeUndefined();
    expect(digest(out.result)).toBe(expected);
  });

  it('falls back when triangles are not in grid slab order', () => {
    const keyed = keyedExtraction(fixture);
    const n = keyed.triCount;
    const positions = new Float32Array(n * 9);
    const normals = new Float32Array(n * 3);
    const ids = new Uint32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const j = n - 1 - i;
      positions.set(keyed.positions.subarray(j * 9, j * 9 + 9), i * 9);
      normals.set(keyed.normals.subarray(j * 3, j * 3 + 3), i * 3);
      ids.set(keyed.vertexIds!.ids.subarray(j * 3, j * 3 + 3), i * 3);
    }
    const reversed: MarchingCubesResult = { positions, normals, triCount: n };
    const counters = newCounters();
    const out = closeBoundaryLoops(reversed, counters, { vertexIds: { ids, gridCells: fixture.cells } });
    expect(counters.gridIdCorners).toBeUndefined();
    expect(digest(out.result)).toBe(digest(closeBoundaryLoops(reversed).result));
  });

  it('falls back when the id count does not match the triangles', () => {
    const keyed = keyedExtraction(fixture);
    const counters = newCounters();
    const out = closeBoundaryLoops(keyed, counters, {
      vertexIds: { ids: keyed.vertexIds!.ids.subarray(3), gridCells: fixture.cells },
    });
    expect(counters.gridIdCorners).toBeUndefined();
    expect(digest(out.result)).toBe(expected);
  });

  it('emits no ids for NaN vertices or grid planes that collide in Float32', () => {
    const bounds: Bounds = { min: [0, 0, 0], max: [1, 1, 1] };
    // An infinite sample against a finite one interpolates to t = NaN.
    const infinite = new Float32Array([Infinity, 1, -1, 1, 1, 1, 1, 1]);
    const nan = marchingCubesFromField(infinite, bounds, [1, 1, 1], 0, undefined, { vertexIds: true });
    expect(nan.triCount).toBeGreaterThan(0);
    expect(nan.vertexIds).toBeUndefined();

    // 1e8 + k * 1e-3 rounds every x plane to the same Float32 value.
    const far: Bounds = { min: [1e8, 0, 0], max: [1e8 + 4e-3, 1, 1] };
    const cells: Vec3 = [4, 1, 1];
    const field = new Float32Array(5 * 2 * 2).map((_, i) => (i % 2 === 0 ? -1 : 1));
    expect(marchingCubesFromField(field, far, cells, 0, undefined, { vertexIds: true }).vertexIds).toBeUndefined();
  });

  it('emits no ids unless asked', () => {
    expect(marchingCubesFromField(fixture.field(), fixture.bounds, fixture.cells).vertexIds).toBeUndefined();
  });
});

describe('grid vertex id weld complexity', () => {
  it('does one slot lookup per corner and linear work as the grid grows', () => {
    const work = (n: number) => {
      const bounds: Bounds = { min: [-29, -29, -29], max: [29, 29, 29] };
      const cells: Vec3 = [n, n, n];
      const field = sampleField(sphereGyroid, bounds, cells);
      sealFieldBoundary(field, cells, 0);
      const keyed = marchingCubesFromField(field, bounds, cells, 0, undefined, { vertexIds: true });
      const counters = newCounters();
      closeBoundaryLoops(keyed, counters, { vertexIds: keyed.vertexIds });
      return counters;
    };
    const small = work(32);
    const large = work(96);
    for (const counters of [small, large]) {
      expect(counters.gridIdCorners).toBe(counters.corners);
      expect(counters.weldProbes).toBe(counters.corners);
      expect(counters.edgeVisits).toBeLessThanOrEqual(counters.corners * 2);
      expect(counters.loopSteps).toBeLessThanOrEqual(counters.corners);
    }
    const growth = large.corners / small.corners;
    expect(growth).toBeGreaterThan(6);
    const total = (c: RepairWorkCounters) => c.weldProbes + c.edgeVisits + c.loopSteps;
    expect(total(large) / total(small)).toBeLessThan(growth * 1.05);
  });
});
