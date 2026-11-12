// The executable parity gate: every fixture must agree between backends
// within the documented tolerances. Today this pins cpu-tiled against the
// cpu-single reference; when a webgpu-mc backend lands it joins BACKENDS and
// must pass the same gate before promotion. docs/performance/parity-gates.md
import { describe, expect, it } from 'vitest';
import { cpuSingleBackend, createCpuTiledBackend } from './cpu-backends';
import { PARITY_FIXTURES } from './fixtures';
import { checkAnalyticOuterDeviation } from '../geometry/shape-deviation';
import { cubeSdf, SAMPLE_SHAPE_DIMENSIONS, sampleShapeObjectSdf } from '../geometry/sample-shapes';
import { compareBackendResults, formatParityReport, validateFixtureResult } from './parity';
import type { MarchingCubesBackend } from './types';

const BACKENDS: readonly MarchingCubesBackend[] = [createCpuTiledBackend()];

describe('marching-cubes backend parity gate', () => {
  for (const fixture of PARITY_FIXTURES) {
    it(`${fixture.name}: ${fixture.description}`, async () => {
      const reference = await cpuSingleBackend.run(fixture);
      for (const candidate of BACKENDS) {
        const candidateRun = await candidate.run(fixture);
        const report = compareBackendResults(
          fixture,
          reference.result,
          candidateRun.result,
          reference.backend,
          candidate.id,
        );
        expect(report.passed, formatParityReport(report)).toBe(true);
        // Every fixture with geometry, whatever its shape, has its outer
        // deviation measured against the shape's analytic SDF.
        const deviation = report.outerDeviation!;
        if (reference.result.triCount > 0) {
          expect(deviation.reference.sampled).toBeGreaterThan(0);
          expect(deviation.candidate.sampled).toBeGreaterThan(0);
          expect(Number.isFinite(deviation.reference.maxDeviation)).toBe(true);
          expect(deviation.reference.maxDeviation).toBeLessThanOrEqual(fixture.params.toleranceMm);
        } else {
          expect(deviation.reference.sampled).toBe(0);
          expect(deviation.candidate.sampled).toBe(0);
        }
      }
    }, 60000);
  }

  it('measures non-sphere fixtures against their own analytic shape', async () => {
    const fixture = { ...PARITY_FIXTURES.find((entry) => entry.shape === 'cube')!, resolution: 32 };
    const { result } = await cpuSingleBackend.run(fixture);
    expect(result.triCount).toBeGreaterThan(0);
    const validation = validateFixtureResult(fixture, result);
    const direct = checkAnalyticOuterDeviation(
      result,
      sampleShapeObjectSdf(fixture.shape, fixture.sphereRadius),
      fixture.params.toleranceMm,
    );
    expect(validation.outerDeviation.sampled).toBeGreaterThan(0);
    expect(validation.outerDeviation.sampled).toBe(direct.sampled);
    expect(validation.outerDeviation.maxDeviation).toBe(direct.maxDeviation);
    expect(validation.warnings).not.toContain('No reference mesh for deviation check');

    // Push the candidate 3 mm through the cube's +x face: the comparison must
    // see a real 3 mm envelope violation, not an unmeasured 0 vs 0.
    const shiftMm = 3;
    const shifted = result.positions.slice();
    for (let i = 0; i < shifted.length; i += 3) shifted[i] += shiftMm;
    const candidate = { ...result, positions: shifted };
    const report = compareBackendResults(fixture, result, candidate, 'cpu-single', 'webgpu-mc');
    const deviation = report.outerDeviation!;
    expect(deviation.candidate.sampled).toBeGreaterThan(0);
    expect(deviation.candidate.maxDeviation).toBeGreaterThan(shiftMm - 0.5);
    expect(deviation.candidate.maxDeviation).toBeLessThanOrEqual(shiftMm + 1e-3);
    expect(deviation.candidate.passed).toBe(false);
    expect(report.checks.find((check) => check.name === 'outer deviation')?.passed).toBe(false);
    // The cube envelope, not the 25 mm fallback sphere, is the reference.
    const halfSize = SAMPLE_SHAPE_DIMENSIONS.cube.halfSize;
    expect(checkAnalyticOuterDeviation(candidate, cubeSdf(halfSize), fixture.params.toleranceMm).maxDeviation)
      .toBe(deviation.candidate.maxDeviation);
  }, 60000);

  it('rejects missing, zero and non-finite mesh data before comparing geometry', async () => {
    const fixture = { ...PARITY_FIXTURES[0], resolution: 16 };
    const { result } = await cpuSingleBackend.run(fixture);
    const nonFinitePositions = result.positions.slice();
    nonFinitePositions[0] = NaN;
    for (const candidate of [
      { ...result, normals: new Float32Array() },
      { ...result, normals: new Float32Array(result.normals.length) },
      { ...result, positions: nonFinitePositions },
      { ...result, triCount: result.triCount + 1 },
    ]) {
      const report = compareBackendResults(fixture, result, candidate, 'cpu-single', 'webgpu-mc');
      expect(report.passed).toBe(false);
      expect(report.checks.some((check) => check.name === 'candidate mesh buffers' && !check.passed)).toBe(true);
    }
  });

  it('records end-to-end phase timings for every backend run', async () => {
    const fixture = PARITY_FIXTURES[0];
    const single = await cpuSingleBackend.run(fixture);
    expect(single.timings.totalMs).toBeGreaterThan(0);
    expect(single.timings.fieldMs).not.toBeNull();
    expect(single.timings.classifyScanEmitMs).not.toBeNull();
    expect(single.timings.readbackMs).toBe(0);
    expect(single.timings.cleanupMs).not.toBeNull();

    const tiled = await createCpuTiledBackend().run(fixture);
    expect(tiled.timings.totalMs).toBeGreaterThan(0);
    // CPU tiles fuse field sampling with extraction, so the fused total and
    // the merge/cleanup phases are what the tiled backend can report.
    expect(tiled.timings.fieldMs).toBeNull();
    expect(tiled.timings.classifyScanEmitMs).toBeGreaterThan(0);
    expect(tiled.timings.mergeMs).not.toBeNull();
    expect(tiled.timings.cleanupMs).not.toBeNull();
  }, 60000);

  it('runs tiled determinism regardless of worker pool size', async () => {
    const fixture = PARITY_FIXTURES[0];
    const runs = await Promise.all([
      createCpuTiledBackend(1).run(fixture),
      createCpuTiledBackend(4).run(fixture),
    ]);
    expect(runs[0].result.triCount).toBe(runs[1].result.triCount);
    expect(runs[0].result.positions).toEqual(runs[1].result.positions);
  }, 60000);
});
