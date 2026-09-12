// The inputs that decide what a generation run produces, frozen at run start so
// the UI can tell whether the result on screen still matches the form.
import type { LatticeParams, SampleShape } from '../types/project';
import type { TriangleMesh } from '../geometry/stl-parser';

export interface GenerationInputs {
  params: LatticeParams;
  generationSeed: number;
  originalMesh: TriangleMesh | null;
  meshFileName: string;
  sampleShape: SampleShape | null;
  sphereMode: boolean;
  sphereRadius: number;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
}

export interface GenerationSnapshot {
  /** Stable string over every input that feeds generation. */
  signature: string;
  params: LatticeParams;
  generationSeed: number;
  sourceKey: string;
  keepOutCount: number;
  keepInCount: number;
}

const PARAM_LABELS: Record<keyof LatticeParams, string> = {
  latticeType: 'lattice type',
  variant: 'generation variant',
  processPreset: 'process preset',
  minFeatureSize: 'min feature size',
  cellSize: 'cell size',
  strutDiameter: 'strut diameter',
  wallThickness: 'wall thickness',
  shellThickness: 'shell thickness',
  noShell: 'shell mode',
  surfaceOnly: 'surface-only mode',
  surfaceDepth: 'lattice depth',
  gradientEnabled: 'gradient',
  gradientStrength: 'gradient strength',
  keepInDepth: 'keep-solid depth',
  thinSectionFilter: 'remove features',
  exportResolution: 'resolution',
  escapeHoles: 'escape holes',
  escapeHoleDiameter: 'hole diameter',
  escapeHoleCount: 'hole count',
  escapeHoleAxis: 'hole axis',
  materialDensityGPerCm3: 'material density',
  toleranceMm: 'tolerance',
};

/** Parameters that change the reported statistics but not the geometry. */
const NON_GEOMETRY_PARAMS: ReadonlySet<keyof LatticeParams> = new Set(['materialDensityGPerCm3']);

function sortedMask(mask: Set<number>): number[] {
  return Array.from(mask).sort((a, b) => a - b);
}

export function sourceKeyFor(inputs: Pick<GenerationInputs, 'originalMesh' | 'meshFileName' | 'sampleShape' | 'sphereMode' | 'sphereRadius'>): string {
  if (inputs.originalMesh) {
    return `mesh:${inputs.meshFileName}:${inputs.originalMesh.triCount}:${inputs.originalMesh.positions.length}`;
  }
  return `shape:${inputs.sampleShape ?? 'none'}:${inputs.sphereMode ? 1 : 0}:${inputs.sphereRadius}`;
}

export function buildGenerationSnapshot(inputs: GenerationInputs): GenerationSnapshot {
  const geometryParams: Partial<LatticeParams> = { ...inputs.params };
  for (const key of NON_GEOMETRY_PARAMS) delete geometryParams[key];
  const sourceKey = sourceKeyFor(inputs);
  const signature = JSON.stringify({
    params: geometryParams,
    generationSeed: inputs.generationSeed,
    source: sourceKey,
    keepOut: sortedMask(inputs.keepOutTris),
    keepIn: sortedMask(inputs.keepInTris),
  });
  return {
    signature,
    params: { ...inputs.params },
    generationSeed: inputs.generationSeed,
    sourceKey,
    keepOutCount: inputs.keepOutTris.size,
    keepInCount: inputs.keepInTris.size,
  };
}

/** True when the inputs on screen no longer match the snapshot a result came from. */
export function isSnapshotStale(snapshot: GenerationSnapshot | null, inputs: GenerationInputs): boolean {
  if (!snapshot) return false;
  return buildGenerationSnapshot(inputs).signature !== snapshot.signature;
}

/**
 * Human-readable list of what changed since the snapshot, for the "out of date"
 * notice. Order: model, then parameters in form order, then seed, then masks.
 */
export function describeSnapshotChanges(snapshot: GenerationSnapshot, inputs: GenerationInputs): string[] {
  const changes: string[] = [];
  const current = buildGenerationSnapshot(inputs);
  if (current.sourceKey !== snapshot.sourceKey) changes.push('model');
  for (const key of Object.keys(PARAM_LABELS) as (keyof LatticeParams)[]) {
    if (NON_GEOMETRY_PARAMS.has(key)) continue;
    if (current.params[key] !== snapshot.params[key]) changes.push(PARAM_LABELS[key]);
  }
  if (current.generationSeed !== snapshot.generationSeed) changes.push('seed');
  if (current.keepOutCount !== snapshot.keepOutCount || current.keepInCount !== snapshot.keepInCount) {
    changes.push('painted faces');
  } else if (changes.length === 0 && current.signature !== snapshot.signature) {
    // Same counts, different triangles.
    changes.push('painted faces');
  }
  return changes;
}
