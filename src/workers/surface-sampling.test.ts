import { describe, expect, it } from 'vitest';
import { createDeterministicRandom } from '../geometry/deterministic-random';
import {
  buildMeshSampler,
  buildSurfaceSampleJobs,
  generateShapeSurfaceSamples,
  pickTriangleIndex,
  sampleSurfacePointForShape,
  type ShapeSampleParams,
} from './surface-sampling';

function samplerMesh() {
  return {
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 2, 0, // area 1
      10, 0, 0, 10, 0, 0, 10, 0, 0, // degenerate
      20, 0, 0, 22, 0, 0, 20, 3, 0, // area 3
      30, 0, 0, 31, 0, 0, 30, 2, 0, // area 1
    ]),
    normals: new Float32Array([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]),
    triCount: 4,
  };
}

describe('keep-out-aware mesh surface sampling', () => {
  it('returns null for all-excluded and all-degenerate meshes', () => {
    const mesh = samplerMesh();
    expect(buildMeshSampler(mesh.positions, mesh.normals, mesh.triCount, new Set([0, 1, 2, 3]))).toBeNull();
    expect(buildMeshSampler(mesh.positions, mesh.normals, 1, new Set([0]))).toBeNull();
  });

  it('preserves a nondecreasing cumulative array through sparse exclusions and degenerates', () => {
    const mesh = samplerMesh();
    const sampler = buildMeshSampler(
      mesh.positions,
      mesh.normals,
      mesh.triCount,
      new Set([2]),
      createDeterministicRandom(7, 'test'),
    );
    expect(sampler).not.toBeNull();
    expect(Array.from(sampler!.cumulativeAreas)).toEqual([1, 1, 1, 2]);
    for (let i = 1; i < sampler!.cumulativeAreas.length; i++) {
      expect(sampler!.cumulativeAreas[i]).toBeGreaterThanOrEqual(sampler!.cumulativeAreas[i - 1]);
    }
    for (let i = 0; i < 2_000; i++) expect([0, 3]).toContain(sampler!.sample().triangleIndex);
  });

  it('binary-searches strictly past zero-area and excluded plateaus', () => {
    const cumulative = new Float64Array([0, 0, 2, 2, 5, 5]);
    expect(pickTriangleIndex(cumulative, 5, () => 0)).toBe(2);
    expect(pickTriangleIndex(cumulative, 5, () => 0.4)).toBe(4);
    expect(pickTriangleIndex(cumulative, 5, () => 0.999999)).toBe(4);
  });

  it('samples eligible triangles in proportion to surface area', () => {
    const mesh = samplerMesh();
    const sampler = buildMeshSampler(
      mesh.positions,
      mesh.normals,
      mesh.triCount,
      new Set([3]),
      createDeterministicRandom(0x12345678, 'statistical-test'),
    )!;
    const counts = new Map<number, number>();
    for (let i = 0; i < 20_000; i++) {
      const triangle = sampler.sample().triangleIndex;
      counts.set(triangle, (counts.get(triangle) ?? 0) + 1);
    }
    expect(counts.has(1)).toBe(false);
    expect(counts.has(3)).toBe(false);
    const smallShare = (counts.get(0) ?? 0) / 20_000;
    expect(smallShare).toBeGreaterThan(0.23);
    expect(smallShare).toBeLessThan(0.27);
  });
});

describe('surface sampling logical worker streams', () => {
  it('produces identical samples for serial and differently scheduled execution', () => {
    const jobs = buildSurfaceSampleJobs(2026, 'cube', 80);
    const run = (job: (typeof jobs)[number]) => generateShapeSurfaceSamples(
      'cube',
      { halfSize: 15 },
      job.targetCount,
      2,
      job.streamSeed,
    );
    const serial = jobs.map((job) => [job.streamId, run(job)] as const);
    const scheduled = [jobs[3], jobs[1], jobs[0], jobs[2]]
      .map((job) => [job.streamId, run(job)] as const)
      .sort((a, b) => a[0] - b[0]);
    expect(scheduled).toEqual(serial);
  });
});

describe('capsule surface sampling', () => {
  it('places every sample on the capsule surface with an outward normal', () => {
    const radius = 12;
    const halfHeight = 15;
    const random = createDeterministicRandom(2026, 'capsule-test');
    const capsuleSdf = (p: readonly number[]) => {
      const z = Math.max(-halfHeight, Math.min(halfHeight, p[2]));
      return Math.hypot(p[0], p[1], p[2] - z) - radius;
    };
    let capSamples = 0;
    for (let i = 0; i < 5_000; i++) {
      const { pos, normal } = sampleSurfacePointForShape(
        'capsule',
        { capRadius: radius, capHalfHeight: halfHeight },
        random,
      );
      expect(Math.abs(capsuleSdf(pos))).toBeLessThan(1e-9);
      // The normal is the direction from the nearest axis point to the sample.
      const axisZ = Math.max(-halfHeight, Math.min(halfHeight, pos[2]));
      const outward = [pos[0] / radius, pos[1] / radius, (pos[2] - axisZ) / radius];
      const dot = normal[0] * outward[0] + normal[1] * outward[1] + normal[2] * outward[2];
      expect(dot).toBeGreaterThan(1 - 1e-9);
      // Stepping along the normal leaves the solid; stepping against it enters.
      const step = 0.01;
      expect(capsuleSdf([pos[0] + normal[0] * step, pos[1] + normal[1] * step, pos[2] + normal[2] * step])).toBeGreaterThan(0);
      expect(capsuleSdf([pos[0] - normal[0] * step, pos[1] - normal[1] * step, pos[2] - normal[2] * step])).toBeLessThan(0);
      if (Math.abs(pos[2]) > halfHeight + 1e-9) capSamples++;
    }
    // Caps hold 4*pi*r^2 / (4*pi*r^2 + 4*pi*r*h) = r / (r + h) = 12 / 27 of the area.
    expect(capSamples / 5_000).toBeGreaterThan(12 / 27 - 0.03);
    expect(capSamples / 5_000).toBeLessThan(12 / 27 + 0.03);
  });
});

describe('procedural surface sampling defaults', () => {
  it('defaults to the shared sample-shape dimensions without changing any sample', () => {
    // The literal defaults used before they were read from SAMPLE_SHAPE_DIMENSIONS.
    const legacyDefaults: ShapeSampleParams = {
      radius: 25,
      halfSize: 15,
      cylRadius: 15,
      cylHalfHeight: 20,
      torusMajor: 20,
      torusTube: 8,
      capRadius: 12,
      capHalfHeight: 15,
    };
    for (const shape of ['sphere', 'cube', 'cylinder', 'torus', 'capsule'] as const) {
      const derived = createDeterministicRandom(11, 'defaults', shape);
      const legacy = createDeterministicRandom(11, 'defaults', shape);
      for (let i = 0; i < 200; i++) {
        expect(sampleSurfacePointForShape(shape, {}, derived))
          .toEqual(sampleSurfacePointForShape(shape, legacyDefaults, legacy));
      }
    }
  });
});
