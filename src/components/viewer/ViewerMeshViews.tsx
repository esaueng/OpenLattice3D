/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { TriangleMesh } from '../../geometry/stl-parser';
import type { MarchingCubesResult } from '../../geometry/marching-cubes';
import type { ClipPlaneState } from '../../store/useStore';
import type { LatticeParams, SampleShape } from '../../types/project';
import {
  generateCapsuleMesh,
  generateCubeMesh,
  generateCylinderMesh,
  generateSphereMesh,
  generateTorusMesh,
} from '../../geometry/mesh-analysis';
import { escapeHoleCenters, shouldApplyEscapeHoles } from '../../geometry/escape-holes';

export function resultBounds(result: MarchingCubesResult): THREE.Box3 {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let i = 0; i < result.positions.length; i += 3) {
    box.expandByPoint(point.set(result.positions[i], result.positions[i + 1], result.positions[i + 2]));
  }
  return box;
}

export function meshBounds(mesh: TriangleMesh): THREE.Box3 {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let i = 0; i < mesh.positions.length; i += 3) {
    box.expandByPoint(point.set(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
  }
  return box;
}

export function useDisposable<T extends { dispose: () => void }>(resource: T): T {
  useEffect(() => () => resource.dispose(), [resource]);
  return resource;
}

export function generateSampleMesh(shape: SampleShape, radius: number): TriangleMesh {
  switch (shape) {
    case 'sphere': return generateSphereMesh(radius, 32);
    case 'cube': return generateCubeMesh(30);
    case 'cylinder': return generateCylinderMesh(15, 40, 32);
    case 'torus': return generateTorusMesh(20, 8, 32, 16);
    case 'capsule': return generateCapsuleMesh(12, 30, 24);
  }
}

export function EscapeHolePreview({ bounds, params }: { bounds: THREE.Box3; params: LatticeParams }) {
  const preview = useMemo(() => {
    if (bounds.isEmpty() || !shouldApplyEscapeHoles(params)) return null;
    const modelBounds = {
      min: [bounds.min.x, bounds.min.y, bounds.min.z] as [number, number, number],
      max: [bounds.max.x, bounds.max.y, bounds.max.z] as [number, number, number],
    };
    const centers = escapeHoleCenters(modelBounds, params.escapeHoleAxis, params.escapeHoleCount);
    const length = params.escapeHoleAxis === 'x'
      ? bounds.max.x - bounds.min.x
      : params.escapeHoleAxis === 'y'
        ? bounds.max.y - bounds.min.y
        : bounds.max.z - bounds.min.z;
    const rotation: [number, number, number] = params.escapeHoleAxis === 'x'
      ? [0, 0, -Math.PI / 2]
      : params.escapeHoleAxis === 'z'
        ? [Math.PI / 2, 0, 0]
        : [0, 0, 0];
    return { centers, length: length + params.escapeHoleDiameter, rotation };
  }, [bounds, params]);

  if (!preview) return null;
  return (
    <group>
      {preview.centers.map((center, index) => (
        <mesh key={index} position={center} rotation={preview.rotation} renderOrder={5}>
          <cylinderGeometry args={[params.escapeHoleDiameter / 2, params.escapeHoleDiameter / 2, preview.length, 32]} />
          <meshBasicMaterial color="#ff9f43" transparent opacity={0.42} depthWrite={false} wireframe />
        </mesh>
      ))}
    </group>
  );
}

export function OriginalMeshView({ mesh, keepOutTris, keepInTris, selectionMode, onFaceClick }: {
  mesh: TriangleMesh;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
  selectionMode: string;
  onFaceClick: (triIdx: number) => void;
}) {
  const geometry = useDisposable(useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    const colors = new Float32Array(mesh.positions.length);
    for (let triangle = 0; triangle < mesh.triCount; triangle++) {
      let red = 0.7;
      let green = 0.7;
      let blue = 0.75;
      if (keepOutTris.has(triangle)) { red = 0.2; green = 0.6; blue = 1; }
      if (keepInTris.has(triangle)) { red = 1; green = 0.4; blue = 0.2; }
      for (let vertex = 0; vertex < 3; vertex++) {
        colors[triangle * 9 + vertex * 3] = red;
        colors[triangle * 9 + vertex * 3 + 1] = green;
        colors[triangle * 9 + vertex * 3 + 2] = blue;
      }
    }
    next.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    next.computeVertexNormals();
    return next;
  }, [keepInTris, keepOutTris, mesh]));

  const handleClick = useCallback((event: ThreeEvent<MouseEvent>) => {
    if (selectionMode === 'none') return;
    event.stopPropagation();
    if (event.faceIndex != null) onFaceClick(event.faceIndex);
  }, [onFaceClick, selectionMode]);

  return (
    <mesh geometry={geometry} onClick={handleClick}>
      <meshPhongMaterial vertexColors side={THREE.DoubleSide} />
    </mesh>
  );
}

