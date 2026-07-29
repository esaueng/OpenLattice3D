/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
import { computeTriangleCentroids, facesWithinBrush } from '../../geometry/constraint-painting';
import {
  generateCylinderDisplayMesh,
  perspectiveProjectedRadiusPx,
  radialSegmentsForProjectedRadius,
  sampleCircularEdge,
} from '../../geometry/display-tessellation';

const SAMPLE_CYLINDER_RADIUS_MM = 15;
const SAMPLE_CYLINDER_HEIGHT_MM = 40;
const SAMPLE_CYLINDER_EDGE_CENTERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, SAMPLE_CYLINDER_HEIGHT_MM / 2],
  [0, 0, -SAMPLE_CYLINDER_HEIGHT_MM / 2],
];
const PROCEDURAL_EDGE_COLOR = '#101820';

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

export function generateSampleMesh(
  shape: SampleShape,
  radius: number,
  radialSegments?: number,
  minorSegments?: number,
): TriangleMesh {
  switch (shape) {
    case 'sphere': return generateSphereMesh(radius, radialSegments ?? 32);
    case 'cube': return generateCubeMesh(30);
    case 'cylinder': return generateCylinderMesh(SAMPLE_CYLINDER_RADIUS_MM, SAMPLE_CYLINDER_HEIGHT_MM, 32);
    case 'torus': return generateTorusMesh(20, 8, radialSegments ?? 32, minorSegments ?? 16);
    case 'capsule': return generateCapsuleMesh(12, 30, radialSegments ?? 24);
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
  const radialSegments = useAdaptiveRadialSegments(
    params.escapeHoleDiameter / 2,
    preview?.centers,
  );

  if (!preview) return null;
  return (
    <group>
      {preview.centers.map((center, index) => (
        <mesh key={index} position={center} rotation={preview.rotation} renderOrder={5}>
          <cylinderGeometry
            args={[
              params.escapeHoleDiameter / 2,
              params.escapeHoleDiameter / 2,
              preview.length,
              radialSegments,
            ]}
          />
          <meshBasicMaterial color="#ff9f43" transparent opacity={0.42} depthWrite={false} wireframe />
        </mesh>
      ))}
    </group>
  );
}

const FACE_COLOR_DEFAULT: [number, number, number] = [0.7, 0.7, 0.75];
const FACE_COLOR_KEEP_OUT: [number, number, number] = [0.2, 0.6, 1];
const FACE_COLOR_KEEP_IN: [number, number, number] = [1, 0.4, 0.2];

function projectedRadiusPixels(
  camera: THREE.Camera,
  viewportHeightPx: number,
  radiusWorld: number,
  centers: ReadonlyArray<readonly [number, number, number]> = [[0, 0, 0]],
): number {
  if (camera instanceof THREE.PerspectiveCamera) {
    let largestProjectedRadius = 0;
    for (const center of centers) {
      const centerDistance = Math.hypot(
        camera.position.x - center[0],
        camera.position.y - center[1],
        camera.position.z - center[2],
      );
      // A circle's nearest point can be one radius closer than its center.
      const conservativeDistance = Math.max(camera.near, centerDistance - radiusWorld);
      largestProjectedRadius = Math.max(
        largestProjectedRadius,
        perspectiveProjectedRadiusPx(
          radiusWorld,
          conservativeDistance,
          THREE.MathUtils.degToRad(camera.getEffectiveFOV()),
          viewportHeightPx,
        ),
      );
    }
    return largestProjectedRadius;
  }
  if (camera instanceof THREE.OrthographicCamera) {
    const viewHeight = (camera.top - camera.bottom) / camera.zoom;
    return viewHeight > 0 ? radiusWorld * viewportHeightPx / viewHeight : 0;
  }
  return 0;
}

function useAdaptiveRadialSegments(
  radiusWorld: number,
  centers?: ReadonlyArray<readonly [number, number, number]>,
): number {
  const { camera, size } = useThree();
  const initialSegments = radialSegmentsForProjectedRadius(
    projectedRadiusPixels(camera, size.height, radiusWorld, centers),
  );
  const [segments, setSegments] = useState(initialSegments);
  const segmentsRef = useRef(initialSegments);

  useFrame(() => {
    const nextSegments = radialSegmentsForProjectedRadius(
      projectedRadiusPixels(camera, size.height, radiusWorld, centers),
    );
    if (nextSegments === segmentsRef.current) return;
    segmentsRef.current = nextSegments;
    setSegments(nextSegments);
  });

  return segments;
}

function faceColors(
  triCount: number,
  keepOutTris: Set<number>,
  keepInTris: Set<number>,
): Float32Array {
  const colors = new Float32Array(triCount * 9);
  for (let triangle = 0; triangle < triCount; triangle++) {
    const color = keepInTris.has(triangle)
      ? FACE_COLOR_KEEP_IN
      : keepOutTris.has(triangle) ? FACE_COLOR_KEEP_OUT : FACE_COLOR_DEFAULT;
    for (let vertex = 0; vertex < 3; vertex++) {
      const offset = triangle * 9 + vertex * 3;
      colors[offset] = color[0];
      colors[offset + 1] = color[1];
      colors[offset + 2] = color[2];
    }
  }
  return colors;
}

function CylinderSampleView({
  keepOutTris,
  keepInTris,
}: {
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
}) {
  const radialSegments = useAdaptiveRadialSegments(
    SAMPLE_CYLINDER_RADIUS_MM,
    SAMPLE_CYLINDER_EDGE_CENTERS,
  );
  const displayMesh = useMemo(
    () => generateCylinderDisplayMesh(
      SAMPLE_CYLINDER_RADIUS_MM,
      SAMPLE_CYLINDER_HEIGHT_MM,
      radialSegments,
    ),
    [radialSegments],
  );
  const surfaceGeometry = useDisposable(useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(displayMesh.positions, 3));
    next.setAttribute('normal', new THREE.BufferAttribute(displayMesh.normals, 3));
    next.setAttribute(
      'color',
      new THREE.BufferAttribute(faceColors(displayMesh.triCount, keepOutTris, keepInTris), 3),
    );
    return next;
  }, [displayMesh, keepInTris, keepOutTris]));
  const halfHeight = SAMPLE_CYLINDER_HEIGHT_MM / 2;
  const topEdgeGeometry = useDisposable(useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute(
      'position',
      new THREE.BufferAttribute(
        sampleCircularEdge(SAMPLE_CYLINDER_RADIUS_MM, halfHeight, radialSegments),
        3,
      ),
    );
    return next;
  }, [halfHeight, radialSegments]));
  const bottomEdgeGeometry = useDisposable(useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute(
      'position',
      new THREE.BufferAttribute(
        sampleCircularEdge(SAMPLE_CYLINDER_RADIUS_MM, -halfHeight, radialSegments),
        3,
      ),
    );
    return next;
  }, [halfHeight, radialSegments]));
  const edgeMaterial = useDisposable(useMemo(() => new THREE.LineBasicMaterial({
    color: PROCEDURAL_EDGE_COLOR,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: 0.92,
  }), []));
  const topEdge = useMemo(
    () => new THREE.LineLoop(topEdgeGeometry, edgeMaterial),
    [edgeMaterial, topEdgeGeometry],
  );
  const bottomEdge = useMemo(
    () => new THREE.LineLoop(bottomEdgeGeometry, edgeMaterial),
    [bottomEdgeGeometry, edgeMaterial],
  );

  return (
    <group>
      <mesh geometry={surfaceGeometry}>
        <meshPhongMaterial
          vertexColors
          side={THREE.DoubleSide}
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
      <primitive object={topEdge} renderOrder={2} />
      <primitive object={bottomEdge} renderOrder={2} />
    </group>
  );
}

