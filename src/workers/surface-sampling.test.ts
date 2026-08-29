import { describe, expect, it } from 'vitest';
import { createDeterministicRandom } from '../geometry/deterministic-random';
import {
  buildMeshSampler,
  buildSurfaceSampleJobs,
  generateShapeSurfaceSamples,
  pickTriangleIndex,
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
