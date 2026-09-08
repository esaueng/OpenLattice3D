// Warm-run backend benchmark. Excluded from the default suite; run it with
// `npm run bench:backends`, which sets RUN_BACKEND_BENCH=1. The JSON report is
// written to docs/performance/results/ so a promotion decision can cite
// committed numbers from documented hardware.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatBenchmarkReport, runBackendBenchmark } from './benchmark';
import { cpuSingleBackend, createCpuTiledBackend } from './cpu-backends';
import { BENCHMARK_FIXTURES } from './fixtures';

const RUN_BENCH = process.env.RUN_BACKEND_BENCH === '1';

describe.skipIf(!RUN_BENCH)('backend warm-run benchmark', () => {
  it('benchmarks cpu backends and writes a committed-hardware report', async () => {
    const report = await runBackendBenchmark(
      BENCHMARK_FIXTURES,
      [cpuSingleBackend, createCpuTiledBackend(4)],
      undefined,
      (fixture, backend, iteration, totalMs) => {
        console.log(`  ${fixture} ${backend} ${iteration}: ${totalMs.toFixed(0)}ms`);
      },
    );

    for (const fixture of report.fixtures) {
      expect(fixture.backends.length).toBe(2);
      for (const backend of fixture.backends) {
        expect(backend.medianTotalMs).toBeGreaterThan(0);
        expect(backend.p95TotalMs).toBeGreaterThanOrEqual(backend.medianTotalMs);
      }
    }
    expect(report.promotion.gpuBackendPresent).toBe(false);
    expect(report.promotion.meetsSpeedupThreshold).toBeNull();

    console.log(`\n${formatBenchmarkReport(report)}\n`);

    const resultsDir = fileURLToPath(new URL('../../docs/performance/results/', import.meta.url));
    mkdirSync(resultsDir, { recursive: true });
    const file = `${resultsDir}backend-benchmark-${report.hardware.platform}-${report.hardware.arch}.json`;
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report written to ${file}`);
  }, 600000);
});
