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

export type SelectionMode = 'keep_out' | 'keep_in' | 'erase' | 'place_hole' | 'none';

export type EscapeHolePlacement = 'auto' | 'manual';

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
  /** Edges owned by exactly one triangle (holes in the surface). */
  boundaryEdges: number;
  /** Edges shared by three or more triangles. */
  nonManifoldEdges: number;
  /** Enclosed volume in mm³, or null when the mesh is not closed. */
  volumeMm3: number | null;
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
  keepInDepth: number;         // mm of solid material below painted keep-in faces
  /**
   * Minimum feature width to keep, mm. Features thinner than this are removed
   * by a morphological opening; 0 disables it.
   */
  thinSectionFilter: number;
  exportResolution: number;    // grid divisions per cell
  escapeHoles: boolean;
  escapeHoleDiameter: number;  // mm
  escapeHoleCount: number;
  escapeHoleAxis: EscapeHoleAxis;
  /** 'auto' spreads escapeHoleCount holes over the part; 'manual' uses clicked points. */
  escapeHolePlacement: EscapeHolePlacement;
  /** World-space xyz triples of clicked hole positions; the cylinder runs along the axis through each. */
  escapeHoleManualCenters: number[];
  materialDensityGPerCm3: number; // 0 disables mass estimation
  toleranceMm: number;         // outer deviation tolerance
}

/**
 * Stable identifiers for validation warnings. The UI classifies warnings by
 * code; the message text is for people and may be reworded freely.
 */
export const VALIDATION_WARNING_CODES = [
  /** Outer deviation was attempted but no sample could be measured. */
  'deviation-unmeasured',
  /** Neither a reference mesh nor an analytic shape to measure deviation against. */
  'no-deviation-reference',
  /** No usable wall-thickness ray. */
  'thickness-unmeasured',
  /** More than one solid body (restates a failed connectivity check). */
  'multiple-bodies',
  /** Enclosed voids without escape holes: trapped powder or resin. */
  'trapped-voids',
  /** Zero-volume closed surfaces; negligible but exported. */
  'zero-volume-slivers',
  /** FDM process with an open lattice exterior. */
  'fdm-open-lattice',
  /** The thin-section filter was skipped because the grid is too coarse. */
  'thin-filter-skipped',
] as const;

export type ValidationWarningCode = typeof VALIDATION_WARNING_CODES[number];

export interface ValidationWarning {
  code: ValidationWarningCode;
  message: string;
}

export function isValidationWarningCode(value: unknown): value is ValidationWarningCode {
  return typeof value === 'string' && (VALIDATION_WARNING_CODES as readonly string[]).includes(value);
}

export interface ValidationResult {
  passed: boolean;
  outerDeviation: {
    passed: boolean;
    maxDeviation: number;
    tolerance: number;
    /** Surface samples measured; 0 means deviation could not be measured. Absent on older results. */
    sampled?: number;
  };
  minThickness: {
    passed: boolean;
    minMeasured: number;
    required: number;
    absoluteMin: number;
    sampled: number;
    /** xyz triples of sample origins whose measured thickness was below the target. */
    thinPoints?: number[];
  };
  manifold: { passed: boolean; details: string };
  disconnected: {
    passed: boolean;
    /** Separate solid bodies (closed surfaces enclosing positive volume). */
    fragmentCount: number;
    /** Enclosed void networks (closed surfaces enclosing negative volume). */
    voidCount?: number;
    /** Closed surfaces enclosing no measurable volume. */
    sliverCount?: number;
  };
  /** Human-readable warnings; always present, including on older and imported results. */
  warnings: string[];
  /**
   * The same warnings with stable codes, in the same order as `warnings`.
   * Absent on results produced before codes existed; consumers then fall back
   * to classifying the message text.
   */
  warningDetails?: ValidationWarning[];
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
  keepInDepth: 3.0,
  thinSectionFilter: 0.0,
  exportResolution: 4,
  escapeHoles: false,
  escapeHoleDiameter: 5.0,
  escapeHoleCount: 2,
  escapeHoleAxis: 'z',
  escapeHolePlacement: 'auto',
  escapeHoleManualCenters: [],
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
const ESCAPE_HOLE_PLACEMENTS: readonly EscapeHolePlacement[] = ['auto', 'manual'];
const MAX_MANUAL_HOLES = 100;

const isManualCenterList: ParamValidator = (value) =>
  Array.isArray(value)
  && value.length % 3 === 0
  && value.length <= MAX_MANUAL_HOLES * 3
  && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && Math.abs(entry) <= 1_000_000);

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
  keepInDepth: isFiniteNumberIn(0.01, 100),
  thinSectionFilter: isFiniteNumberIn(0, 10),
  exportResolution: isFiniteNumberIn(1, 10),
  escapeHoles: isBoolean,
  escapeHoleDiameter: isFiniteNumberIn(0.1, 100),
  escapeHoleCount: isFiniteNumberIn(0, 100),
  escapeHoleAxis: isOneOf(ESCAPE_HOLE_AXES),
  escapeHolePlacement: isOneOf(ESCAPE_HOLE_PLACEMENTS),
  escapeHoleManualCenters: isManualCenterList,
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