export function OriginalMeshView({
  mesh,
  keepOutTris,
  keepInTris,
  selectionMode,
  brushRadius,
  onPaint,
  onStrokeStart,
  onStrokeEnd,
  onPaintingChange,
}: {
  mesh: TriangleMesh;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
  selectionMode: string;
  brushRadius: number;
  onPaint: (triIndices: number[], additive: boolean) => void;
  onStrokeStart: () => void;
  onStrokeEnd: () => void;
  onPaintingChange: (painting: boolean) => void;
}) {
  const paintingRef = useRef(false);
  const geometry = useDisposable(useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    next.setAttribute('color', new THREE.BufferAttribute(new Float32Array(mesh.positions.length), 3));
    next.computeVertexNormals();
    return next;
  }, [mesh]));
  const centroids = useMemo(() => computeTriangleCentroids(mesh), [mesh]);

  useEffect(() => {
    const attribute = geometry.getAttribute('color') as THREE.BufferAttribute;
    const colors = attribute.array as Float32Array;
    for (let triangle = 0; triangle < mesh.triCount; triangle++) {
      const color = keepOutTris.has(triangle)
        ? FACE_COLOR_KEEP_OUT
        : keepInTris.has(triangle) ? FACE_COLOR_KEEP_IN : FACE_COLOR_DEFAULT;
      for (let vertex = 0; vertex < 3; vertex++) {
        colors[triangle * 9 + vertex * 3] = color[0];
        colors[triangle * 9 + vertex * 3 + 1] = color[1];
        colors[triangle * 9 + vertex * 3 + 2] = color[2];
      }
    }
    attribute.needsUpdate = true;
  }, [geometry, keepInTris, keepOutTris, mesh.triCount]);

  const paintAt = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (event.faceIndex == null) return;
    const faces = facesWithinBrush(
      mesh,
      centroids,
      [event.point.x, event.point.y, event.point.z],
      event.faceIndex,
      brushRadius,
    );
    onPaint(faces, !event.altKey);
  }, [brushRadius, centroids, mesh, onPaint]);

  const handlePointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (selectionMode === 'none') return;
    event.stopPropagation();
    paintingRef.current = true;
    onStrokeStart();
    onPaintingChange(true);
    paintAt(event);
  }, [onPaintingChange, onStrokeStart, paintAt, selectionMode]);

  const handlePointerMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (!paintingRef.current) return;
    event.stopPropagation();
    paintAt(event);
  }, [paintAt]);

  useEffect(() => {
    const stopPainting = () => {
      if (!paintingRef.current) return;
      paintingRef.current = false;
      onStrokeEnd();
      onPaintingChange(false);
    };
    window.addEventListener('pointerup', stopPainting);
    window.addEventListener('pointercancel', stopPainting);
    return () => {
      window.removeEventListener('pointerup', stopPainting);
      window.removeEventListener('pointercancel', stopPainting);
    };
  }, [onPaintingChange, onStrokeEnd]);

  return (
    <mesh geometry={geometry} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}>
      <meshPhongMaterial vertexColors side={THREE.DoubleSide} />
    </mesh>
  );
}

