// 3D Viewer component using react-three-fiber
import { useRef, useMemo, useCallback, useEffect } from 'react';
import { Canvas, useThree, useFrame, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../store/useStore';
import type { TriangleMesh } from '../geometry/stl-parser';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { ClipPlaneState } from '../store/useStore';
import { generateSphereMesh, generateCubeMesh, generateCylinderMesh, generateTorusMesh, generateCapsuleMesh } from '../geometry/mesh-analysis';
import type { SampleShape } from '../types/project';

// ── Helpers ──────────────────────────────────────────────

const DEMO_TILE_LABELS = [
  'Gyroid', 'Schwarz P', 'Schwarz D', 'Neovius',
  'IWP', 'BCC', 'Octet', 'Diamond',
  'Hexagon', 'Triangle', 'Voronoi', 'Spinodal',
];

/** Compute world-space bounding box from a result mesh */
function resultBounds(result: MarchingCubesResult): THREE.Box3 {
  const box = new THREE.Box3();
  const p = result.positions;
  for (let i = 0; i < p.length; i += 3) {
    box.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
  }
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

// ── Sub-components ───────────────────────────────────────

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
    if (e.faceIndex != null) {
      onFaceClick(e.faceIndex as number);
    }
  }, [selectionMode, onFaceClick]);

  return (
    <mesh geometry={geom} onClick={handleClick}>
      <meshPhongMaterial vertexColors side={THREE.DoubleSide} />
    </mesh>
  );
}

function generateSampleMesh(shape: SampleShape, radius: number) {
  switch (shape) {
    case 'sphere':   return generateSphereMesh(radius, 32);
    case 'cube':     return generateCubeMesh(30);
    case 'cylinder': return generateCylinderMesh(15, 40, 32);
    case 'torus':    return generateTorusMesh(20, 8, 32, 16);
    case 'capsule':  return generateCapsuleMesh(12, 30, 24);
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

/** Solid lattice result – no clipping */
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

/** Cross-section view: result mesh clipped by a plane so the interior lattice is visible. */
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

  // Enable local clipping on the renderer
  useEffect(() => {
    gl.localClippingEnabled = true;
    return () => { gl.localClippingEnabled = false; };
  }, [gl]);

  // Update clipping planes on materials every frame (reactive to slider changes)
  useFrame(() => {
    const p = clipStateTo3(clip, bounds);
    if (meshRef.current) {
      const mat = meshRef.current.material as THREE.MeshPhongMaterial;
      mat.clippingPlanes = [p];
    }
  });

  return (
    <mesh ref={meshRef} geometry={geom}>
      <meshPhongMaterial
        color="#4a9eff"
        side={THREE.DoubleSide}
        clippingPlanes={[plane]}
        clipShadows
      />
    </mesh>
  );
}

/** X-ray view: transparent mesh revealing internal lattice structure.
 *  Uses additive blending with a single draw call for performance.
 *  Additive blending naturally accumulates brightness where many surfaces
 *  overlap (dense lattice interior) while keeping single-layer areas faint.
 */
function XRayView({ result }: { result: MarchingCubesResult }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    g.computeVertexNormals();
    return g;
  }, [result]);

  const material = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial({
      color: '#3388cc',
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return mat;
  }, []);

  return (
    <mesh geometry={geom} material={material} />
  );
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
      // Estimate bounding size based on sample shape
      switch (store.sampleShape) {
        case 'cube':     size = 15 * 1.73; break; // half-diagonal of 30mm cube
        case 'cylinder': size = Math.sqrt(15*15 + 20*20); break;
        case 'torus':    size = 28; break; // 20+8
        case 'capsule':  size = Math.sqrt(12*12 + 27*27); break; // R=12, hh+r = 15+12
        default:         size = sphereRadius; break;
      }
    }
    (camera as THREE.PerspectiveCamera).position.set(size * 2, size * 1.5, size * 2);
    camera.lookAt(0, 0, 0);
    fitted.current = true;
  }, [store.originalMesh, store.sphereMode, store.sphereRadius, store.sampleShape, camera]);

  return null;
}

// ── Main Viewer ──────────────────────────────────────────

export function Viewer3D() {
  const {
    originalMesh, sphereMode, sphereRadius, sampleShape, viewMode, clipPlane,
    keepOutTris, keepInTris, selectionMode, resultMesh,
    toggleKeepOut, toggleKeepIn, viewerBackground, demoModeActive,
  } = useStore();

  const handleFaceClick = useCallback((triIdx: number) => {
    if (selectionMode === 'keep_out') {
      toggleKeepOut(triIdx);
    } else if (selectionMode === 'keep_in') {
      toggleKeepIn(triIdx);
    }
  }, [selectionMode, toggleKeepOut, toggleKeepIn]);

  const hasContent = originalMesh || sphereMode;

  return (
    <div style={{ width: '100%', height: '100%', background: viewerBackground }}>
      <Canvas camera={{ fov: 50, near: 0.1, far: 10000 }} gl={{ localClippingEnabled: true }}>
        <ambientLight intensity={0.4} />
        <directionalLight position={[50, 50, 50]} intensity={0.8} />
        <directionalLight position={[-30, -20, 40]} intensity={0.3} />

        {hasContent && <AutoFit />}

        {/* Original mesh */}
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

        {/* Solid lattice (opaque) */}
        {viewMode === 'lattice' && resultMesh && (
          <ResultMeshView result={resultMesh} />
        )}

        {/* Cross-section: clip plane reveals internal lattice */}
        {viewMode === 'cross_section' && resultMesh && (
          <CrossSectionView result={resultMesh} clip={clipPlane} />
        )}

        {/* X-ray: transparent shell, solid interior */}
        {viewMode === 'xray' && resultMesh && (
          <XRayView result={resultMesh} />
        )}

        <OrbitControls makeDefault />
        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport labelColor="white" axisHeadScale={1} />
        </GizmoHelper>
      </Canvas>
      {demoModeActive && resultMesh && viewMode !== 'original' && (
        <div className="demo-tile-overlay" aria-label="Demo lattice tile labels">
          {DEMO_TILE_LABELS.map((label) => (
            <div key={label} className="demo-tile-label">{label}</div>
          ))}
        </div>
      )}
    </div>
  );
}
