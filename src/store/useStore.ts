// Global app state using Zustand with localStorage persistence
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

// ── Persistence helpers ──────────────────────────────────
const STORAGE_KEY = 'gen-lattice-1-state';

interface PersistedState {
  params: LatticeParams;
  sampleShape: SampleShape | null;
  sphereMode: boolean;
  sphereRadius: number;
  viewMode: ViewMode;
  clipPlane: ClipPlaneState;
  viewerBackground: string;
}

function loadPersistedState(): Partial<PersistedState> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<PersistedState>;
  } catch {
    return null;
  }
}

function savePersistedState(s: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* quota exceeded — ignore */ }
}

const persisted = loadPersistedState();

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
  generating: false,
  progress: 0,
  progressMessage: '',
  resultMesh: null,
  validation: null,
  viewMode: persisted?.viewMode ?? 'original',
  clipPlane: persisted?.clipPlane ?? { axis: 'y', position: 0.5, flipped: true },
  viewerBackground: persisted?.viewerBackground ?? '#1a1a2e',
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

  updateParams: (partial) => set((s) => ({ params: { ...s.params, ...partial } })),

  setProcessPreset: (preset) => set((s) => ({
    params: { ...s.params, processPreset: preset, ...PROCESS_DEFAULTS[preset] },
  })),

  setLatticeType: (type) => set((s) => ({ params: { ...s.params, latticeType: type } })),

  setVariant: (variant) => set((s) => ({ params: { ...s.params, variant } })),

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

  addLog: (message, level = 'info') => set((s) => ({
    logs: [...s.logs.slice(-200), { time: Date.now(), message, level }],
  })),

  importParams: (imported) => set((s) => ({
    params: { ...s.params, ...imported },
    resultMesh: null,
    validation: null,
  })),

  clearLogs: () => set({ logs: [] }),

  resetProject: () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    return set({
      originalMesh: null,
      meshInfo: null,
      meshRepaired: false,
      meshFileName: '',
      sampleShape: null,
      sphereMode: false,
      sphereRadius: 25,
      resultMesh: null,
      validation: null,
      keepOutTris: new Set(),
      keepInTris: new Set(),
      params: { ...DEFAULT_PARAMS },
      generating: false,
      progress: 0,
      progressMessage: '',
      viewMode: 'original',
      clipPlane: { axis: 'y', position: 0.5, flipped: true },
      viewerBackground: '#1a1a2e',
      logs: [],
    });
  },
}));

// ── Persist to localStorage on relevant state changes ────
useStore.subscribe((state) => {
  savePersistedState({
    params: state.params,
    sampleShape: state.sampleShape,
    sphereMode: state.sphereMode,
    sphereRadius: state.sphereRadius,
    viewMode: state.viewMode,
    clipPlane: state.clipPlane,
    viewerBackground: state.viewerBackground,
  });
});