function GenericSampleMeshView({ shape, radius, keepOutTris, keepInTris }: {
  shape: SampleShape;
  radius: number;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
}) {
  const projectedRadius = shape === 'torus' ? 28 : shape === 'capsule' ? 12 : radius;
  const radialSegments = Math.min(useAdaptiveRadialSegments(projectedRadius), 128);
  const minorSegments = Math.min(
    useAdaptiveRadialSegments(shape === 'torus' ? 8 : projectedRadius),
    64,
  );
  const geometry = useDisposable(useMemo(() => {
    const mesh = generateSampleMesh(shape, radius, radialSegments, minorSegments);
    const next = new THREE.BufferGeometry();
    next.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    next.setAttribute(
      'color',
      new THREE.BufferAttribute(faceColors(mesh.triCount, keepOutTris, keepInTris), 3),
    );
    if (shape === 'cube') {
      next.computeVertexNormals();
      return next;
    }
    const smoothed = mergeVertices(next);
    smoothed.computeVertexNormals();
    return smoothed;
  }, [keepInTris, keepOutTris, minorSegments, radialSegments, radius, shape]));

  return (
    <mesh geometry={geometry}>
      <meshPhongMaterial vertexColors side={THREE.DoubleSide} />
    </mesh>
  );
}

export function SampleMeshView(props: {
  shape: SampleShape;
  radius: number;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
}) {
  if (props.shape === 'cylinder') {
    return <CylinderSampleView keepOutTris={props.keepOutTris} keepInTris={props.keepInTris} />;
  }
  return <GenericSampleMeshView {...props} />;
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
