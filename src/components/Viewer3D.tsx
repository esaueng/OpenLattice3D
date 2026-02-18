// 3D Viewer component using react-three-fiber
import { useRef, useMemo, useCallback, useEffect, useState } from 'react';
import { Canvas, useThree, useFrame, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../store/useStore';
import type { TriangleMesh } from '../geometry/stl-parser';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { ClipPlaneState } from '../store/useStore';
import { generateSphereMesh, generateCubeMesh, generateCylinderMesh, generateTorusMesh, generateCapsuleMesh } from '../geometry/mesh-analysis';
import type { LatticeParams, LatticeType, SampleShape } from '../types/project';
import type { WorkerMessage, WorkerResponse } from '../workers/lattice-worker';

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

const DEMO_SPHERE_RADIUS_MM = 25;
const DEMO_VIEW_TARGET_RADIUS = 8;

type DemoTileState = {
  type: LatticeType;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  result: MarchingCubesResult | null;
  error?: string;
};

/** Compute world-space bounding box from a result mesh */
function resultBounds(result: MarchingCubesResult): THREE.Box3 {
  const box = new THREE.Box3();
  const p = result.positions;
  for (let i = 0; i < p.length; i += 3) box.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
  return box;
}

/** Convert normalised clip-plane state → THREE.Plane */
function clipStateTo3(clip: ClipPlaneState, bounds: THREE.Box3): THREE.Plane {
  const normal = new THREE.Vector3(
    clip.axis === 'x' ? 1 : 0,
    clip.axis === 'y' ? 1 : 0,
    clip.axis === 'z' ? 1 : 0,
  );
  if (!clip.flipped) normal.negate();
  const min = bounds.min.getComponent('xyz'.indexOf(clip.axis));
  const max = bounds.max.getComponent('xyz'.indexOf(clip.axis));
  const worldPos = min + clip.position * (max - min);
  const constant = clip.flipped ? -worldPos : worldPos;
  return new THREE.Plane(normal, constant);
}

function OriginalMeshView({ mesh, keepOutTris, keepInTris, selectionMode, onFaceClick }: {
  mesh: TriangleMesh;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
  selectionMode: string;
  onFaceClick: (triIdx: number) => void;
}) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    const colors = new Float32Array(mesh.positions.length);
    for (let i = 0; i < mesh.triCount; i++) {
      let r = 0.7, gr = 0.7, b = 0.75;
      if (keepOutTris.has(i)) { r = 0.2; gr = 0.6; b = 1.0; }
      if (keepInTris.has(i)) { r = 1.0; gr = 0.4; b = 0.2; }
      for (let v = 0; v < 3; v++) {
        colors[i * 9 + v * 3] = r;
        colors[i * 9 + v * 3 + 1] = gr;
        colors[i * 9 + v * 3 + 2] = b;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, [mesh, keepOutTris, keepInTris]);

  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    if (selectionMode === 'none') return;
    e.stopPropagation();
    if (e.faceIndex != null) onFaceClick(e.faceIndex as number);
  }, [selectionMode, onFaceClick]);

  return (
    <mesh geometry={geom} onClick={handleClick}>
      <meshPhongMaterial vertexColors side={THREE.DoubleSide} />
    </mesh>
  );
}

function generateSampleMesh(shape: SampleShape, radius: number) {
  switch (shape) {
    case 'sphere': return generateSphereMesh(radius, 32);
    case 'cube': return generateCubeMesh(30);
    case 'cylinder': return generateCylinderMesh(15, 40, 32);
    case 'torus': return generateTorusMesh(20, 8, 32, 16);
    case 'capsule': return generateCapsuleMesh(12, 30, 24);
  }
}

function SampleMeshView({ shape, radius, keepOutTris, keepInTris }: {
  shape: SampleShape;
  radius: number;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
}) {
  const geom = useMemo(() => {
    const m = generateSampleMesh(shape, radius);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    const colors = new Float32Array(m.positions.length);
    for (let i = 0; i < m.triCount; i++) {
      let r = 0.7, gr = 0.7, b = 0.75;
      if (keepOutTris.has(i)) { r = 0.2; gr = 0.6; b = 1.0; }
      if (keepInTris.has(i)) { r = 1.0; gr = 0.4; b = 0.2; }
      for (let v = 0; v < 3; v++) {
        colors[i * 9 + v * 3] = r;
        colors[i * 9 + v * 3 + 1] = gr;
        colors[i * 9 + v * 3 + 2] = b;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, [shape, radius, keepOutTris, keepInTris]);

  return (
    <mesh geometry={geom}>
      <meshPhongMaterial vertexColors side={THREE.DoubleSide} transparent opacity={0.5} />
    </mesh>
  );
}

function ResultMeshView({ result }: { result: MarchingCubesResult }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    g.computeVertexNormals();
    return g;
  }, [result]);

  return (
    <mesh geometry={geom}>
      <meshPhongMaterial color="#4a9eff" side={THREE.DoubleSide} />
    </mesh>
  );
}

function CrossSectionView({ result, clip }: { result: MarchingCubesResult; clip: ClipPlaneState }) {
  const { gl } = useThree();
  const meshRef = useRef<THREE.Mesh>(null);

  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    g.computeVertexNormals();
    return g;
  }, [result]);

  const bounds = useMemo(() => resultBounds(result), [result]);
  const plane = useMemo(() => clipStateTo3(clip, bounds), [clip, bounds]);

  useEffect(() => {
    gl.localClippingEnabled = true;
    return () => { gl.localClippingEnabled = false; };
  }, [gl]);

  useFrame(() => {
    const p = clipStateTo3(clip, bounds);
    if (meshRef.current) {
      const mat = meshRef.current.material as THREE.MeshPhongMaterial;
      mat.clippingPlanes = [p];
    }
  });

  return (
    <mesh ref={meshRef} geometry={geom}>
      <meshPhongMaterial color="#4a9eff" side={THREE.DoubleSide} clippingPlanes={[plane]} clipShadows />
    </mesh>
  );
}



