import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { TriangleMesh } from '../../geometry/stl-parser';
import type { MarchingCubesResult } from '../../geometry/marching-cubes';
import type { ClipPlaneState } from '../../store/useStore';
import type { LatticeParams, LatticeType, SampleShape } from '../../types/project';
import type { WorkerMessage, WorkerResponse } from '../../workers/lattice-worker';
import { trackDiagnostic, trackFailureCause, watchContextLoss } from '../../analytics';
import { parseFailureCause } from '../../utils/failure-cause';
import {
  CrossSectionView,
  generateSampleMesh,
  normalizeDemoResult,
  ResultMeshView,
  useDisposable,
  XRayView,
} from './ViewerMeshViews';
import { demoGridResolution, demoGridWorkerLimit } from './demo-grid-limits';
import { useStore } from '../../store/useStore';
import { meshVolumeMm3 } from '../../geometry/mesh-stats';
import { formatFraction, relativeDensity, sourceSolidVolumeMm3 } from '../../utils/part-statistics';

const DEMO_VIEW_TARGET_RADIUS = 8;
const DEMO_TILE_ITEMS: Array<{ type: LatticeType; label: string }> = [
  { type: 'gyroid', label: 'Gyroid' },
  { type: 'schwarzP', label: 'Schwarz P' },
  { type: 'schwarzD', label: 'Schwarz D' },
  { type: 'neovius', label: 'Neovius' },
  { type: 'iwp', label: 'IWP' },
  { type: 'bcc', label: 'BCC' },
  { type: 'octet', label: 'Octet' },
  { type: 'diamond', label: 'Diamond' },
  { type: 'hexagon', label: 'Hexagon' },
  { type: 'triangle', label: 'Triangle' },
  { type: 'voronoi', label: 'Voronoi' },
  { type: 'spinodal', label: 'Spinodal' },
];

type DemoTileState = {
  type: LatticeType;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  result: MarchingCubesResult | null;
  /** Lattice volume over solid volume, measured on the coarse preview mesh. */
  relativeDensity?: number | null;
  error?: string;
};

type DemoTileJob = {
  type: LatticeType;
  localParams: LatticeParams;
  signature: string;
  token: number;
};

function DemoTileViewer({ tile, viewMode, clipPlane, placeholder, selectedLatticeType, onSelectLatticeType }: {
  tile: DemoTileState;
  viewMode: 'original' | 'lattice' | 'cross_section' | 'xray';
  clipPlane: ClipPlaneState;
  placeholder: TriangleMesh;
  selectedLatticeType: LatticeType;
  onSelectLatticeType: (type: LatticeType) => void;
}) {
  const placeholderGeometry = useDisposable(useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(placeholder.positions, 3));
    geometry.computeVertexNormals();
    return geometry;
  }, [placeholder.positions]));
  const showPlaceholder = viewMode === 'original' || !tile.result;
  const selected = tile.type === selectedLatticeType;
  const select = useCallback(() => onSelectLatticeType(tile.type), [onSelectLatticeType, tile.type]);
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select();
  }, [select]);

  return (
    <div
      className={`demo-window ${selected ? 'demo-window-selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Select ${tile.label} lattice type`}
      onClick={select}
      onKeyDown={handleKeyDown}
    >
      <div className="demo-window-label">
        {tile.label}
        {tile.status === 'done' && tile.relativeDensity != null && (
          <span className="demo-window-density" aria-label={`about ${formatFraction(tile.relativeDensity, 0)} relative density`}>
            {' · ≈'}{formatFraction(tile.relativeDensity, 0)}
          </span>
        )}
      </div>
      <Canvas
        camera={{ fov: 58, near: 0.1, far: 10000, position: [22, -22, 16], up: [0, 0, 1] }}
        gl={{ localClippingEnabled: true }}
        onCreated={(state) => { watchContextLoss(state.gl.domElement); }}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[40, 40, 40]} intensity={0.8} />
        {showPlaceholder ? (
          <mesh geometry={placeholderGeometry}>
            <meshPhongMaterial color="#6d7ea5" side={THREE.DoubleSide} />
          </mesh>
        ) : viewMode === 'cross_section' ? (
          <CrossSectionView result={tile.result!} clip={clipPlane} />
        ) : viewMode === 'xray' ? (
          <XRayView result={tile.result!} />
        ) : (
          <ResultMeshView result={tile.result!} />
        )}
        <OrbitControls makeDefault target={[0, 0, 0]} />
      </Canvas>
      {tile.status !== 'done' && (
        <div className="demo-window-status">{tile.status === 'error' ? (tile.error ?? 'Error') : tile.status === 'running' ? 'Generating…' : 'Queued'}</div>
      )}
    </div>
  );
}

