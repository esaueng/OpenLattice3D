// Global app state using Zustand with IndexedDB persistence
import { create } from 'zustand';
import type { LatticeParams, MeshInfo, ValidationResult, ProcessPreset, LatticeType, GenerationVariant, SelectionMode, SampleShape } from '../types/project';
import { DEFAULT_PARAMS, PROCESS_DEFAULTS } from '../types/project';
import type { TriangleMesh } from '../geometry/stl-parser';
import type { MarchingCubesResult } from '../geometry/marching-cubes';

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
const MAX_PERSISTED_LOGS = 250;

interface PersistedState {
  params: LatticeParams;
  sampleShape: SampleShape | null;
  sphereMode: boolean;
  sphereRadius: number;
  viewMode: ViewMode;
  clipPlane: ClipPlaneState;
  viewerBackground: string;
}

type DemoParamsByType = Partial<Record<LatticeType, LatticeParams>>;

interface PersistedAppState extends PersistedState {
  version: number;
  savedAt: number;
  originalMesh: TriangleMesh | null;
  meshInfo: MeshInfo | null;
  meshRepaired: boolean;
  meshFileName: string;
  selectionMode: SelectionMode;
  keepOutTris: number[];
  keepInTris: number[];
  demoParamsByType: DemoParamsByType;
  resultMesh: MarchingCubesResult | null;
  validation: ValidationResult | null;
  viewerCameraState: ViewerCameraState | null;
  demoModeActive: boolean;
  demoRunId: number;
  logs: LogEntry[];
}

function canUseBrowserStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function canUseIndexedDb() {
  return typeof indexedDB !== 'undefined';
}

function loadLegacyPersistedState(): Partial<PersistedState> | null {
  try {
    if (!canUseBrowserStorage()) return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<PersistedState>;
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

  // Params
  params: LatticeParams;
  demoParamsByType: DemoParamsByType;

  // Generation
  generating: boolean;
  progress: number;
  progressMessage: string;
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

  // Logs
  logs: LogEntry[];

  // Actions
  setOriginalMesh: (mesh: TriangleMesh | null, info: MeshInfo | null, fileName: string) => void;
  setMeshRepaired: (repaired: boolean) => void;
  setSampleShape: (shape: SampleShape) => void;
  setSphereMode: (radius: number) => void;
  setSelectionMode: (mode: SelectionMode) => void;
  toggleKeepOut: (triIdx: number) => void;
  toggleKeepIn: (triIdx: number) => void;
  selectAllKeepOut: () => void;
  clearSelection: () => void;
  updateParams: (partial: Partial<LatticeParams>) => void;
  setProcessPreset: (preset: ProcessPreset) => void;
  setLatticeType: (type: LatticeType) => void;
  setVariant: (variant: GenerationVariant) => void;
  setGenerating: (generating: boolean) => void;
  setProgress: (progress: number, message: string) => void;
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
  params: persisted?.params ? { ...DEFAULT_PARAMS, ...persisted.params } : { ...DEFAULT_PARAMS },
  demoParamsByType: {},
  generating: false,
  progress: 0,
  progressMessage: '',
  resultMesh: null,
  validation: null,
  viewMode: persisted?.viewMode ?? 'original',
  clipPlane: persisted?.clipPlane ?? { axis: 'z', position: 0.5, flipped: false },
  viewerBackground: persisted?.viewerBackground ?? '#000000',
  viewportResetSignal: 0,
  viewerCameraState: null,
  demoModeActive: false,
  demoRunId: 0,
  logs: [],

  setOriginalMesh: (mesh, info, fileName) => set({
    originalMesh: mesh,
    meshInfo: info,
    meshFileName: fileName,
    sampleShape: null,
    sphereMode: false,
    resultMesh: null,
    validation: null,
    keepOutTris: new Set(),
    keepInTris: new Set(),
    demoParamsByType: {},
    viewerCameraState: null,
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
    resultMesh: null,
    validation: null,
    keepOutTris: new Set(),
    keepInTris: new Set(),
    demoParamsByType: {},
    viewerCameraState: null,
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
    resultMesh: null,
    validation: null,
    keepOutTris: new Set(),
    keepInTris: new Set(),
    demoParamsByType: {},
    viewerCameraState: null,
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

  toggleKeepOut: (triIdx) => set((s) => {
    const next = new Set(s.keepOutTris);
    if (next.has(triIdx)) next.delete(triIdx); else next.add(triIdx);
    return { keepOutTris: next };
  }),

  toggleKeepIn: (triIdx) => set((s) => {
    const next = new Set(s.keepInTris);
    if (next.has(triIdx)) next.delete(triIdx); else next.add(triIdx);
    return { keepInTris: next };
  }),

  selectAllKeepOut: () => set((s) => {
    if (!s.originalMesh) return {};
    const all = new Set<number>();
    for (let i = 0; i < s.originalMesh.triCount; i++) all.add(i);
    return { keepOutTris: all };
  }),

  clearSelection: () => set({ keepOutTris: new Set(), keepInTris: new Set() }),

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

  setResultMesh: (result) => set((s) => {
    if (!result) return { resultMesh: null, viewMode: 'original' };
    // Preserve current view if it works with a result mesh; otherwise switch to lattice
    const resultViews: ViewMode[] = ['lattice', 'cross_section', 'xray'];
    const keepView = resultViews.includes(s.viewMode);
    return { resultMesh: result, viewMode: keepView ? s.viewMode : 'xray' };
  }),

  setValidation: (validation) => set({ validation }),

  setViewMode: (mode) => set({ viewMode: mode }),

  setClipPlane: (partial) => set((s) => ({ clipPlane: { ...s.clipPlane, ...partial } })),

  setViewerBackground: (color) => set({ viewerBackground: color }),

  resetViewport: () => set((s) => ({ viewportResetSignal: s.viewportResetSignal + 1 })),

  setViewerCameraState: (cameraState) => set({ viewerCameraState: cameraState }),

  setDemoModeActive: (active) => set({ demoModeActive: active }),

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
      params: { ...DEFAULT_PARAMS },
      demoParamsByType: {},
      generating: false,
      progress: 0,
      progressMessage: '',
      viewMode: 'original',
      clipPlane: { axis: 'z', position: 0.5, flipped: false },
      viewerBackground: '#000000',
      viewportResetSignal: 0,
      viewerCameraState: null,
      logs: [],
      demoModeActive: false,
      demoRunId: 0,
    });
  },
}));

