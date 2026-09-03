// Global app state using Zustand with preference-only persistence
import { create } from 'zustand';
import type { LatticeParams, MeshInfo, ValidationResult, ProcessPreset, LatticeType, GenerationVariant, SelectionMode, SampleShape } from '../types/project';
import { DEFAULT_PARAMS, PROCESS_DEFAULTS, sanitizeLatticeParams } from '../types/project';
import type { TriangleMesh } from '../geometry/stl-parser';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import { DEFAULT_VIEWER_BACKGROUND, normalizeViewerBackground } from '../utils/viewer-color';
import {
  createReseedValue,
  DEFAULT_GENERATION_SEED,
  normalizeGenerationSeed,
} from '../geometry/deterministic-random';

export type ViewMode = 'original' | 'lattice' | 'cross_section' | 'xray';

export type ClipAxis = 'x' | 'y' | 'z';

export interface ClipPlaneState {
  axis: ClipAxis;
  position: number;   // 0..1 normalized across bounding box
  flipped: boolean;
}

export interface LogEntry {
  time: number;
  message: string;
  level: 'info' | 'warn' | 'error';
}

export type ViewerVector3 = [number, number, number];

export interface ViewerCameraState {
  position: ViewerVector3;
  target: ViewerVector3;
  up: ViewerVector3;
  zoom: number;
  savedAt: number;
}

// ── Persistence helpers ──────────────────────────────────
const STORAGE_KEY = 'gen-lattice-1-state';
const DB_NAME = 'openlattice3d-state';
const DB_VERSION = 1;
const DB_STORE = 'snapshots';
const DB_STATE_KEY = 'app-state-v1';

interface PersistedState {
  params: LatticeParams;
  generationSeed: number;
  sampleShape: SampleShape | null;
  sphereMode: boolean;
  sphereRadius: number;
  viewMode: ViewMode;
  clipPlane: ClipPlaneState;
  viewerBackground: string;
  brushRadius: number;
}

type DemoParamsByType = Partial<Record<LatticeType, LatticeParams>>;

type SelectionSnapshot = {
  keepOut: number[];
  keepIn: number[];
};

const MAX_SELECTION_HISTORY = 100;

export interface ProjectRestoreState {
  params: LatticeParams;
  generationSeed: number;
  originalMesh: TriangleMesh | null;
  meshInfo: MeshInfo | null;
  meshFileName: string;
  sampleShape: SampleShape | null;
  sphereRadius: number;
  keepOutTris: number[];
  keepInTris: number[];
  clipPlane?: ClipPlaneState;
  viewerBackground?: string;
}

function currentSelection(state: Pick<AppState, 'keepOutTris' | 'keepInTris'>): SelectionSnapshot {
  return {
    keepOut: Array.from(state.keepOutTris),
    keepIn: Array.from(state.keepInTris),
  };
}

function pushSelectionHistory(state: AppState): Pick<AppState, 'selectionUndo' | 'selectionRedo'> {
  return {
    selectionUndo: [...state.selectionUndo.slice(-(MAX_SELECTION_HISTORY - 1)), currentSelection(state)],
    selectionRedo: [],
  };
}

function selectionsMatch(a: SelectionSnapshot, b: SelectionSnapshot): boolean {
  if (a.keepOut.length !== b.keepOut.length || a.keepIn.length !== b.keepIn.length) return false;
  const keepOut = new Set(a.keepOut);
  const keepIn = new Set(a.keepIn);
  return b.keepOut.every((triangle) => keepOut.has(triangle))
    && b.keepIn.every((triangle) => keepIn.has(triangle));
}

interface PersistedAppState extends PersistedState {
  version: number;
  savedAt: number;
  viewerCameraState: ViewerCameraState | null;
}

const SAMPLE_SHAPES: readonly SampleShape[] = ['sphere', 'cube', 'cylinder', 'torus', 'capsule'];
const VIEW_MODES: readonly ViewMode[] = ['original', 'lattice', 'cross_section', 'xray'];

function finiteVector3(value: unknown): ViewerVector3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null;
  return [value[0], value[1], value[2]];
}