function normalizeDemoResult(result: MarchingCubesResult, targetRadius = DEMO_VIEW_TARGET_RADIUS): MarchingCubesResult {
  const bounds = resultBounds(result);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const halfMaxExtent = Math.max(size.x, size.y, size.z) * 0.5;
  if (!Number.isFinite(halfMaxExtent) || halfMaxExtent <= 1e-6) return result;

  const scale = targetRadius / halfMaxExtent;
  const src = result.positions;
  const normalized = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    normalized[i] = (src[i] - center.x) * scale;
    normalized[i + 1] = (src[i + 1] - center.y) * scale;
    normalized[i + 2] = (src[i + 2] - center.z) * scale;
  }

  return {
    positions: normalized,
    normals: result.normals,
    triCount: result.triCount,
  };
}
function XRayView({ result }: { result: MarchingCubesResult }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    g.computeVertexNormals();
    return g;
  }, [result]);

  const material = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#3388cc', side: THREE.DoubleSide, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending,
  }), []);

  return <mesh geometry={geom} material={material} />;
}

function AutoFit() {
  const { camera } = useThree();
  const store = useStore();
  const fitted = useRef(false);

  useMemo(() => {
    if (fitted.current) return;
    const mesh = store.originalMesh;
    const sphereMode = store.sphereMode;
    const sphereRadius = store.sphereRadius;
    let size = 50;
    if (mesh) {
      const p = mesh.positions;
      let maxDist = 0;
      for (let i = 0; i < p.length; i += 3) {
        const d = Math.sqrt(p[i] * p[i] + p[i + 1] * p[i + 1] + p[i + 2] * p[i + 2]);
        if (d > maxDist) maxDist = d;
      }
      size = maxDist;
    } else if (sphereMode) {
      switch (store.sampleShape) {
        case 'cube': size = 15 * 1.73; break;
        case 'cylinder': size = Math.sqrt(15 * 15 + 20 * 20); break;
        case 'torus': size = 28; break;
        case 'capsule': size = Math.sqrt(12 * 12 + 27 * 27); break;
        default: size = sphereRadius; break;
      }
    }
    (camera as THREE.PerspectiveCamera).position.set(size * 2, size * 1.5, size * 2);
    camera.lookAt(0, 0, 0);
    fitted.current = true;
  }, [store.originalMesh, store.sphereMode, store.sphereRadius, store.sampleShape, camera]);

  return null;
}

function DemoTileViewerWithMode({ tile, viewMode, clipPlane }: {
  tile: DemoTileState;
  viewMode: 'original' | 'lattice' | 'cross_section' | 'xray';
  clipPlane: ClipPlaneState;
}) {
  const placeholder = useMemo(() => generateSphereMesh(DEMO_VIEW_TARGET_RADIUS, 20), []);
  const placeholderGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(placeholder.positions, 3));
    g.computeVertexNormals();
    return g;
  }, [placeholder.positions]);

  const showPlaceholder = viewMode === 'original' || !tile.result;
  const tileResult = tile.result;

  return (
    <div className="demo-window">
      <div className="demo-window-label">{tile.label}</div>
      <Canvas camera={{ fov: 58, near: 0.1, far: 10000, position: [22, 16, 22] }} gl={{ localClippingEnabled: true }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[40, 40, 40]} intensity={0.8} />
        {showPlaceholder ? (
          <mesh geometry={placeholderGeom}>
            <meshPhongMaterial color="#6d7ea5" transparent opacity={0.45} side={THREE.DoubleSide} />
          </mesh>
        ) : viewMode === 'cross_section' ? (
          <CrossSectionView result={tileResult as MarchingCubesResult} clip={clipPlane} />
        ) : viewMode === 'xray' ? (
          <XRayView result={tileResult as MarchingCubesResult} />
        ) : (
          <ResultMeshView result={tileResult as MarchingCubesResult} />
        )}
        <OrbitControls makeDefault target={[0, 0, 0]} />
      </Canvas>
      {tile.status !== 'done' && (
        <div className="demo-window-status">{tile.status === 'error' ? (tile.error ?? 'Error') : 'Generating...'}</div>
      )}
    </div>
  );
}

