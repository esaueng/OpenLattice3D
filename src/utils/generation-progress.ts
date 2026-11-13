// Plain-language progress for a generation run. The worker's progress messages
// are diagnostics ("cpu-tiled: 211/216 tiles processed…") and stay in the run
// log; the panel, status bar and viewer show the phase they belong to.
// Driven only by the existing progress fields, so the worker contract is unchanged.

export type GenerationPhase =
  | 'starting'
  | 'preparing'
  | 'sampling'
  | 'surface'
  | 'thin-filter'
  | 'cleanup'
  | 'finishing'
  | 'checking'
  | 'done'
  | 'stopped';

type RunningPhase = Exclude<GenerationPhase, 'stopped'>;

export interface GenerationProgressView {
  phase: GenerationPhase;
  /** Short phase name, e.g. "Building surface". */
  label: string;
  /** 0–100, rounded. */
  percent: number;
  /** One line for the UI, e.g. "Building surface · 64%". */
  text: string;
}

const PHASE_LABELS: Record<RunningPhase, string> = {
  starting: 'Starting',
  preparing: 'Preparing model',
  sampling: 'Sampling field',
  surface: 'Building surface',
  'thin-filter': 'Removing thin features',
  cleanup: 'Cleaning up mesh',
  finishing: 'Preparing preview',
  checking: 'Checking printability',
  done: 'Done',
};

// The single-threaded path reports surface extraction up to this fraction,
// then repairs seams before "Geometry ready" at 0.95.
const SINGLE_PATH_SURFACE_END = 0.84;
const TILED_PATH_SURFACE_END = 0.88;
const PREPARE_END = 0.12;

function clampPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

function phaseFor(progress: number, message: string): GenerationPhase | null {
  const text = message.trim();
  if (/^cancel/i.test(text) || /^generation failed/i.test(text) || /^model changed/i.test(text)) return 'stopped';
  if (/^complete$/i.test(text)) return 'done';
  if (/^starting/i.test(text)) return 'starting';
  // The single-threaded path announces its estimate just before sampling starts.
  if (/^sampling field/i.test(text) || /^estimated generation time/i.test(text)) return 'sampling';
  const marching = /^marching cubes:\s*(\d+)%/i.exec(text);
  if (marching) return Number(marching[1]) >= 100 || progress >= SINGLE_PATH_SURFACE_END ? 'cleanup' : 'surface';
  const tiles = /(\d+)\s*\/\s*(\d+)\s+tiles processed/i.exec(text);
  if (tiles) return Number(tiles[1]) >= Number(tiles[2]) || progress >= TILED_PATH_SURFACE_END ? 'cleanup' : 'surface';
  if (/^removing features/i.test(text)) return 'thin-filter';
  if (/^cannot remove features/i.test(text)) return 'surface';
  if (/^geometry ready/i.test(text)) return 'finishing';
  return null;
}

function phaseFromProgress(progress: number): RunningPhase {
  if (progress <= 0) return 'starting';
  if (progress < PREPARE_END) return 'preparing';
  if (progress < 0.95) return 'surface';
  if (progress < 1) return 'finishing';
  return 'done';
}

/**
 * Map the store's generation progress (and validation progress, once the mesh
 * has landed) to a plain phase with a percent.
 */
export function describeGenerationProgress(
  progress: number,
  message: string | null | undefined,
  validationProgress: number | null = null,
): GenerationProgressView {
  if (validationProgress !== null) {
    const percent = clampPercent(validationProgress);
    return { phase: 'checking', label: PHASE_LABELS.checking, percent, text: `${PHASE_LABELS.checking} · ${percent}%` };
  }
  const raw = message ?? '';
  const percent = clampPercent(progress);
  const matched = phaseFor(progress, raw);
  if (matched === 'stopped') {
    // Cancel and failure messages are already written for people.
    return { phase: 'stopped', label: raw.trim(), percent, text: raw.trim() };
  }
  // Anything unrecognised before the field is sampled is set-up work (BVH, SDF, backend choice).
  const phase: RunningPhase = matched ?? (progress < PREPARE_END && progress > 0 ? 'preparing' : phaseFromProgress(progress));
  const label = PHASE_LABELS[phase];
  const text = phase === 'starting' ? `${label}…` : phase === 'done' ? label : `${label} · ${percent}%`;
  return { phase, label, percent, text };
}