function normalizeViewerCameraState(value: unknown): ViewerCameraState | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ViewerCameraState>;
  const position = finiteVector3(candidate.position);
  const target = finiteVector3(candidate.target);
  const up = finiteVector3(candidate.up);
  if (!position || !target || !up) return null;
  if (typeof candidate.zoom !== 'number' || !Number.isFinite(candidate.zoom) || candidate.zoom <= 0) return null;
  if (typeof candidate.savedAt !== 'number' || !Number.isFinite(candidate.savedAt)) return null;
  return { position, target, up, zoom: candidate.zoom, savedAt: candidate.savedAt };
}

function normalizePersistedState(value: unknown): PersistedState {
  const candidate = typeof value === 'object' && value !== null
    ? value as Partial<PersistedState>
    : {};
  const sanitizedParams = sanitizeLatticeParams(candidate.params).params;
  const sampleShape = SAMPLE_SHAPES.includes(candidate.sampleShape as SampleShape)
    ? candidate.sampleShape as SampleShape
    : null;
  const sphereRadius = typeof candidate.sphereRadius === 'number'
    && Number.isFinite(candidate.sphereRadius)
    && candidate.sphereRadius > 0
    && candidate.sphereRadius <= 500
    ? candidate.sphereRadius
    : 25;
  const viewMode = VIEW_MODES.includes(candidate.viewMode as ViewMode)
    ? candidate.viewMode as ViewMode
    : 'original';
  const clipCandidate = candidate.clipPlane;
  const clipPlane: ClipPlaneState = clipCandidate
    && ['x', 'y', 'z'].includes(clipCandidate.axis)
    && typeof clipCandidate.position === 'number'
    && Number.isFinite(clipCandidate.position)
    && typeof clipCandidate.flipped === 'boolean'
    ? {
        axis: clipCandidate.axis,
        position: Math.max(0, Math.min(1, clipCandidate.position)),
        flipped: clipCandidate.flipped,
      }
    : { axis: 'z', position: 0.5, flipped: false };
  const brushRadius = typeof candidate.brushRadius === 'number'
    && Number.isFinite(candidate.brushRadius)
    && candidate.brushRadius >= 0
    && candidate.brushRadius <= 1_000
    ? candidate.brushRadius
    : 0;

  return {
    params: { ...DEFAULT_PARAMS, ...sanitizedParams },
    generationSeed: normalizeGenerationSeed(candidate.generationSeed),
    sampleShape,
    sphereMode: candidate.sphereMode === true && sampleShape !== null,
    sphereRadius,
    viewMode,
    clipPlane,
    viewerBackground: normalizeViewerBackground(candidate.viewerBackground),
    brushRadius,
  };
}