function DemoGridView({ params, runId, viewMode, clipPlane }: {
  params: LatticeParams;
  runId: number;
  viewMode: 'original' | 'lattice' | 'cross_section' | 'xray';
  clipPlane: ClipPlaneState;
}) {
  const [tiles, setTiles] = useState<DemoTileState[]>(() => DEMO_TILE_ITEMS.map((item) => ({ ...item, status: 'pending', result: null })));

  useEffect(() => {
    let cancelled = false;
    const workers: Worker[] = [];
    setTiles(DEMO_TILE_ITEMS.map((item) => ({ ...item, status: 'pending', result: null })));

    const run = async () => {
      await Promise.all(DEMO_TILE_ITEMS.map((item, index) => new Promise<void>((resolve) => {
        if (cancelled) { resolve(); return; }

        const worker = new Worker(new URL('../workers/lattice-worker.ts', import.meta.url), { type: 'module' });
        workers.push(worker);

        const localParams: LatticeParams = {
          ...params,
          latticeType: item.type,
          variant: (item.type === 'hexagon' || item.type === 'triangle') ? 'implicit_conformal' : 'shell_core',
          surfaceOnly: (item.type === 'hexagon' || item.type === 'triangle'),
          noShell: false,
        };

        const msg: WorkerMessage = {
          type: 'generate',
          params: localParams,
          sphereMode: true,
          sampleShape: 'sphere',
          sphereRadius: DEMO_SPHERE_RADIUS_MM,
          resolution: Math.max(38, Math.round(18 + params.exportResolution * 14)),
          keepOutTris: [],
        };

        setTiles((prev) => prev.map((t, i) => (i === index ? { ...t, status: 'running' } : t)));

        worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
          const resp = ev.data;
          if (resp.type === 'result') {
            if (!cancelled) {
              setTiles((prev) => prev.map((t, i) => i === index ? {
                ...t,
                status: 'done',
                result: normalizeDemoResult({ positions: resp.positions!, normals: resp.normals!, triCount: resp.triCount! }),
              } : t));
            }
            worker.terminate();
            resolve();
          } else if (resp.type === 'error') {
            if (!cancelled) {
              setTiles((prev) => prev.map((t, i) => i === index ? { ...t, status: 'error', error: resp.message } : t));
            }
            worker.terminate();
            resolve();
          }
        };

        worker.postMessage(msg);
      })));

    };

    void run();

    return () => {
      cancelled = true;
      for (const w of workers) w.terminate();
    };
  }, [runId, params]);

  return (
    <div className="demo-grid-view" aria-label="Demo lattice windows">
      {tiles.map((tile) => (
        <DemoTileViewerWithMode
          key={tile.type}
          tile={tile}
          viewMode={viewMode}
          clipPlane={clipPlane}
        />
      ))}
    </div>
  );
}

export function Viewer3D() {
  const {
    originalMesh, sphereMode, sphereRadius, sampleShape, viewMode, clipPlane,
    keepOutTris, keepInTris, selectionMode, resultMesh,
    toggleKeepOut, toggleKeepIn, viewerBackground, demoModeActive,
    demoRunId, params,
  } = useStore();

  const handleFaceClick = useCallback((triIdx: number) => {
    if (selectionMode === 'keep_out') toggleKeepOut(triIdx);
    else if (selectionMode === 'keep_in') toggleKeepIn(triIdx);
  }, [selectionMode, toggleKeepOut, toggleKeepIn]);

  const hasContent = originalMesh || sphereMode;

  if (demoModeActive) {
    return (
      <div style={{ width: '100%', height: '100%', background: viewerBackground }}>
        <DemoGridView
          params={params}
          runId={demoRunId}
          viewMode={viewMode}
          clipPlane={clipPlane}
        />
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', background: viewerBackground }}>
      <Canvas camera={{ fov: 50, near: 0.1, far: 10000 }} gl={{ localClippingEnabled: true }}>
        <ambientLight intensity={0.4} />
        <directionalLight position={[50, 50, 50]} intensity={0.8} />
        <directionalLight position={[-30, -20, 40]} intensity={0.3} />

        {hasContent && <AutoFit />}

        {viewMode === 'original' && originalMesh && (
          <OriginalMeshView
            mesh={originalMesh}
            keepOutTris={keepOutTris}
            keepInTris={keepInTris}
            selectionMode={selectionMode}
            onFaceClick={handleFaceClick}
          />
        )}
        {viewMode === 'original' && sphereMode && !originalMesh && sampleShape && (
          <SampleMeshView
            shape={sampleShape}
            radius={sphereRadius}
            keepOutTris={keepOutTris}
            keepInTris={keepInTris}
          />
        )}

        {viewMode === 'lattice' && resultMesh && <ResultMeshView result={resultMesh} />}
        {viewMode === 'cross_section' && resultMesh && <CrossSectionView result={resultMesh} clip={clipPlane} />}
        {viewMode === 'xray' && resultMesh && <XRayView result={resultMesh} />}

        <OrbitControls makeDefault target={[0, 0, 0]} />
        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport labelColor="white" axisHeadScale={1} />
        </GizmoHelper>
      </Canvas>
    </div>
  );
}
