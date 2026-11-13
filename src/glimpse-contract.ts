// Mirror of Glimpse's wire vocabulary for OpenLattice3D (glimpse src/contract.ts
// `LATTICE_OPTIONAL` and src/expanded.ts `LATTICE_EXPANDED`, ADR 0001 Option B).
// Fixed strings only: no free-form dimensions, messages or identifiers.
// Shared by the browser adapter and the Worker relay, so both reject the same values.

/** The original (consent v1) events. `operation_latency` uses TIMINGS; the rest use `none`. */
export const USAGE_EVENTS = [
  'workspace_opened',
  'export_completed',
  'export_failed',
  'generation_completed',
  'generation_failed',
  'operation_latency',
] as const;
export type UsageEvent = typeof USAGE_EVENTS[number];

export const TIMINGS = ['lt_100ms', '100ms_1s', '1s_10s', '10s_60s', 'gte_60s'] as const;
export const SIZES = ['lt_1mib', '1_10mib', '10_100mib', 'gte_100mib'] as const;
/** Unit cells per generated lattice. The open top range keeps rare very large lattices together. */
export const CELLS = ['lt_1k', '1k_10k', '10k_100k', 'gte_100k'] as const;
export const LATTICE_DIAGNOSTICS = [
  'error_runtime',
  'error_import',
  'error_export',
  'error_storage',
  'error_render',
  'error_unresponsive',
  'error_gpu_lost',
  'error_out_of_memory',
  'error_worker',
] as const;
export type Diagnostic = typeof LATTICE_DIAGNOSTICS[number];
export const LATTICE_CATEGORIES = ['create', 'import', 'export', 'measure', 'other'] as const;
export type FeatureCategory = typeof LATTICE_CATEGORIES[number];

/** The targeted subset (consent v2 only). Each event maps to its complete bucket list. */
export const LATTICE_EXPANDED: Readonly<Record<string, readonly string[]>> = {
  export_latency: TIMINGS,
  project_size: SIZES,
  feature_category: LATTICE_CATEGORIES,
  lattice_cells: CELLS,
  ...Object.fromEntries(LATTICE_DIAGNOSTICS.map((event) => [event, ['none']])),
};

export function isUsageMetric(event: unknown, bucket: unknown): boolean {
  if (typeof event !== 'string' || typeof bucket !== 'string') return false;
  if (!(USAGE_EVENTS as readonly string[]).includes(event)) return false;
  return event === 'operation_latency' ? (TIMINGS as readonly string[]).includes(bucket) : bucket === 'none';
}

export function isExpandedMetric(event: unknown, bucket: unknown): boolean {
  if (typeof event !== 'string' || typeof bucket !== 'string') return false;
  return Object.hasOwn(LATTICE_EXPANDED, event) && (LATTICE_EXPANDED[event]?.includes(bucket) ?? false);
}

export function durationBucket(ms: number): typeof TIMINGS[number] | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms < 100 ? 'lt_100ms' : ms < 1000 ? '100ms_1s' : ms < 10000 ? '1s_10s' : ms < 60000 ? '10s_60s' : 'gte_60s';
}

/** Byte size to the four size ranges (binary MiB, as in Glimpse). */
export function sizeBucket(bytes: number): typeof SIZES[number] | null {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  return bytes < 1_048_576 ? 'lt_1mib' : bytes < 10_485_760 ? '1_10mib' : bytes < 104_857_600 ? '10_100mib' : 'gte_100mib';
}

/** Unit-cell count to the four decade ranges. Only the range ever leaves the page. */
export function cellBucket(cells: number): typeof CELLS[number] | null {
  if (!Number.isFinite(cells) || cells < 0) return null;
  return cells < 1_000 ? 'lt_1k' : cells < 10_000 ? '1k_10k' : cells < 100_000 ? '10k_100k' : 'gte_100k';
}
