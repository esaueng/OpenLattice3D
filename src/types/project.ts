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
  keepInDepth: number;         // mm — depth of solid material under painted keep-in faces
  gradientEnabled: boolean;
  gradientStrength: number;    // 0..1
  thinSectionFilter: number;   // mm material removal to suppress ultra-thin/jagged artifacts
  exportResolution: number;    // grid divisions per cell
  escapeHoles: boolean;
  escapeHoleDiameter: number;  // mm
  escapeHoleCount: number;
  toleranceMm: number;         // outer deviation tolerance
}

export interface ValidationResult {
  passed: boolean;
  outerDeviation: { passed: boolean; maxDeviation: number; tolerance: number };
  minThickness: {
    passed: boolean;
    /** 1st-percentile local thickness, mm. Drives pass/fail. */
    minMeasured: number;
    required: number;
    /** Thinnest single sample, mm. Sensitive to cusps, shown for inspection. */
    absoluteMin?: number;
    /** Rays that found a measurable wall. */
    sampled?: number;
  };
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
  keepInDepth: 3.0,
  gradientEnabled: false,
  gradientStrength: 0.5,
  thinSectionFilter: 0.0,
  exportResolution: 3,
  escapeHoles: true,
  escapeHoleDiameter: 5.0,
  escapeHoleCount: 2,
  toleranceMm: 0.2,
};

/** Bulk densities in g/cm3, for turning lattice volume into a printed mass. */
export interface MaterialPreset {
  name: string;
  density: number;
  process: ProcessPreset;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  { name: 'PA12 (Nylon)',        density: 1.01, process: 'SLS_MJF' },
  { name: 'PA11 (Nylon)',        density: 1.03, process: 'SLS_MJF' },
  { name: 'PA12 Glass-Filled',   density: 1.35, process: 'SLS_MJF' },
  { name: 'TPU',                 density: 1.20, process: 'SLS_MJF' },
  { name: 'AlSi10Mg (Aluminum)', density: 2.67, process: 'SLS_MJF' },
  { name: 'Ti6Al4V (Titanium)',  density: 4.43, process: 'SLS_MJF' },
  { name: '316L Stainless',      density: 7.99, process: 'SLS_MJF' },
  { name: 'Standard Resin',      density: 1.15, process: 'SLA_DLP' },
  { name: 'Tough Resin',         density: 1.18, process: 'SLA_DLP' },
  { name: 'PLA',                 density: 1.24, process: 'FDM' },
  { name: 'ABS',                 density: 1.04, process: 'FDM' },
  { name: 'PETG',                density: 1.27, process: 'FDM' },
];

export const DEFAULT_MATERIAL = MATERIAL_PRESETS[0];

export const PROCESS_DEFAULTS: Record<ProcessPreset, Partial<LatticeParams>> = {
  SLS_MJF: { minFeatureSize: 0.8, escapeHoleDiameter: 5.0, escapeHoleCount: 2 },
  SLA_DLP: { minFeatureSize: 0.5, escapeHoleDiameter: 3.5, escapeHoleCount: 2 },
  FDM: { minFeatureSize: 0.8, escapeHoleDiameter: 5.0, escapeHoleCount: 2 },
};