function persistedSubset(state: AppState): PersistedState {
  return {
    params: state.params,
    sampleShape: state.sampleShape,
    sphereMode: state.sphereMode,
    sphereRadius: state.sphereRadius,
    viewMode: state.viewMode,
    clipPlane: state.clipPlane,
    viewerBackground: state.viewerBackground,
  };
}

function buildPersistedAppState(state: AppState): PersistedAppState {
  return {
    version: 1,
    savedAt: Date.now(),
    ...persistedSubset(state),
    originalMesh: state.originalMesh,
    meshInfo: state.meshInfo,
    meshRepaired: state.meshRepaired,
    meshFileName: state.meshFileName,
    selectionMode: state.selectionMode,
    keepOutTris: Array.from(state.keepOutTris),
    keepInTris: Array.from(state.keepInTris),
    demoParamsByType: state.demoParamsByType,
    resultMesh: state.resultMesh,
    validation: state.validation,
    viewerCameraState: state.viewerCameraState,
    demoModeActive: state.demoModeActive,
    demoRunId: state.demoRunId,
    logs: state.logs.slice(-MAX_PERSISTED_LOGS),
  };
}

function hydrateFromSnapshot(snapshot: Partial<PersistedAppState>): Partial<AppState> {
  return {
    originalMesh: snapshot.originalMesh ?? null,
    meshInfo: snapshot.meshInfo ?? null,
    meshRepaired: snapshot.meshRepaired ?? false,
    meshFileName: snapshot.meshFileName ?? (snapshot.sampleShape ? SAMPLE_SHAPE_INFO[snapshot.sampleShape].fileName : ''),
    sampleShape: snapshot.sampleShape ?? null,
    sphereMode: snapshot.sphereMode ?? false,
    sphereRadius: snapshot.sphereRadius ?? 25,
    selectionMode: snapshot.selectionMode ?? 'none',
    keepOutTris: new Set(snapshot.keepOutTris ?? []),
    keepInTris: new Set(snapshot.keepInTris ?? []),
    params: snapshot.params ? { ...DEFAULT_PARAMS, ...snapshot.params } : { ...DEFAULT_PARAMS },
    demoParamsByType: snapshot.demoParamsByType ?? {},
    generating: false,
    progress: 0,
    progressMessage: '',
    resultMesh: snapshot.resultMesh ?? null,
    validation: snapshot.validation ?? null,
    viewMode: snapshot.viewMode ?? 'original',
    clipPlane: snapshot.clipPlane ?? { axis: 'z', position: 0.5, flipped: false },
    viewerBackground: snapshot.viewerBackground ?? '#000000',
    viewerCameraState: snapshot.viewerCameraState ?? null,
    demoModeActive: snapshot.demoModeActive ?? false,
    demoRunId: snapshot.demoRunId ?? 0,
    logs: snapshot.logs ?? [],
  };
}

let persistenceReady = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersistence() {
  if (!persistenceReady || typeof window === 'undefined') return;
  // Skip while generating: progress updates fire rapidly and each snapshot
  // structured-clones the full mesh buffers into IndexedDB. The final state
  // is persisted by the store update that clears `generating`.
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
    if (snapshot) useStore.setState(hydrateFromSnapshot(snapshot));
  } finally {
    persistenceReady = true;
    schedulePersistence();
  }
}

void hydratePersistence();

// ── Persist relevant app state on changes ────────────────
useStore.subscribe(() => {
  schedulePersistence();
});
