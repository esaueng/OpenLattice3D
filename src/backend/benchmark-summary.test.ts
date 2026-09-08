import { describe, expect, it } from 'vitest';
import { runBackendBenchmark, summarizeRuns } from './benchmark';
import { PARITY_FIXTURES } from './fixtures';
import type { BackendRunResult, MarchingCubesBackend } from './types';

function run(backend: BackendRunResult['backend'], totalMs: number): BackendRunResult {
  return {
    backend,
    result: { positions: new Float32Array(), normals: new Float32Array(), triCount: 0 },
    timings: { fieldMs: 0, classifyScanEmitMs: null, classifyMs: 1, scanMs: 1,
      emitMs: 1, readbackMs: 1, mergeMs: 0, cleanupMs: 0, totalMs },
  };
}

describe('benchmark evidence', () => {
  it.each([0, -1, NaN, Infinity])('rejects invalid total timing %s', (totalMs) => {
    expect(() => summarizeRuns(PARITY_FIXTURES[0], [run('webgpu-mc', totalMs)]))
      .toThrow(/Invalid totalMs/);
  });

  it('records separate phases and uses a median rather than an outlier-sensitive mean', async () => {
    const cpu: MarchingCubesBackend = { id: 'cpu-tiled', run: async () => run('cpu-tiled', 100) };
    const gpu: MarchingCubesBackend = {
      id: 'webgpu-mc',
      run: async (fixture) => run('webgpu-mc', [100, 50, 1][Number(fixture.name)]),
    };
    const fixtures = [0, 1, 2].map((index) => ({ ...PARITY_FIXTURES[0], name: String(index) }));
    const report = await runBackendBenchmark(fixtures, [cpu, gpu], { iterations: 5, warmupIterations: 1 });
    expect(report.promotion.gpuMedianSpeedupVsCpuTiled).toBe(2);
    expect(report.fixtures[0].backends.find((backend) => backend.backend === 'webgpu-mc')?.phases)
      .toMatchObject({ classifyMs: 1, scanMs: 1, emitMs: 1 });
  });

  it.each([0, -1, 1.5, NaN])('rejects invalid recorded iteration count %s', async (iterations) => {
    const cpu: MarchingCubesBackend = { id: 'cpu-tiled', run: async () => run('cpu-tiled', 100) };
    await expect(runBackendBenchmark([PARITY_FIXTURES[0]], [cpu], { iterations, warmupIterations: 1 }))
      .rejects.toThrow(/iterations/);
  });
});
