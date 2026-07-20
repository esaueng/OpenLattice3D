// Core data model for the lattice design project

export type ProcessPreset = 'SLS_MJF' | 'SLA_DLP' | 'FDM';

export type LatticeType =
  | 'gyroid'
  | 'schwarzP'
  | 'schwarzD'
  | 'neovius'
  | 'iwp'
  | 'bcc'
  | 'octet'
  | 'diamond'
  | 'hexagon'
  | 'triangle'
  | 'voronoi'
  | 'spinodal';

export type SampleShape = 'sphere' | 'cube' | 'cylinder' | 'torus' | 'capsule';

export type SelectionMode = 'keep_out' | 'keep_in' | 'none';

export type GenerationVariant = 'shell_core' | 'implicit_conformal';

export type EscapeHoleAxis = 'x' | 'y' | 'z';

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
}

export interface MeshInfo {
  triangleCount: number;
  vertexCount: number;
  boundingBox: BoundingBox;
  isWatertight: boolean;
  isManifold: boolean;
  repaired: boolean;
}

export interface LatticeParams {
  latticeType: LatticeType;
  variant: GenerationVariant;
  processPreset: ProcessPreset;
  minFeatureSize: number;      // mm
  cellSize: number;            // mm
  strutDiameter: number;       // mm (for strut lattice)
  wallThickness: number;       // mm (for TPMS)
  shellThickness: number;      // mm (Variant 1)
  noShell: boolean;            // skip outer shell entirely — pure lattice
  surfaceOnly: boolean;        // lattice confined to a band near outer surface, hollow inside
  surfaceDepth: number;        // mm — depth of the lattice band when surfaceOnly is on
  gradientEnabled: boolean;
  gradientStrength: number;    // 0..1
  thinSectionFilter: number;   // mm material removal to suppress ultra-thin/jagged artifacts
  exportResolution: number;    // grid divisions per cell
  escapeHoles: boolean;
  escapeHoleDiameter: number;  // mm
  escapeHoleCount: number;
  escapeHoleAxis: EscapeHoleAxis;
  materialDensityGPerCm3: number; // 0 disables mass estimation
  toleranceMm: number;         // outer deviation tolerance
}

export interface ValidationResult {
  passed: boolean;
  outerDeviation: { passed: boolean; maxDeviation: number; tolerance: number };
  minThickness: { passed: boolean; minMeasured: number; required: number };
  manifold: { passed: boolean; details: string };
  disconnected: { passed: boolean; fragmentCount: number };
  warnings: string[];
}

export interface ProjectData {
  meshAssetName: string;
  meshInfo: MeshInfo | null;
  selectionMask: {
    keepOut: Set<number>;   // triangle indices
    keepIn: Set<number>;
  };
  params: LatticeParams;
  validation: ValidationResult | null;
}

export const DEFAULT_PARAMS: LatticeParams = {
  latticeType: 'gyroid',
  variant: 'shell_core',
  processPreset: 'SLS_MJF',
  minFeatureSize: 0.8,
  cellSize: 8.0,
  strutDiameter: 1.0,
  wallThickness: 1.0,
  shellThickness: 1.5,
  noShell: false,
  surfaceOnly: false,
  surfaceDepth: 8.0,
  gradientEnabled: false,
  gradientStrength: 0.5,
  thinSectionFilter: 0.0,
  exportResolution: 3,
  escapeHoles: true,
  escapeHoleDiameter: 5.0,
  escapeHoleCount: 2,
  escapeHoleAxis: 'z',
  materialDensityGPerCm3: 0,
  toleranceMm: 0.2,
};

export const PROCESS_DEFAULTS: Record<ProcessPreset, Partial<LatticeParams>> = {
  SLS_MJF: { minFeatureSize: 0.8, escapeHoleDiameter: 5.0, escapeHoleCount: 2 },
  SLA_DLP: { minFeatureSize: 0.5, escapeHoleDiameter: 3.5, escapeHoleCount: 2 },
  FDM: { minFeatureSize: 0.8, escapeHoleDiameter: 5.0, escapeHoleCount: 2 },
};

// ── Parameter sanitization (untrusted JSON import) ───────────

const LATTICE_TYPES: readonly LatticeType[] = [
  'gyroid', 'schwarzP', 'schwarzD', 'neovius', 'iwp', 'bcc',
  'octet', 'diamond', 'hexagon', 'triangle', 'voronoi', 'spinodal',
];
const VARIANTS: readonly GenerationVariant[] = ['shell_core', 'implicit_conformal'];
const PROCESS_PRESETS: readonly ProcessPreset[] = ['SLS_MJF', 'SLA_DLP', 'FDM'];
const ESCAPE_HOLE_AXES: readonly EscapeHoleAxis[] = ['x', 'y', 'z'];

type ParamValidator = (value: unknown) => boolean;

function isFiniteNumberIn(min: number, max: number): ParamValidator {
  return (value) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

const isBoolean: ParamValidator = (value) => typeof value === 'boolean';

function isOneOf<T>(allowed: readonly T[]): ParamValidator {
  return (value) => allowed.includes(value as T);
}

// Bounds are deliberately generous: wide enough for expert use, tight enough
// to reject garbage that would stall generation (NaN, negatives, km-scale).
const PARAM_VALIDATORS: Record<keyof LatticeParams, ParamValidator> = {
  latticeType: isOneOf(LATTICE_TYPES),
  variant: isOneOf(VARIANTS),
  processPreset: isOneOf(PROCESS_PRESETS),
  minFeatureSize: isFiniteNumberIn(0.05, 50),
  cellSize: isFiniteNumberIn(0.1, 500),
  strutDiameter: isFiniteNumberIn(0.05, 100),
  wallThickness: isFiniteNumberIn(0.05, 100),
  shellThickness: isFiniteNumberIn(0, 100),
  noShell: isBoolean,
  surfaceOnly: isBoolean,
  surfaceDepth: isFiniteNumberIn(0.1, 500),
  gradientEnabled: isBoolean,
  gradientStrength: isFiniteNumberIn(0, 1),
  thinSectionFilter: isFiniteNumberIn(0, 10),
  exportResolution: isFiniteNumberIn(1, 10),
  escapeHoles: isBoolean,
  escapeHoleDiameter: isFiniteNumberIn(0.1, 100),
  escapeHoleCount: isFiniteNumberIn(0, 100),
  escapeHoleAxis: isOneOf(ESCAPE_HOLE_AXES),
  materialDensityGPerCm3: isFiniteNumberIn(0, 100),
  toleranceMm: isFiniteNumberIn(0.001, 50),
};

export interface SanitizedParams {
  params: Partial<LatticeParams>;
  accepted: (keyof LatticeParams)[];
  rejected: string[];
}

/** Filter an untrusted object down to valid LatticeParams entries.
 *  Unknown keys are ignored; known keys with invalid values are reported. */
export function sanitizeLatticeParams(input: unknown): SanitizedParams {
  const accepted: (keyof LatticeParams)[] = [];
  const rejected: string[] = [];
  const params: Partial<LatticeParams> = {};

  if (typeof input !== 'object' || input === null) {
    return { params, accepted, rejected: ['(not an object)'] };
  }

  const source = input as Record<string, unknown>;
  for (const key of Object.keys(PARAM_VALIDATORS) as (keyof LatticeParams)[]) {
    if (!(key in source)) continue;
    const value = source[key];
    if (PARAM_VALIDATORS[key](value)) {
      (params as Record<string, unknown>)[key] = value;
      accepted.push(key);
    } else {
      rejected.push(key);
    }
  }

  return { params, accepted, rejected };
}