export function SampleMeshView({ shape, radius, keepOutTris, keepInTris }: {
  shape: SampleShape;
  radius: number;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
}) {
  const geometry = useDisposable(useMemo(() => {
    const mesh = generateSampleMesh(shape, radius);
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    const colors = new Float32Array(mesh.positions.length);
    for (let triangle = 0; triangle < mesh.triCount; triangle++) {
      let red = 0.7;
      let green = 0.7;
      let blue = 0.75;
      if (keepOutTris.has(triangle)) { red = 0.2; green = 0.6; blue = 1; }
      if (keepInTris.has(triangle)) { red = 1; green = 0.4; blue = 0.2; }
      for (let vertex = 0; vertex < 3; vertex++) {
        colors[triangle * 9 + vertex * 3] = red;
        colors[triangle * 9 + vertex * 3 + 1] = green;
        colors[triangle * 9 + vertex * 3 + 2] = blue;
      }
    }
    next.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    next.computeVertexNormals();
    return next;
  }, [keepInTris, keepOutTris, radius, shape]));

  return (
    <mesh geometry={geometry}>
      <meshPhongMaterial vertexColors side={THREE.DoubleSide} transparent opacity={0.5} />
    </mesh>
  );
}

export function ResultMeshView({ result }: { result: MarchingCubesResult }) {
  const geometry = useDisposable(useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    next.computeVertexNormals();
    return next;
  }, [result]));
  return <mesh geometry={geometry}><meshPhongMaterial color="#4a9eff" side={THREE.DoubleSide} /></mesh>;
}

function clipPlane(clip: ClipPlaneState, bounds: THREE.Box3): THREE.Plane {
  const normal = new THREE.Vector3(
    clip.axis === 'x' ? 1 : 0,
    clip.axis === 'y' ? 1 : 0,
    clip.axis === 'z' ? 1 : 0,
  );
  if (!clip.flipped) normal.negate();
  const axisIndex = 'xyz'.indexOf(clip.axis);
  const min = bounds.min.getComponent(axisIndex);
  const max = bounds.max.getComponent(axisIndex);
  const worldPosition = min + clip.position * (max - min);
  return new THREE.Plane(normal, clip.flipped ? -worldPosition : worldPosition);
}

export function CrossSectionView({ result, clip }: { result: MarchingCubesResult; clip: ClipPlaneState }) {
  const geometry = useDisposable(useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    next.computeVertexNormals();
    return next;
  }, [result]));
  const bounds = useMemo(() => resultBounds(result), [result]);
  const plane = useMemo(() => clipPlane(clip, bounds), [bounds, clip]);
  return (
    <mesh geometry={geometry}>
      <meshPhongMaterial color="#4a9eff" side={THREE.DoubleSide} clippingPlanes={[plane]} clipShadows />
    </mesh>
  );
}

export function XRayView({ result }: { result: MarchingCubesResult }) {
  const geometry = useDisposable(useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    next.computeVertexNormals();
    return next;
  }, [result]));
  const material = useDisposable(useMemo(() => new THREE.MeshBasicMaterial({
    color: '#3388cc',
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }), []));
  return <mesh geometry={geometry} material={material} />;
}

export function normalizeDemoResult(result: MarchingCubesResult, targetRadius: number): MarchingCubesResult {
  const bounds = resultBounds(result);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const halfMaxExtent = Math.max(size.x, size.y, size.z) * 0.5;
  if (!Number.isFinite(halfMaxExtent) || halfMaxExtent <= 1e-6) return result;
  const scale = targetRadius / halfMaxExtent;
  const positions = new Float32Array(result.positions.length);
  for (let i = 0; i < result.positions.length; i += 3) {
    positions[i] = (result.positions[i] - center.x) * scale;
    positions[i + 1] = (result.positions[i + 1] - center.y) * scale;
    positions[i + 2] = (result.positions[i + 2] - center.z) * scale;
  }
  return { positions, normals: result.normals, triCount: result.triCount };
}