export function DemoGridView({ params, demoParamsByType, generationSeed, runId, viewMode, clipPlane, selectedLatticeType, onSelectLatticeType, sourceMesh, sphereMode, sphereRadius, sampleShape, keepOutTris, keepInTris }: {
  params: LatticeParams;
  demoParamsByType: Partial<Record<LatticeType, LatticeParams>>;
  generationSeed: number;
  runId: number;
  viewMode: 'original' | 'lattice' | 'cross_section' | 'xray';
  clipPlane: ClipPlaneState;
  selectedLatticeType: LatticeType;
  onSelectLatticeType: (type: LatticeType) => void;
  sourceMesh: TriangleMesh | null;
  sphereMode: boolean;
  sphereRadius: number;
  sampleShape: SampleShape | null;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
}) {
  const [tiles, setTiles] = useState<DemoTileState[]>(() => DEMO_TILE_ITEMS.map((item) => ({ ...item, status: 'pending', result: null })));
  const setDemoQueue = useStore((s) => s.setDemoQueue);
  const meshInfo = useStore((s) => s.meshInfo);
  // Relative density needs the solid volume; open meshes have none, so tiles then omit it.
  const sourceVolume = useMemo(
    () => (sourceMesh || sphereMode ? sourceSolidVolumeMm3({ sampleShape, sphereRadius, originalMesh: sourceMesh, meshInfo }) : null),
    [meshInfo, sampleShape, sourceMesh, sphereMode, sphereRadius],
  );
  useEffect(() => {
    setDemoQueue({
      done: tiles.filter((tile) => tile.status === 'done' || tile.status === 'error').length,
      running: tiles.filter((tile) => tile.status === 'running').length,
      total: tiles.length,
    });
  }, [setDemoQueue, tiles]);
  const workersRef = useRef<Map<LatticeType, Worker>>(new Map());
  const queuedJobsRef = useRef<Map<LatticeType, DemoTileJob>>(new Map());
  const drainQueueRef = useRef<() => void>(() => undefined);
  const tokensRef = useRef<Partial<Record<LatticeType, number>>>({});
  const completedSignatureRef = useRef<Partial<Record<LatticeType, string>>>({});
  const runningSignatureRef = useRef<Partial<Record<LatticeType, string>>>({});
  const completedInitialRunRef = useRef(false);
  const latestParamsRef = useRef(params);
  const latestDemoParamsRef = useRef(demoParamsByType);
  const keepOutKey = useMemo(() => Array.from(keepOutTris).sort((a, b) => a - b).join(','), [keepOutTris]);
  const keepInKey = useMemo(() => Array.from(keepInTris).sort((a, b) => a - b).join(','), [keepInTris]);
  const sourceKey = useMemo(() => sourceMesh
    ? `mesh:${sourceMesh.triCount}:${sourceMesh.positions.length}:${sourceMesh.normals.length}`
    : `shape:${sampleShape ?? 'none'}:${sphereMode ? 1 : 0}:${sphereRadius}`,
  [sampleShape, sourceMesh, sphereMode, sphereRadius]);
  const placeholder = useMemo(() => normalizeDemoResult(
    sourceMesh ?? (
      sphereMode && sampleShape
        ? generateSampleMesh(sampleShape, sphereRadius)
        : generateSampleMesh('sphere', DEMO_VIEW_TARGET_RADIUS)
    ),
    DEMO_VIEW_TARGET_RADIUS,
  ), [sampleShape, sourceMesh, sphereMode, sphereRadius]);

  useEffect(() => { latestParamsRef.current = params; }, [params]);
  useEffect(() => { latestDemoParamsRef.current = demoParamsByType; }, [demoParamsByType]);

  const stopWorker = useCallback((type: LatticeType) => {
    queuedJobsRef.current.delete(type);
    workersRef.current.get(type)?.terminate();
    workersRef.current.delete(type);
    runningSignatureRef.current[type] = undefined;
    tokensRef.current[type] = (tokensRef.current[type] ?? 0) + 1;
  }, []);
  const signatureFor = useCallback((type: LatticeType, localParams: LatticeParams) => JSON.stringify({
    type,
    source: sourceKey,
    keepOut: keepOutKey,
    keepIn: keepInKey,
    params: localParams,
    generationSeed,
  }), [generationSeed, keepInKey, keepOutKey, sourceKey]);

  const workerLimit = demoGridWorkerLimit(
    Boolean(sourceMesh),
    globalThis.navigator?.hardwareConcurrency ?? 2,
  );

  const startJob = useCallback((job: DemoTileJob) => {
    const { type, localParams, signature, token } = job;
    if (tokensRef.current[type] !== token) return;
    const worker = new Worker(new URL('../../workers/lattice-worker.ts', import.meta.url), { type: 'module' });
    workersRef.current.set(type, worker);
    setTiles((current) => current.map((tile) => tile.type === type
      ? { ...tile, status: 'running', error: undefined }
      : tile));
    const message: WorkerMessage = {
      type: 'generate',
      params: localParams,
      generationSeed,
      sphereMode,
      sampleShape,
      sphereRadius,
      resolution: demoGridResolution(localParams.exportResolution),
      keepOutTris: Array.from(keepOutTris),
      keepInTris: Array.from(keepInTris),
    };
    if (sourceMesh) {
      message.meshPositions = sourceMesh.positions;
      message.meshNormals = sourceMesh.normals;
      message.meshTriCount = sourceMesh.triCount;
    }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (workersRef.current.get(type) === worker) workersRef.current.delete(type);
      if (tokensRef.current[type] === token && runningSignatureRef.current[type] === signature) {
        runningSignatureRef.current[type] = undefined;
      }
      worker.terminate();
      drainQueueRef.current();
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (tokensRef.current[type] !== token) {
        finish();
        return;
      }
      const response = event.data;
      if (response.type === 'result') {
        completedSignatureRef.current[type] = signature;
        const raw = { positions: response.positions!, normals: response.normals!, triCount: response.triCount! };
        // Measured before normalisation rescales the preview to the tile.
        const density = relativeDensity(meshVolumeMm3(raw), sourceVolume);
        setTiles((current) => current.map((tile) => tile.type === type ? {
          ...tile,
          status: 'done',
          result: normalizeDemoResult(raw, DEMO_VIEW_TARGET_RADIUS),
          relativeDensity: density,
          error: undefined,
        } : tile));
        finish();
      } else if (response.type === 'error') {
        setTiles((current) => current.map((tile) => tile.type === type
          ? { ...tile, status: 'error', error: response.message }
          : tile));
        trackFailureCause(parseFailureCause(response.diagnostic));
        finish();
      }
    };
    worker.onerror = () => {
      if (tokensRef.current[type] === token) {
        setTiles((current) => current.map((tile) => tile.type === type
          ? { ...tile, status: 'error', error: 'Worker failed' }
          : tile));
        trackDiagnostic('error_worker');
      }
      finish();
    };
    worker.postMessage(message);
  }, [generationSeed, keepInTris, keepOutTris, sampleShape, sourceMesh, sourceVolume, sphereMode, sphereRadius]);

  const drainQueue = useCallback(() => {
    while (workersRef.current.size < workerLimit) {
      const next = queuedJobsRef.current.entries().next();
      if (next.done) break;
      const [type, job] = next.value;
      queuedJobsRef.current.delete(type);
      startJob(job);
    }
  }, [startJob, workerLimit]);

  useEffect(() => {
    drainQueueRef.current = drainQueue;
    drainQueue();
  }, [drainQueue]);

  const generateTiles = useCallback((types: LatticeType[], baseParams: LatticeParams, force = false) => {
    for (const type of types) {
      const saved = latestDemoParamsRef.current[type];
      const localParams: LatticeParams = saved ? { ...saved, latticeType: type } : {
        ...baseParams,
        latticeType: type,
        variant: type === 'hexagon' || type === 'triangle' ? 'implicit_conformal' : 'shell_core',
        surfaceOnly: type === 'hexagon' || type === 'triangle',
        noShell: false,
      };
      const signature = signatureFor(type, localParams);
      if (!force && (runningSignatureRef.current[type] === signature || completedSignatureRef.current[type] === signature)) continue;
      stopWorker(type);
      const token = (tokensRef.current[type] ?? 0) + 1;
      tokensRef.current[type] = token;
      runningSignatureRef.current[type] = signature;
      queuedJobsRef.current.set(type, { type, localParams, signature, token });
      setTiles((current) => current.map((tile) => tile.type === type
        ? { ...tile, status: 'pending', error: undefined }
        : tile));
    }
    drainQueueRef.current();
  }, [signatureFor, stopWorker]);

  useEffect(() => {
    const allTypes = DEMO_TILE_ITEMS.map((item) => item.type);
    let cancelled = false;
    if (!sourceMesh && !sphereMode) {
      for (const type of allTypes) stopWorker(type);
      queueMicrotask(() => {
        if (!cancelled) setTiles(DEMO_TILE_ITEMS.map((item) => ({ ...item, status: 'error', result: null, error: 'Import or select a sample model' })));
      });
      completedInitialRunRef.current = false;
      return () => { cancelled = true; };
    }
    completedSignatureRef.current = {};
    runningSignatureRef.current = {};
    queueMicrotask(() => {
      if (cancelled) return;
      setTiles(DEMO_TILE_ITEMS.map((item) => ({ ...item, status: 'pending', result: null, error: undefined })));
      generateTiles(allTypes, latestParamsRef.current, true);
    });
    completedInitialRunRef.current = true;
    return () => {
      cancelled = true;
      for (const type of allTypes) stopWorker(type);
    };
  }, [generateTiles, keepInTris, keepOutTris, runId, sampleShape, sourceMesh, sphereMode, sphereRadius, stopWorker]);

  // Parameters are shared across tiles; signatures decide which tiles actually rerun.
  useEffect(() => {
    if (!completedInitialRunRef.current || (!sourceMesh && !sphereMode)) return;
    queueMicrotask(() => generateTiles(DEMO_TILE_ITEMS.map((item) => item.type), params, false));
  }, [demoParamsByType, generateTiles, params, sourceMesh, sphereMode]);

  useEffect(() => () => {
    queuedJobsRef.current.clear();
    drainQueueRef.current = () => undefined;
    for (const worker of workersRef.current.values()) worker.terminate();
    workersRef.current.clear();
  }, []);

  return (
    <div className="demo-grid-view" aria-label="Demo lattice windows">
      {tiles.map((tile) => (
        <DemoTileViewer
          key={tile.type}
          tile={tile}
          viewMode={viewMode}
          clipPlane={clipPlane}
          placeholder={placeholder}
          selectedLatticeType={selectedLatticeType}
          onSelectLatticeType={onSelectLatticeType}
        />
      ))}
    </div>
  );
}
