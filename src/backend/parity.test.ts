// The executable parity gate: every fixture must agree between backends
// within the documented tolerances. Today this pins cpu-tiled against the
// cpu-single reference; when a webgpu-mc backend lands it joins BACKENDS and
// must pass the same gate before promotion. docs/performance/parity-gates.md
import { describe, expect, it } from 'vitest';
import { cpuSingleBackend, createCpuTiledBackend } from './cpu-backends';
import { PARITY_FIXTURES } from './fixtures';
import { compareBackendResults, formatParityReport } from './parity';
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
      }
    }, 60000);
  }

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