function canUseBrowserStorage() {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function canUseIndexedDb() {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

function loadLegacyPersistedState(): PersistedState | null {
  try {
    if (!canUseBrowserStorage()) return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizePersistedState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveLegacyPersistedState(s: PersistedState) {
  try {
    if (!canUseBrowserStorage()) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* quota exceeded — ignore */ }
}

function clearLegacyPersistedState() {
  try {
    if (!canUseBrowserStorage()) return;
    window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

function openPersistenceDb(): Promise<IDBDatabase | null> {
  if (!canUseIndexedDb()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function loadPersistedAppState(): Promise<Partial<PersistedAppState> | null> {
  const db = await openPersistenceDb();
  if (!db) return null;

  return new Promise((resolve) => {
    const transaction = db.transaction(DB_STORE, 'readonly');
    const request = transaction.objectStore(DB_STORE).get(DB_STATE_KEY);

    request.onsuccess = () => resolve((request.result ?? null) as Partial<PersistedAppState> | null);
    request.onerror = () => resolve(null);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
    transaction.onabort = () => db.close();
  });
}

async function savePersistedAppState(snapshot: PersistedAppState): Promise<void> {
  const db = await openPersistenceDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(DB_STORE, 'readwrite');
    transaction.objectStore(DB_STORE).put(snapshot, DB_STATE_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      resolve();
    };
    transaction.onabort = () => {
      db.close();
      resolve();
    };
  });
}

async function clearPersistedAppState(): Promise<void> {
  const db = await openPersistenceDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(DB_STORE, 'readwrite');
    transaction.objectStore(DB_STORE).delete(DB_STATE_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      resolve();
    };
    transaction.onabort = () => {
      db.close();
      resolve();
    };
  });
}

const persisted = loadLegacyPersistedState();

const ALL_LATTICE_TYPES: LatticeType[] = [
  'gyroid',
  'schwarzP',
  'schwarzD',
  'neovius',
  'iwp',
  'bcc',
  'octet',
  'diamond',
  'hexagon',
  'triangle',
  'voronoi',
  'spinodal',
];

function paramsForType(base: LatticeParams, type: LatticeType): LatticeParams {
  const isPolygonSurface = type === 'hexagon' || type === 'triangle';
  return {
    ...base,
    latticeType: type,
    variant: isPolygonSurface ? 'implicit_conformal' : 'shell_core',
    surfaceOnly: isPolygonSurface ? true : base.surfaceOnly,
    noShell: isPolygonSurface ? false : base.noShell,
    ...(isPolygonSurface ? {
      cellSize: 4,
      surfaceDepth: 5,
      strutDiameter: 1.8,
      minFeatureSize: 2,
      toleranceMm: 0.2,
      exportResolution: 5,
      thinSectionFilter: 0,
    } : {}),
  };
}

function defaultParamsForType(type: LatticeType): LatticeParams {
  return paramsForType(DEFAULT_PARAMS, type);
}

function seedDemoParamsMap(existing: DemoParamsByType): DemoParamsByType {
  const out: DemoParamsByType = { ...existing };
  for (const type of ALL_LATTICE_TYPES) {
    if (!out[type]) out[type] = defaultParamsForType(type);
  }
  return out;
}

interface AppState {
  // Mesh
  originalMesh: TriangleMesh | null;
  meshInfo: MeshInfo | null;
  meshRepaired: boolean;
  meshFileName: string;

  // Sample / sphere mode
  sampleShape: SampleShape | null;
  sphereMode: boolean;
  sphereRadius: number;

  // Selection
  selectionMode: SelectionMode;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
  brushRadius: number;
  selectionUndo: SelectionSnapshot[];
  selectionRedo: SelectionSnapshot[];
  selectionStrokeStart: SelectionSnapshot | null;

  // Params
  params: LatticeParams;
  generationSeed: number;
  demoParamsByType: DemoParamsByType;

  // Generation
  generating: boolean;
  progress: number;
  progressMessage: string;
  generationError: string | null;
  resultMesh: MarchingCubesResult | null;

  // Validation
  validation: ValidationResult | null;

  // View
  viewMode: ViewMode;
  clipPlane: ClipPlaneState;
  viewerBackground: string;
  viewportResetSignal: number;
  viewerCameraState: ViewerCameraState | null;
  demoModeActive: boolean;
  demoRunId: number;
  demoSuspended: SuspendedResult | null;

  // Logs
  logs: LogEntry[];

  // Boot
  persistenceHydrated: boolean;

  // Actions
  setOriginalMesh: (mesh: TriangleMesh | null, info: MeshInfo | null, fileName: string) => void;
  setMeshRepaired: (repaired: boolean) => void;
  setSampleShape: (shape: SampleShape) => void;
  setSphereMode: (radius: number) => void;
  setSelectionMode: (mode: SelectionMode) => void;
  setBrushRadius: (radius: number) => void;
  beginSelectionStroke: () => void;
  endSelectionStroke: () => void;
  paintTriangles: (triIndices: number[], additive: boolean) => void;
  toggleKeepOut: (triIdx: number) => void;
  toggleKeepIn: (triIdx: number) => void;
  selectAllKeepOut: () => void;
  clearSelection: () => void;
  undoSelection: () => void;
  redoSelection: () => void;
  updateParams: (partial: Partial<LatticeParams>) => void;
  reseedGeneration: () => void;
  setProcessPreset: (preset: ProcessPreset) => void;
  setLatticeType: (type: LatticeType) => void;
  setVariant: (variant: GenerationVariant) => void;
  setGenerating: (generating: boolean) => void;
  setProgress: (progress: number, message: string) => void;
  setGenerationError: (message: string | null) => void;
  setResultMesh: (result: MarchingCubesResult | null) => void;
  setValidation: (validation: ValidationResult | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setClipPlane: (partial: Partial<ClipPlaneState>) => void;
  setViewerBackground: (color: string) => void;
  resetViewport: () => void;
  setViewerCameraState: (cameraState: ViewerCameraState | null) => void;
  setDemoModeActive: (active: boolean) => void;
  startDemoRun: () => void;
  importParams: (imported: Partial<LatticeParams>) => void;
  restoreProject: (project: ProjectRestoreState) => void;
  addLog: (message: string, level?: 'info' | 'warn' | 'error') => void;
  clearLogs: () => void;
  resetProject: () => void;
}

// Shape display names and default sizes
export const SAMPLE_SHAPE_INFO: Record<SampleShape, { label: string; fileName: string }> = {
  sphere:   { label: 'Sphere (R=25mm)',    fileName: 'Sphere R=25mm' },
  cube:     { label: 'Cube (30mm)',         fileName: 'Cube 30mm' },
  cylinder: { label: 'Cylinder (R=15 H=40mm)', fileName: 'Cylinder R=15 H=40mm' },
  torus:    { label: 'Torus (R=20 r=8mm)', fileName: 'Torus R=20 r=8mm' },
  capsule:  { label: 'Capsule (R=12 H=30mm)', fileName: 'Capsule R=12 H=30mm' },
};

interface ViewAvailability {
  demoModeActive: boolean;
  originalMesh: TriangleMesh | null;
  sphereMode: boolean;
  resultMesh: MarchingCubesResult | null;
}

/** Single source of truth for which viewer modes are selectable. */
export function canSelectView(state: ViewAvailability, mode: ViewMode): boolean {
  if (state.demoModeActive) return true;
  if (mode === 'original') return Boolean(state.originalMesh || state.sphereMode);
  return Boolean(state.resultMesh);
}

function legalViewMode(state: ViewAvailability, desired: ViewMode): ViewMode {
  return canSelectView(state, desired) ? desired : 'original';
}

/** A completed run parked while multiview borrows the viewport. Never persisted. */
interface SuspendedResult {
  resultMesh: MarchingCubesResult | null;
  validation: ValidationResult | null;
  viewMode: ViewMode;
}

export const useStore = create<AppState>((set) => ({
  originalMesh: null,
  meshInfo: null,
  meshRepaired: false,
  meshFileName: persisted?.sampleShape ? SAMPLE_SHAPE_INFO[persisted.sampleShape].fileName : '',
  sampleShape: persisted?.sampleShape ?? null,
  sphereMode: persisted?.sphereMode ?? false,
  sphereRadius: persisted?.sphereRadius ?? 25,
  selectionMode: 'none',
  keepOutTris: new Set<number>(),
  keepInTris: new Set<number>(),
  brushRadius: persisted?.brushRadius ?? 0,
  selectionUndo: [],
  selectionRedo: [],
  selectionStrokeStart: null,
  params: persisted?.params ? { ...DEFAULT_PARAMS, ...persisted.params } : { ...DEFAULT_PARAMS },
  generationSeed: persisted?.generationSeed ?? DEFAULT_GENERATION_SEED,
  demoParamsByType: {},
  generating: false,
  progress: 0,
  progressMessage: '',
  generationError: null,
  resultMesh: null,
  validation: null,
  viewMode: persisted?.viewMode ?? 'original',
  clipPlane: persisted?.clipPlane ?? { axis: 'z', position: 0.5, flipped: false },
  viewerBackground: persisted?.viewerBackground ?? DEFAULT_VIEWER_BACKGROUND,
  viewportResetSignal: 0,
  viewerCameraState: null,
  demoModeActive: false,
  demoSuspended: null,
  demoRunId: 0,
  logs: [],
  // IndexedDB is asynchronous, so the UI waits for saved preferences before rendering.
  persistenceHydrated: false,

  setOriginalMesh: (mesh, info, fileName) => set({
    originalMesh: mesh,
    meshInfo: info,
    meshFileName: fileName,
    sampleShape: null,
    sphereMode: false,
    selectionMode: 'none',
    resultMesh: null,
    validation: null,
    generationError: null,
    viewMode: 'original',
    keepOutTris: new Set(),
    keepInTris: new Set(),
    selectionUndo: [],
    selectionRedo: [],
    selectionStrokeStart: null,
    demoParamsByType: {},
    viewerCameraState: null,
    demoModeActive: false,
    demoSuspended: null,
  }),

  setMeshRepaired: (repaired) => set((s) => ({
    meshInfo: s.meshInfo ? { ...s.meshInfo, repaired } : null,
    meshRepaired: repaired,
  })),

  setSampleShape: (shape) => set({
    sampleShape: shape,
    sphereMode: true,   // reuse sphereMode flag for "procedural" mode
    sphereRadius: 25,   // kept for sphere; other shapes have fixed dims
    originalMesh: null,
    meshInfo: null,
    meshFileName: SAMPLE_SHAPE_INFO[shape].fileName,
    selectionMode: 'none',
    resultMesh: null,
    validation: null,
    generationError: null,
    viewMode: 'original',
    keepOutTris: new Set(),
    keepInTris: new Set(),
    selectionUndo: [],
    selectionRedo: [],
    selectionStrokeStart: null,
    demoParamsByType: {},
    viewerCameraState: null,
    demoModeActive: false,
    demoSuspended: null,
    params: {
      ...DEFAULT_PARAMS,
      toleranceMm: 0.2,
      shellThickness: 1.5,
      cellSize: 8,
      wallThickness: 1.0,
      strutDiameter: 1.0,
      processPreset: 'SLS_MJF',
    },
  }),

  setSphereMode: (radius) => set({
    sampleShape: 'sphere',
    sphereMode: true,
    sphereRadius: radius,
    originalMesh: null,
    meshInfo: null,
    meshFileName: `Sphere R=${radius}mm`,
    selectionMode: 'none',
    resultMesh: null,
    validation: null,
    generationError: null,
    viewMode: 'original',
    keepOutTris: new Set(),
    keepInTris: new Set(),
    selectionUndo: [],
    selectionRedo: [],
    selectionStrokeStart: null,
    demoParamsByType: {},
    viewerCameraState: null,
    demoModeActive: false,
    demoSuspended: null,
    params: {
      ...DEFAULT_PARAMS,
      toleranceMm: 0.2,
      shellThickness: 1.5,
      cellSize: 8,
      wallThickness: 1.0,
      strutDiameter: 1.0,
      processPreset: 'SLS_MJF',
    },
  }),

  setSelectionMode: (mode) => set({ selectionMode: mode }),

  setBrushRadius: (radius) => set({ brushRadius: Math.max(0, radius) }),

  beginSelectionStroke: () => set((s) => (
    s.selectionStrokeStart ? {} : { selectionStrokeStart: currentSelection(s) }
  )),

  endSelectionStroke: () => set((s) => {
    if (!s.selectionStrokeStart) return {};
    const start = s.selectionStrokeStart;
    if (selectionsMatch(start, currentSelection(s))) return { selectionStrokeStart: null };
    return {
      selectionStrokeStart: null,
      selectionUndo: [...s.selectionUndo.slice(-(MAX_SELECTION_HISTORY - 1)), start],
      selectionRedo: [],
    };
  }),

  paintTriangles: (triIndices, additive) => set((s) => {
    if (s.selectionMode === 'none' || triIndices.length === 0) return {};
    const target = new Set(s.selectionMode === 'keep_out' ? s.keepOutTris : s.keepInTris);
    const other = new Set(s.selectionMode === 'keep_out' ? s.keepInTris : s.keepOutTris);
    let changed = false;
    for (const triIdx of triIndices) {
      if (triIdx < 0 || triIdx >= (s.originalMesh?.triCount ?? 0)) continue;
      if (additive) {
        if (!target.has(triIdx)) {
          target.add(triIdx);
          changed = true;
        }
        if (other.delete(triIdx)) changed = true;
      } else if (target.delete(triIdx)) {
        changed = true;
      }
    }
    if (!changed) return {};
    const selection = s.selectionMode === 'keep_out'
      ? { keepOutTris: target, keepInTris: other }
      : { keepOutTris: other, keepInTris: target };
    return s.selectionStrokeStart
      ? selection
      : { ...selection, ...pushSelectionHistory(s) };
  }),

  toggleKeepOut: (triIdx) => set((s) => {
    const next = new Set(s.keepOutTris);
    const keepIn = new Set(s.keepInTris);
    if (next.has(triIdx)) next.delete(triIdx); else next.add(triIdx);
    keepIn.delete(triIdx);
    return { keepOutTris: next, keepInTris: keepIn, ...pushSelectionHistory(s) };
  }),

  toggleKeepIn: (triIdx) => set((s) => {
    const next = new Set(s.keepInTris);
    const keepOut = new Set(s.keepOutTris);
    if (next.has(triIdx)) next.delete(triIdx); else next.add(triIdx);
    keepOut.delete(triIdx);
    return { keepInTris: next, keepOutTris: keepOut, ...pushSelectionHistory(s) };
  }),

  selectAllKeepOut: () => set((s) => {
    if (!s.originalMesh) return {};
    const all = new Set<number>();
    for (let i = 0; i < s.originalMesh.triCount; i++) all.add(i);
    return { keepOutTris: all, keepInTris: new Set<number>(), ...pushSelectionHistory(s) };
  }),

  clearSelection: () => set((s) => ({
    keepOutTris: new Set(),
    keepInTris: new Set(),
    ...pushSelectionHistory(s),
  })),

  undoSelection: () => set((s) => {
    const previous = s.selectionUndo[s.selectionUndo.length - 1];
    if (!previous) return {};
    return {
      keepOutTris: new Set(previous.keepOut),
      keepInTris: new Set(previous.keepIn),
      selectionUndo: s.selectionUndo.slice(0, -1),
      selectionRedo: [...s.selectionRedo, currentSelection(s)].slice(-MAX_SELECTION_HISTORY),
    };
  }),

  redoSelection: () => set((s) => {
    const next = s.selectionRedo[s.selectionRedo.length - 1];
    if (!next) return {};
    return {
      keepOutTris: new Set(next.keepOut),
      keepInTris: new Set(next.keepIn),
      selectionUndo: [...s.selectionUndo, currentSelection(s)].slice(-MAX_SELECTION_HISTORY),
      selectionRedo: s.selectionRedo.slice(0, -1),
    };
  }),

  updateParams: (partial) => set((s) => {
    const nextParams = { ...s.params, ...partial };
    if (!s.demoModeActive) return { params: nextParams };
    return {
      params: nextParams,
      demoParamsByType: {
        ...s.demoParamsByType,
        [nextParams.latticeType]: nextParams,
      },
    };
  }),

  reseedGeneration: () => set((state) => ({
    generationSeed: createReseedValue(state.generationSeed),
    resultMesh: null,
    validation: null,
    generationError: null,
  })),

  setProcessPreset: (preset) => set((s) => {
    const nextParams = { ...s.params, processPreset: preset, ...PROCESS_DEFAULTS[preset] };
    if (!s.demoModeActive) return { params: nextParams };
    return {
      params: nextParams,
      demoParamsByType: {
        ...s.demoParamsByType,
        [nextParams.latticeType]: nextParams,
      },
    };
  }),

  setLatticeType: (type) => set((s) => {
    if (s.demoModeActive) {
      const currentType = s.params.latticeType;
      const nextMap: DemoParamsByType = {
        ...s.demoParamsByType,
        [currentType]: { ...s.params, latticeType: currentType },
      };
      const nextParams = nextMap[type] ? { ...nextMap[type]!, latticeType: type } : defaultParamsForType(type);
      nextMap[type] = nextParams;
      return {
        params: nextParams,
        demoParamsByType: nextMap,
      };
    }
    return { params: paramsForType(s.params, type) };
  }),

  setVariant: (variant) => set((s) => {
    const nextParams = {
      ...s.params,
      variant,
      surfaceOnly: variant === 'implicit_conformal' ? true : s.params.surfaceOnly,
      noShell: variant === 'implicit_conformal' ? false : s.params.noShell,
    };
    if (!s.demoModeActive) return { params: nextParams };
    return {
      params: nextParams,
      demoParamsByType: {
        ...s.demoParamsByType,
        [nextParams.latticeType]: nextParams,
      },
    };
  }),

  setGenerating: (generating) => set({ generating }),

  setProgress: (progress, message) => set({ progress, progressMessage: message }),

  setGenerationError: (message) => set({ generationError: message }),

  setResultMesh: (result) => set((s) => {
    if (!result) return { resultMesh: null, viewMode: 'original' };
    // Preserve current view if it works with a result mesh; otherwise switch to lattice
    const resultViews: ViewMode[] = ['lattice', 'cross_section', 'xray'];
    const keepView = resultViews.includes(s.viewMode);
    return { resultMesh: result, viewMode: keepView ? s.viewMode : 'xray' };
  }),

  setValidation: (validation) => set({ validation }),

  setViewMode: (mode) => set((s) => (canSelectView(s, mode) ? { viewMode: mode } : {})),

  setClipPlane: (partial) => set((s) => ({ clipPlane: { ...s.clipPlane, ...partial } })),

  setViewerBackground: (color) => set({ viewerBackground: normalizeViewerBackground(color) }),

  resetViewport: () => set((s) => ({
    viewportResetSignal: s.viewportResetSignal + 1,
    viewerCameraState: null,
  })),

  setViewerCameraState: (cameraState) => set({ viewerCameraState: cameraState }),

  setDemoModeActive: (active) => set((s) => {
    if (active) return { demoModeActive: true };
    // A run that finished while multiview was open outranks the parked one.
    const restored = s.resultMesh
      ? { resultMesh: s.resultMesh, validation: s.validation, viewMode: s.viewMode }
      : (s.demoSuspended ?? { resultMesh: null, validation: null, viewMode: 'original' as ViewMode });
    return {
      demoModeActive: false,
      demoSuspended: null,
      resultMesh: restored.resultMesh,
      validation: restored.validation,
      viewMode: legalViewMode(
        { ...s, demoModeActive: false, resultMesh: restored.resultMesh },
        restored.viewMode,
      ),
    };
  }),

  startDemoRun: () => set((s) => {
    const currentType = s.params.latticeType;
    const mapWithCurrent = {
      ...s.demoParamsByType,
      [currentType]: { ...s.params, latticeType: currentType },
    };
    const nextMap = seedDemoParamsMap(mapWithCurrent);
    const activeParams = nextMap[currentType] ?? s.params;
    return {
      demoModeActive: true,
      demoRunId: s.demoRunId + 1,
      // Park the finished run rather than destroying it; multiview only borrows the viewport.
      demoSuspended: s.demoModeActive
        ? s.demoSuspended
        : { resultMesh: s.resultMesh, validation: s.validation, viewMode: s.viewMode },
      resultMesh: null,
      validation: null,
      viewMode: 'lattice',
      params: activeParams,
      demoParamsByType: nextMap,
    };
  }),

  addLog: (message, level = 'info') => set((s) => ({
    logs: [...s.logs.slice(-200), { time: Date.now(), message, level }],
  })),

  importParams: (imported) => set((s) => {
    const nextParams = { ...s.params, ...imported };
    if (!s.demoModeActive) {
      return {
        params: nextParams,
        resultMesh: null,
        validation: null,
      };
    }
    return {
      params: nextParams,
      resultMesh: null,
      validation: null,
      demoParamsByType: {
        ...s.demoParamsByType,
        [nextParams.latticeType]: nextParams,
      },
    };
  }),

  restoreProject: (project) => set({
    originalMesh: project.originalMesh,
    meshInfo: project.meshInfo,
    meshRepaired: project.meshInfo?.repaired ?? false,
    meshFileName: project.meshFileName,
    sampleShape: project.sampleShape,
    sphereMode: Boolean(project.sampleShape),
    sphereRadius: project.sphereRadius,
    selectionMode: 'none',
    keepOutTris: new Set(project.keepOutTris),
    keepInTris: new Set(project.keepInTris),
    selectionUndo: [],
    selectionRedo: [],
    selectionStrokeStart: null,
    params: { ...project.params },
    generationSeed: normalizeGenerationSeed(project.generationSeed),
    demoParamsByType: {},
    generating: false,
    progress: 0,
    progressMessage: '',
    generationError: null,
    resultMesh: null,
    validation: null,
    viewMode: 'original',
    clipPlane: project.clipPlane ?? { axis: 'z', position: 0.5, flipped: false },
    viewerBackground: normalizeViewerBackground(project.viewerBackground),
    viewerCameraState: null,
    demoModeActive: false,
    demoSuspended: null,
    demoRunId: 0,
  }),

  clearLogs: () => set({ logs: [] }),

  resetProject: () => {
    clearLegacyPersistedState();
    void clearPersistedAppState();
    return set({
      originalMesh: null,
      meshInfo: null,
      meshRepaired: false,
      meshFileName: '',
      sampleShape: null,
      sphereMode: false,
      sphereRadius: 25,
      selectionMode: 'none',
      resultMesh: null,
      validation: null,
      keepOutTris: new Set(),
      keepInTris: new Set(),
      brushRadius: 0,
      selectionUndo: [],
      selectionRedo: [],
      selectionStrokeStart: null,
      params: { ...DEFAULT_PARAMS },
      generationSeed: DEFAULT_GENERATION_SEED,
      demoParamsByType: {},
      generating: false,
      progress: 0,
      progressMessage: '',
      generationError: null,
      viewMode: 'original',
      clipPlane: { axis: 'z', position: 0.5, flipped: false },
      viewerBackground: DEFAULT_VIEWER_BACKGROUND,
      viewportResetSignal: 0,
      viewerCameraState: null,
      logs: [],
      demoModeActive: false,
      demoSuspended: null,
      demoRunId: 0,
    });
  },
}));

function persistedSubset(state: AppState): PersistedState {
  return {
    params: state.params,
    generationSeed: state.generationSeed,
    sampleShape: state.sampleShape,
    sphereMode: state.sphereMode,
    sphereRadius: state.sphereRadius,
    viewMode: state.viewMode,
    clipPlane: state.clipPlane,
    viewerBackground: state.viewerBackground,
    brushRadius: state.brushRadius,
  };
}

export function buildPersistedAppState(state: AppState): PersistedAppState {
  return {
    version: 3,
    savedAt: Date.now(),
    ...persistedSubset(state),
    viewerCameraState: state.viewerCameraState,
  };
}

export function hydrateFromSnapshot(snapshot: Partial<PersistedAppState>): Partial<AppState> {
  const persistedState = normalizePersistedState(snapshot);
  return {
    originalMesh: null,
    meshInfo: null,
    meshRepaired: false,
    meshFileName: persistedState.sampleShape ? SAMPLE_SHAPE_INFO[persistedState.sampleShape].fileName : '',
    sampleShape: persistedState.sampleShape,
    sphereMode: persistedState.sphereMode,
    sphereRadius: persistedState.sphereRadius,
    selectionMode: 'none',
    keepOutTris: new Set(),
    keepInTris: new Set(),
    brushRadius: persistedState.brushRadius,
    selectionUndo: [],
    selectionRedo: [],
    selectionStrokeStart: null,
    params: persistedState.params,
    generationSeed: persistedState.generationSeed,
    demoParamsByType: {},
    generating: false,
    progress: 0,
    progressMessage: '',
    generationError: null,
    resultMesh: null,
    validation: null,
    viewMode: persistedState.viewMode,
    clipPlane: persistedState.clipPlane,
    viewerBackground: persistedState.viewerBackground,
    viewerCameraState: normalizeViewerCameraState(snapshot.viewerCameraState),
    demoModeActive: false,
    demoSuspended: null,
    demoRunId: 0,
    logs: [],
  };
}

let persistenceReady = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersistence() {
  if (!persistenceReady || typeof window === 'undefined') return;
  // Skip rapid progress updates; the final state is saved when generation ends.
  if (useStore.getState().generating) return;

  if (persistTimer) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    const state = useStore.getState();
    if (state.generating) return;
    saveLegacyPersistedState(persistedSubset(state));
    void savePersistedAppState(buildPersistedAppState(state));
  }, 250);
}

async function hydratePersistence() {
  try {
    const snapshot = await loadPersistedAppState();
    if (snapshot) {
      useStore.setState(hydrateFromSnapshot(snapshot));
      // Overwrite legacy snapshots before rendering so old mesh buffers and logs
      // do not remain in IndexedDB after upgrading to the minimized schema.
      await savePersistedAppState(buildPersistedAppState(useStore.getState()));
    }
  } catch {
    // Storage-disabled/private contexts must fall back to a usable new project.
  } finally {
    persistenceReady = true;
    useStore.setState({ persistenceHydrated: true });
  }
}

void hydratePersistence();

// ── Persist relevant app state on changes ────────────────
useStore.subscribe(() => {
  schedulePersistence();
});
