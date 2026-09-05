// Warm-run benchmark across marching-cubes backends. Records per-phase and
// end-to-end timings, summarizes median and p95, and evaluates the GPU
// promotion speedup threshold when a webgpu-mc backend is present.
// docs/performance/parity-gates.md
import { cpus, platform, arch } from 'node:os';
import { GPU_BACKEND_ID, GPU_PROMOTION_MIN_SPEEDUP } from './gate';
import type {
  BackendFixture,
  BackendPhaseTimings,
  BackendRunResult,
  GenerationBackendId,
  MarchingCubesBackend,
} from './types';

export interface BackendBenchmarkOptions {
  /** Discarded runs that warm JIT and allocator paths. */
  warmupIterations: number;
  /** Recorded warm runs per fixture and backend. */
  iterations: number;
}

export const DEFAULT_BENCHMARK_OPTIONS: BackendBenchmarkOptions = {
  warmupIterations: 1,
  iterations: 5,
};

export interface PhaseSummary {
  fieldMs: number | null;
  classifyScanEmitMs: number | null;
  readbackMs: number | null;
  mergeMs: number | null;
  cleanupMs: number | null;
}

export interface BackendBenchmarkSummary {
  backend: GenerationBackendId;
  iterations: number;
  medianTotalMs: number;
  p95TotalMs: number;
  phases: PhaseSummary;
  /** cpu-tiled median divided by this backend's median; null when unavailable. */
  speedupVsCpuTiled: number | null;
}

export interface FixtureBenchmarkSummary {
  fixture: string;
  resolution: number;
  backends: BackendBenchmarkSummary[];
}

export interface BackendBenchmarkReport {
  hardware: {
    platform: string;
    arch: string;
    cpuModel: string;
    cores: number;
    node: string;
  };
  startedAt: string;
  options: BackendBenchmarkOptions;
  fixtures: FixtureBenchmarkSummary[];
  promotion: {
    minSpeedup: number;
    gpuBackendPresent: boolean;
    /** Mean warm-run speedup of webgpu-mc vs cpu-tiled across fixtures. */
    gpuMedianSpeedupVsCpuTiled: number | null;
    /** Whether the measured speedup meets the threshold; null without a GPU backend. */
    meetsSpeedupThreshold: boolean | null;
  };
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile95(sorted: number[]): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function medianNullable(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  return present.length === 0 ? null : median(present);
}

export function summarizeRuns(
  fixture: BackendFixture,
  runs: BackendRunResult[],
): FixtureBenchmarkSummary {
  const byBackend = new Map<GenerationBackendId, BackendRunResult[]>();
  for (const run of runs) {
    const list = byBackend.get(run.backend) ?? [];
    list.push(run);
    byBackend.set(run.backend, list);
  }

  const totals = new Map<GenerationBackendId, number[]>();
  for (const [backend, backendRuns] of byBackend) {
    totals.set(backend, backendRuns.map((run) => run.timings.totalMs).sort((a, b) => a - b));
  }
  const cpuTiledMedian = totals.has('cpu-tiled') ? median(totals.get('cpu-tiled')!) : null;

  const backends: BackendBenchmarkSummary[] = [];
  for (const [backend, backendRuns] of byBackend) {
    const sortedTotals = totals.get(backend)!;
    const medianTotalMs = median(sortedTotals);
    const phases = (key: keyof BackendPhaseTimings) =>
      medianNullable(backendRuns.map((run) => run.timings[key]));
    backends.push({
      backend,
      iterations: backendRuns.length,
      medianTotalMs,
      p95TotalMs: percentile95(sortedTotals),
      phases: {
        fieldMs: phases('fieldMs'),
        classifyScanEmitMs: phases('classifyScanEmitMs'),
        readbackMs: phases('readbackMs'),
        mergeMs: phases('mergeMs'),
        cleanupMs: phases('cleanupMs'),
      },
      speedupVsCpuTiled: cpuTiledMedian === null || backend === 'cpu-tiled'
        ? null
        : cpuTiledMedian / medianTotalMs,
    });
  }
  backends.sort((a, b) => a.backend.localeCompare(b.backend));
  return { fixture: fixture.name, resolution: fixture.resolution, backends };
}

export async function runBackendBenchmark(
  fixtures: readonly BackendFixture[],
  backends: readonly MarchingCubesBackend[],
  options: BackendBenchmarkOptions = DEFAULT_BENCHMARK_OPTIONS,
  onRun?: (fixture: string, backend: GenerationBackendId, iteration: string, totalMs: number) => void,
): Promise<BackendBenchmarkReport> {
  const fixturesSummaries: FixtureBenchmarkSummary[] = [];
  let gpuPresent = false;
  const gpuSpeedups: number[] = [];

  for (const fixture of fixtures) {
    const runs: BackendRunResult[] = [];
    for (const backend of backends) {
      for (let iteration = -options.warmupIterations; iteration < options.iterations; iteration++) {
        const run = await backend.run(fixture);
        if (iteration >= 0) {
          runs.push(run);
          onRun?.(fixture.name, backend.id, `${iteration + 1}/${options.iterations}`, run.timings.totalMs);
        } else {
          onRun?.(fixture.name, backend.id, 'warmup', run.timings.totalMs);
        }
      }
    }
    const summary = summarizeRuns(fixture, runs);
    fixturesSummaries.push(summary);
    const gpu = summary.backends.find((entry) => entry.backend === GPU_BACKEND_ID);
    if (gpu) {
      gpuPresent = true;
      if (gpu.speedupVsCpuTiled !== null) gpuSpeedups.push(gpu.speedupVsCpuTiled);
    }
  }

  const gpuMedianSpeedup = gpuSpeedups.length > 0
    ? gpuSpeedups.reduce((sum, value) => sum + value, 0) / gpuSpeedups.length
    : null;

  const cpu = cpus()[0];
  return {
    hardware: {
      platform: platform(),
      arch: arch(),
      cpuModel: cpu?.model ?? 'unknown',
      cores: cpus().length,
      node: process.version,
    },
    startedAt: new Date().toISOString(),
    options,
    fixtures: fixturesSummaries,
    promotion: {
      minSpeedup: GPU_PROMOTION_MIN_SPEEDUP,
      gpuBackendPresent: gpuPresent,
      gpuMedianSpeedupVsCpuTiled: gpuMedianSpeedup,
      meetsSpeedupThreshold: gpuMedianSpeedup === null
        ? null
        : gpuMedianSpeedup >= GPU_PROMOTION_MIN_SPEEDUP,
    },
  };
}

export function formatBenchmarkReport(report: BackendBenchmarkReport): string {
  const lines = [
    `Hardware: ${report.hardware.cpuModel} (${report.hardware.platform}/${report.hardware.arch}, ${report.hardware.cores} cores, ${report.hardware.node})`,
    `Warm runs: ${report.options.warmupIterations} warmup + ${report.options.iterations} recorded`,
  ];
  for (const fixture of report.fixtures) {
    lines.push(`\n${fixture.fixture} (resolution ${fixture.resolution}):`);
    for (const backend of fixture.backends) {
      const speedup = backend.speedupVsCpuTiled === null
        ? ''
        : `, ${backend.speedupVsCpuTiled.toFixed(2)}x vs cpu-tiled`;
      const phases = [
        ['field', backend.phases.fieldMs],
        ['classify+scan+emit', backend.phases.classifyScanEmitMs],
        ['readback', backend.phases.readbackMs],
        ['merge', backend.phases.mergeMs],
        ['cleanup', backend.phases.cleanupMs],
      ]
        .filter((entry): entry is [string, number] => entry[1] !== null)
        .map(([name, value]) => `${name} ${value.toFixed(0)}ms`)
        .join(', ');
      lines.push(
        `  ${backend.backend}: median ${backend.medianTotalMs.toFixed(0)}ms, p95 ${backend.p95TotalMs.toFixed(0)}ms${speedup}\n    ${phases}`,
      );
    }
  }
  const { promotion } = report;
  if (promotion.gpuBackendPresent) {
    const speedup = promotion.gpuMedianSpeedupVsCpuTiled?.toFixed(2) ?? 'n/a';
    const verdict = promotion.meetsSpeedupThreshold ? 'meets' : 'is below';
    lines.push(
      `\nGPU speed gate: ${speedup}x vs cpu-tiled median (${verdict} the ${promotion.minSpeedup}x minimum).`,
      'Parity and fallback gates are proven separately by npm test before promotion.',
    );
  } else {
    lines.push('\nGPU promotion: no webgpu-mc backend present; selection stays disabled.');
  }
  return lines.join('\n');
}
