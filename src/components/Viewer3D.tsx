// 3D Viewer component using react-three-fiber
import { useRef, useMemo, useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { Canvas, useThree, useFrame, type ThreeEvent } from '@react-three/fiber';
import { Billboard, GizmoHelper, Line, OrbitControls, Text } from '@react-three/drei';
import * as THREE from 'three';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/useStore';
import type { TriangleMesh } from '../geometry/stl-parser';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { ClipPlaneState, ViewerCameraState, ViewerVector3 } from '../store/useStore';
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

const DEMO_VIEW_TARGET_RADIUS = 8;
const VIEWPORT_PADDING = 1.2;
const WORLD_UP = new THREE.Vector3(0, 0, 1);
const ISO_VIEW_DIRECTION = new THREE.Vector3(1, 1, 1).normalize();
const ISO_VIEW_UP = WORLD_UP.clone().projectOnPlane(ISO_VIEW_DIRECTION).normalize();

const VIEWER_GIZMO_ALIGNMENT = 'bottom-right';
const VIEWER_GIZMO_MARGIN: [number, number] = [112, 112];
const VIEWER_GIZMO_SCALE = 40;
const VIEWER_AXIS_HEAD_RADIUS = 0.26;
const VIEWER_AXIS_LABEL_BADGE_RADIUS = 0.18;
const VIEWER_AXIS_LABEL_BADGE_COLOR = '#07111d';
const VIEWER_AXIS_LABEL_FONT_SIZE = 0.24;
const VIEWER_AXIS_LABEL_FONT_WEIGHT = 800;
const VIEWER_AXIS_LABEL_COLOR = '#ffffff';
const VIEWER_AXIS_LABEL_OUTLINE_COLOR = '#07111d';
const VIEWER_AXIS_LABEL_OUTLINE_WIDTH = 0.028;
const VIEWER_GIZMO_AXIS_LENGTH = 1.75;
const VIEWER_GIZMO_LABEL_DISTANCE = 1.9;
const VIEWER_VIEW_CUBE_SIZE = 1.2;
const VIEWER_VIEW_CUBE_BODY_OPACITY = 1;
const VIEWER_VIEW_CUBE_FACE_OPACITY = 0.62;
const VIEWER_VIEW_CUBE_FACE_HOVER_OPACITY = 0.78;
const VIEWER_VIEW_CUBE_EDGE_COLOR = '#8fb4d8';
const VIEWER_VIEW_CUBE_FACE_LABEL_FONT_SIZE = 0.32;
const VIEWER_VIEW_CUBE_CORNER_RADIUS = 0.082;
const VIEWER_VIEW_CUBE_CORNER_HIT_RADIUS = 0.19;
const VIEWER_VIEW_CUBE_FACE_VISIBILITY_THRESHOLD = 0;
const VIEWER_ISOMETRIC_GIZMO_VIEW = 'iso';

type ViewAxis = 'x' | 'y' | 'z';
type ViewCubeCornerDirection = [number, number, number];
type GizmoViewRequest = ViewAxis | 'iso' | { kind: 'corner'; direction: ViewCubeCornerDirection };
type ViewCubeFaceLabel = 'Front' | 'Back' | 'Right' | 'Left' | 'Top' | 'Bottom';
type GizmoViewTarget = '+x' | '+y' | '+z' | 'front' | 'right' | 'top' | 'iso';
type ViewCubeFaceDirection = ViewCubeCornerDirection;

type ResettableOrbitControls = {
  enabled?: boolean;
  target?: THREE.Vector3;
  update?: () => void;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
  state?: number;
  _sphericalDelta?: { set: (radius: number, phi: number, theta: number) => void };
  _panOffset?: { set: (x: number, y: number, z: number) => void };
  _scale?: number;
  _performCursorZoom?: boolean;
  _dollyDirection?: { set: (x: number, y: number, z: number) => void };
};

type OrbitControlsResetSession = {
  controls: ResettableOrbitControls;
  wasEnabled: boolean | undefined;
};

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
  const point = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 3) {
    box.expandByPoint(point.set(p[i], p[i + 1], p[i + 2]));
  }
  return box;
}

/** Dispose a memoized BufferGeometry when it is replaced or unmounted. */
function useDisposable<T extends { dispose: () => void }>(resource: T): T {
  useEffect(() => () => resource.dispose(), [resource]);
  return resource;
}

function meshBounds(mesh: TriangleMesh): THREE.Box3 {
  const box = new THREE.Box3();
  const p = mesh.positions;
  const point = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 3) {
    box.expandByPoint(point.set(p[i], p[i + 1], p[i + 2]));
  }
  return box;
}

function distanceToFitBoundingSphere(camera: THREE.Camera, radius: number): number {
  if (!(camera instanceof THREE.PerspectiveCamera)) return radius * 4;

  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const verticalDistance = radius / Math.sin(vFov / 2);
  const horizontalDistance = radius / Math.sin(hFov / 2);

  return Math.max(verticalDistance, horizontalDistance) * VIEWPORT_PADDING;
}

function defaultViewerBounds(): THREE.Box3 {
  return new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(50, 50, 50),
  );
}

function activeViewerBounds({
  originalMesh,
  sphereMode,
  sphereRadius,
  sampleShape,
  resultMesh,
  viewMode,
}: {
  originalMesh: TriangleMesh | null;
  sphereMode: boolean;
  sphereRadius: number;
  sampleShape: SampleShape | null;
  resultMesh: MarchingCubesResult | null;
  viewMode: 'original' | 'lattice' | 'cross_section' | 'xray';
}): THREE.Box3 {
  if (viewMode !== 'original' && resultMesh) return resultBounds(resultMesh);
  if (originalMesh) return meshBounds(originalMesh);
  if (sphereMode && sampleShape) return meshBounds(generateSampleMesh(sampleShape, sphereRadius));
  return defaultViewerBounds();
}

function viewerGizmoLayout() {
  const cubeSize = VIEWER_VIEW_CUBE_SIZE;
  const origin: [number, number, number] = [0, 0, 0];
  const contentCenter: [number, number, number] = [
    VIEWER_GIZMO_LABEL_DISTANCE / 2,
    VIEWER_GIZMO_LABEL_DISTANCE / 2,
    VIEWER_GIZMO_LABEL_DISTANCE / 2,
  ];
  return {
    origin,
    cubeMin: [0, 0, 0] as [number, number, number],
    cubeMax: [cubeSize, cubeSize, cubeSize] as [number, number, number],
    cubeCenter: [cubeSize / 2, cubeSize / 2, cubeSize / 2] as [number, number, number],
    contentCenter,
    contentOffset: contentCenter.map((value) => -value) as [number, number, number],
    axisCapPositions: {
      x: [VIEWER_GIZMO_LABEL_DISTANCE, 0, 0] as [number, number, number],
      y: [0, VIEWER_GIZMO_LABEL_DISTANCE, 0] as [number, number, number],
      z: [0, 0, VIEWER_GIZMO_LABEL_DISTANCE] as [number, number, number],
    },
  };
}

function gizmoViewTargetToRequest(target: GizmoViewTarget): GizmoViewRequest {
  if (target === '+x' || target === 'right') return 'x';
  if (target === '+y' || target === 'front') return 'y';
  if (target === '+z' || target === 'top') return 'z';
  return VIEWER_ISOMETRIC_GIZMO_VIEW;
}

function cameraViewForAxis(axis: ViewAxis): { direction: THREE.Vector3; up: THREE.Vector3 } {
  if (axis === 'x') return { direction: new THREE.Vector3(1, 0, 0), up: WORLD_UP.clone() };
  if (axis === 'y') return { direction: new THREE.Vector3(0, 1, 0), up: WORLD_UP.clone() };
  return { direction: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(-1, 0, 0) };
}

function cameraViewForDirection(viewDirection: ViewCubeCornerDirection): { direction: THREE.Vector3; up: THREE.Vector3 } {
  const direction = new THREE.Vector3(...viewDirection).normalize();
  const projectedWorldUp = WORLD_UP.clone().projectOnPlane(direction);
  const up = projectedWorldUp.lengthSq() > 1e-8
    ? projectedWorldUp.normalize()
    : new THREE.Vector3(-1, 0, 0);

  return { direction, up };
}

function isCornerGizmoViewRequest(viewRequest: GizmoViewRequest): viewRequest is { kind: 'corner'; direction: ViewCubeCornerDirection } {
  return typeof viewRequest === 'object' && viewRequest.kind === 'corner';
}

function cameraViewForRequest(viewRequest: GizmoViewRequest): { direction: THREE.Vector3; up: THREE.Vector3 } {
  if (viewRequest === VIEWER_ISOMETRIC_GIZMO_VIEW) {
    return { direction: ISO_VIEW_DIRECTION.clone(), up: ISO_VIEW_UP.clone() };
  }
  if (isCornerGizmoViewRequest(viewRequest)) {
    return cameraViewForDirection(viewRequest.direction);
  }
  return cameraViewForAxis(viewRequest);
}

function prepareOrbitControlsForCameraReset(controls: unknown): OrbitControlsResetSession | null {
  const orbitControls = controls as ResettableOrbitControls | null;
  if (!orbitControls) return null;

  const wasEnabled = orbitControls.enabled;
  orbitControls.enabled = false;
  orbitControls.state = -1;
  orbitControls._sphericalDelta?.set(0, 0, 0);
  orbitControls._panOffset?.set(0, 0, 0);
  orbitControls._scale = 1;
  orbitControls._performCursorZoom = false;
  orbitControls._dollyDirection?.set(0, 0, 0);
  return { controls: orbitControls, wasEnabled };
}

function finishOrbitControlsAfterCameraReset(
  resetSession: OrbitControlsResetSession | null,
  target: THREE.Vector3
): (() => void) | undefined {
  if (!resetSession) return undefined;

  const { controls, wasEnabled } = resetSession;
  controls.target?.copy(target);
  controls.update?.();

  const restoreControls = () => {
    if (wasEnabled !== undefined) controls.enabled = wasEnabled;
    controls.state = -1;
    controls.update?.();
  };

  if (typeof window === 'undefined') {
    restoreControls();
    return undefined;
  }

  const frameId = window.requestAnimationFrame(restoreControls);
  return () => {
    window.cancelAnimationFrame(frameId);
    restoreControls();
  };
}

function vectorToTuple(vector: THREE.Vector3): ViewerVector3 {
  return [vector.x, vector.y, vector.z];
}

function tupleToVector(tuple: ViewerVector3): THREE.Vector3 {
  return new THREE.Vector3(tuple[0], tuple[1], tuple[2]);
}

function isFiniteTuple(tuple: ViewerVector3 | undefined): tuple is ViewerVector3 {
  return Array.isArray(tuple) && tuple.length === 3 && tuple.every((value) => Number.isFinite(value));
}

function isValidViewerCameraState(cameraState: ViewerCameraState | null | undefined): cameraState is ViewerCameraState {
  if (!cameraState) return false;
  if (!isFiniteTuple(cameraState.position) || !isFiniteTuple(cameraState.target) || !isFiniteTuple(cameraState.up)) return false;
  if (!Number.isFinite(cameraState.zoom) || cameraState.zoom <= 0) return false;

  const position = tupleToVector(cameraState.position);
  const target = tupleToVector(cameraState.target);
  const up = tupleToVector(cameraState.up);
  return position.distanceToSquared(target) > 1e-8 && up.lengthSq() > 1e-8;
}

function viewerCameraStateSignature(cameraState: ViewerCameraState | null | undefined) {
  if (!isValidViewerCameraState(cameraState)) return '';
  return [
    ...cameraState.position,
    ...cameraState.target,
    ...cameraState.up,
    cameraState.zoom,
  ].map((value) => value.toFixed(4)).join(':');
}

function captureViewerCameraState(camera: THREE.Camera, controls: unknown): ViewerCameraState | null {
  const orbitControls = controls as ResettableOrbitControls | null;
  const target = orbitControls?.target ?? new THREE.Vector3(0, 0, 0);
  const zoom = camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera ? camera.zoom : 1;

  const cameraState: ViewerCameraState = {
    position: vectorToTuple(camera.position),
    target: vectorToTuple(target),
    up: vectorToTuple(camera.up),
    zoom,
    savedAt: Date.now(),
  };

  return isValidViewerCameraState(cameraState) ? cameraState : null;
}

function applyViewerCameraState(cameraState: ViewerCameraState, camera: THREE.Camera, controls: unknown) {
  const resetSession = prepareOrbitControlsForCameraReset(controls);
  const target = tupleToVector(cameraState.target);

  camera.up.copy(tupleToVector(cameraState.up).normalize());
  camera.position.copy(tupleToVector(cameraState.position));
  camera.lookAt(target);
  camera.updateMatrixWorld();

  if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
    camera.zoom = cameraState.zoom;
    camera.updateProjectionMatrix();
  }

  return finishOrbitControlsAfterCameraReset(resetSession, target);
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
  const geom = useDisposable(useMemo(() => {
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
  }, [mesh, keepOutTris, keepInTris]));

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
  const geom = useDisposable(useMemo(() => {
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
  }, [shape, radius, keepOutTris, keepInTris]));

  return (
    <mesh geometry={geom}>
      <meshPhongMaterial vertexColors side={THREE.DoubleSide} transparent opacity={0.5} />
    </mesh>
  );
}

function ResultMeshView({ result }: { result: MarchingCubesResult }) {
  const geom = useDisposable(useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    g.computeVertexNormals();
    return g;
  }, [result]));

  return (
    <mesh geometry={geom}>
      <meshPhongMaterial color="#4a9eff" side={THREE.DoubleSide} />
    </mesh>
  );
}

function CrossSectionView({ result, clip }: { result: MarchingCubesResult; clip: ClipPlaneState }) {
  const geom = useDisposable(useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    g.computeVertexNormals();
    return g;
  }, [result]));

  const bounds = useMemo(() => resultBounds(result), [result]);
  const plane = useMemo(() => clipStateTo3(clip, bounds), [clip, bounds]);

  return (
    <mesh geometry={geom}>
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
  const geom = useDisposable(useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    g.computeVertexNormals();
    return g;
  }, [result]));

  const material = useDisposable(useMemo(() => new THREE.MeshBasicMaterial({
    color: '#3388cc', side: THREE.DoubleSide, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending,
  }), []));

  return <mesh geometry={geom} material={material} />;
}

function GizmoCameraReset({ view, signal }: { view: GizmoViewRequest | null; signal: number }) {
  const { camera, controls } = useThree();
  const store = useStore(useShallow((s) => ({
    originalMesh: s.originalMesh,
    sphereMode: s.sphereMode,
    sphereRadius: s.sphereRadius,
    sampleShape: s.sampleShape,
    resultMesh: s.resultMesh,
    viewMode: s.viewMode,
  })));

  useEffect(() => {
    if (!view) return;

    const resetSession = prepareOrbitControlsForCameraReset(controls);
    const bounds = activeViewerBounds({
      originalMesh: store.originalMesh,
      sphereMode: store.sphereMode,
      sphereRadius: store.sphereRadius,
      sampleShape: store.sampleShape,
      resultMesh: store.resultMesh,
      viewMode: store.viewMode,
    });
    const center = bounds.getCenter(new THREE.Vector3());
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1);
    const distance = distanceToFitBoundingSphere(camera, radius);
    const cameraView = cameraViewForRequest(view);

    camera.up.copy(cameraView.up);
    camera.position.copy(center).add(cameraView.direction.clone().multiplyScalar(distance));
    camera.lookAt(center);
    camera.updateMatrixWorld();
    if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) camera.updateProjectionMatrix();

    return finishOrbitControlsAfterCameraReset(resetSession, center);
  }, [
    view,
    signal,
    camera,
    controls,
    store.originalMesh,
    store.sphereMode,
    store.sphereRadius,
    store.sampleShape,
    store.resultMesh,
    store.viewMode,
  ]);

  return null;
}

function CleanAxisGizmo({ onSelectView }: { onSelectView: (view: GizmoViewRequest) => void }) {
  const layout = viewerGizmoLayout();

  return (
    <group scale={VIEWER_GIZMO_SCALE}>
      <group position={layout.contentOffset}>
        <PositiveOctantViewCube onSelectView={onSelectView} />
        {GIZMO_AXES.map((axis) => (
          <GizmoAxis key={axis.label} {...axis} onSelectView={onSelectView} />
        ))}
        <IsoOriginButton onSelectView={onSelectView} />
      </group>
    </group>
  );
}

const GIZMO_AXES: Array<{ label: 'X' | 'Y' | 'Z'; color: string; target: GizmoViewTarget; direction: [number, number, number] }> = [
  { label: 'X', color: '#ff4b7d', target: '+x', direction: [1, 0, 0] },
  { label: 'Y', color: '#2ddc94', target: '+y', direction: [0, 1, 0] },
  { label: 'Z', color: '#4da3ff', target: '+z', direction: [0, 0, 1] },
];

function GizmoAxis({
  label,
  color,
  target,
  direction,
  onSelectView,
}: {
  label: 'X' | 'Y' | 'Z';
  color: string;
  target: GizmoViewTarget;
  direction: [number, number, number];
  onSelectView: (view: GizmoViewRequest) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const origin = viewerGizmoLayout().origin;
  const lineEnd = direction.map((value) => value * VIEWER_GIZMO_AXIS_LENGTH) as [number, number, number];
  const capPosition = direction.map((value) => value * VIEWER_GIZMO_LABEL_DISTANCE) as [number, number, number];

  return (
    <group>
      <Line points={[origin, lineEnd]} color={color} lineWidth={hovered ? 4 : 3} transparent opacity={hovered ? 1 : 0.85} depthTest={false} />
      <AxisCap
        label={label}
        color={color}
        position={capPosition}
        target={target}
        hovered={hovered}
        onHoverChange={setHovered}
        onSelectView={onSelectView}
      />
    </group>
  );
}

function AxisCap({
  label,
  color,
  position,
  target,
  hovered,
  onHoverChange,
  onSelectView,
}: {
  label: 'X' | 'Y' | 'Z';
  color: string;
  position: [number, number, number];
  target: GizmoViewTarget;
  hovered: boolean;
  onHoverChange: (hovered: boolean) => void;
  onSelectView: (view: GizmoViewRequest) => void;
}) {
  const title = `View +${label}`;

  return (
    <Billboard
      name={title}
      position={position}
      scale={hovered ? 1.08 : 1}
      userData={{ title, ariaLabel: title }}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
      }}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelectView(gizmoViewTargetToRequest(target));
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        onHoverChange(true);
      }}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        onHoverChange(false);
      }}
    >
      {hovered && (
        <mesh position={[0, 0, -0.002]}>
          <ringGeometry args={[VIEWER_AXIS_HEAD_RADIUS * 1.02, VIEWER_AXIS_HEAD_RADIUS * 1.18, 40]} />
          <meshBasicMaterial color="#f8fbff" depthTest={false} transparent opacity={0.38} toneMapped={false} />
        </mesh>
      )}
      <mesh>
        <ringGeometry args={[VIEWER_AXIS_LABEL_BADGE_RADIUS, VIEWER_AXIS_HEAD_RADIUS, 40]} />
        <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, 0.004]}>
        <circleGeometry args={[VIEWER_AXIS_LABEL_BADGE_RADIUS, 36]} />
        <meshBasicMaterial color={VIEWER_AXIS_LABEL_BADGE_COLOR} depthTest={false} toneMapped={false} />
      </mesh>
      <Text
        anchorX="center"
        anchorY="middle"
        color={VIEWER_AXIS_LABEL_COLOR}
        fontSize={VIEWER_AXIS_LABEL_FONT_SIZE}
        fontWeight={VIEWER_AXIS_LABEL_FONT_WEIGHT}
        letterSpacing={0}
        outlineColor={VIEWER_AXIS_LABEL_OUTLINE_COLOR}
        outlineWidth={VIEWER_AXIS_LABEL_OUTLINE_WIDTH}
        position={[0, 0, 0.01]}
      >
        {label}
      </Text>
      <Text
        anchorX="center"
        anchorY="middle"
        color="#d7e3ee"
        fontSize={0.105}
        letterSpacing={0}
        outlineColor={VIEWER_AXIS_LABEL_OUTLINE_COLOR}
        outlineWidth={0.01}
        position={[0, -0.095, 0.011]}
      >
        +
      </Text>
    </Billboard>
  );
}

function PositiveOctantViewCube({ onSelectView }: { onSelectView: (view: GizmoViewRequest) => void }) {
  const cubeSize = VIEWER_VIEW_CUBE_SIZE;
  const half = VIEWER_VIEW_CUBE_SIZE / 2;
  const faces = useMemo(() => getViewCubeFaceDescriptors(), []);
  const corners = useMemo(() => getViewCubeCornerDescriptors(), []);

  return (
    <group name="Positive-octant triad view cube">
      <mesh position={[half, half, half]} renderOrder={1}>
        <boxGeometry args={[cubeSize, cubeSize, cubeSize]} />
        <meshBasicMaterial color="#1d2b3d" depthTest transparent={false} opacity={VIEWER_VIEW_CUBE_BODY_OPACITY} depthWrite toneMapped={false} />
      </mesh>
      <ViewCubeEdges />
      {faces.map((face) => (
        <ViewCubeFace key={face.label} {...face} onSelectView={onSelectView} />
      ))}
      {corners.map((corner) => (
        <ViewCubeCorner key={corner.title} {...corner} onSelectView={onSelectView} />
      ))}
    </group>
  );
}

interface ViewCubeFaceDescriptor {
  label: ViewCubeFaceLabel;
  position: [number, number, number];
  rotation: [number, number, number];
  normal: [number, number, number];
  direction: ViewCubeFaceDirection;
}

function getViewCubeFaceDescriptors(): ViewCubeFaceDescriptor[] {
  const cubeSize = VIEWER_VIEW_CUBE_SIZE;
  const faceOffset = 0.006;
  const half = VIEWER_VIEW_CUBE_SIZE / 2;
  return [
    { label: 'Front', position: [half, cubeSize + faceOffset, half], rotation: [-Math.PI / 2, 0, -Math.PI], normal: [0, 1, 0], direction: [0, 1, 0] },
    { label: 'Back', position: [half, -faceOffset, half], rotation: [Math.PI / 2, 0, 0], normal: [0, -1, 0], direction: [0, -1, 0] },
    { label: 'Left', position: [cubeSize + faceOffset, half, half], rotation: [Math.PI / 2, Math.PI / 2, 0], normal: [1, 0, 0], direction: [1, 0, 0] },
    { label: 'Right', position: [-faceOffset, half, half], rotation: [Math.PI / 2, -Math.PI / 2, 0], normal: [-1, 0, 0], direction: [-1, 0, 0] },
    { label: 'Top', position: [half, half, cubeSize + faceOffset], rotation: [0, 0, Math.PI / 2], normal: [0, 0, 1], direction: [0, 0, 1] },
    { label: 'Bottom', position: [half, half, -faceOffset], rotation: [-Math.PI, 0, -Math.PI / 2], normal: [0, 0, -1], direction: [0, 0, -1] },
  ];
}

interface ViewCubeCornerDescriptor {
  title: string;
  position: [number, number, number];
  direction: ViewCubeCornerDirection;
}

function getViewCubeCornerDescriptors(): ViewCubeCornerDescriptor[] {
  const cubeSize = VIEWER_VIEW_CUBE_SIZE;
  const signs = [-1, 1] as const;
  const axisTitle = (axis: 'X' | 'Y' | 'Z', sign: -1 | 1) => `${sign > 0 ? '+' : '-'}${axis}`;
  return signs.flatMap((x) =>
    signs.flatMap((y) =>
      signs.map((z) => ({
        title: `View ${axisTitle('X', x)} ${axisTitle('Y', y)} ${axisTitle('Z', z)}`,
        position: [x > 0 ? cubeSize : 0, y > 0 ? cubeSize : 0, z > 0 ? cubeSize : 0] as [number, number, number],
        direction: [x, y, z] as ViewCubeCornerDirection,
      }))
    )
  );
}

function ViewCubeEdges({ active = false }: { active?: boolean }) {
  const cubeSize = VIEWER_VIEW_CUBE_SIZE;
  const edgeInset = 0.004;
  const min = -edgeInset;
  const max = cubeSize + edgeInset;
  const edgeSegments: Array<[[number, number, number], [number, number, number]]> = [
    [[min, min, min], [max, min, min]],
    [[min, max, min], [max, max, min]],
    [[min, min, max], [max, min, max]],
    [[min, max, max], [max, max, max]],
    [[min, min, min], [min, max, min]],
    [[max, min, min], [max, max, min]],
    [[min, min, max], [min, max, max]],
    [[max, min, max], [max, max, max]],
    [[min, min, min], [min, min, max]],
    [[max, min, min], [max, min, max]],
    [[min, max, min], [min, max, max]],
    [[max, max, min], [max, max, max]],
  ];

  return (
    <group renderOrder={2}>
      {edgeSegments.map((segment, index) => (
        <Line
          key={index}
          points={segment}
          color={active ? '#d9ecff' : VIEWER_VIEW_CUBE_EDGE_COLOR}
          lineWidth={active ? 2 : 1}
          transparent
          opacity={active ? 0.82 : 0.56}
          depthTest
        />
      ))}
    </group>
  );
}

function ViewCubeFace({
  label,
  position,
  rotation,
  normal,
  direction,
  onSelectView,
}: ViewCubeFaceDescriptor & {
  onSelectView: (view: GizmoViewRequest) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { camera } = useThree();
  const faceRef = useRef<THREE.Group | null>(null);
  const labelRef = useRef<THREE.Group | null>(null);
  const localNormal = useMemo(() => new THREE.Vector3(...normal), [normal]);
  const faceNormalWorldRef = useRef(new THREE.Vector3());
  const toCameraWorldRef = useRef(new THREE.Vector3());
  const normalMatrixRef = useRef(new THREE.Matrix3());
  const title = `${label} view`;
  useFrame(() => {
    const labelObject = labelRef.current;
    const cubeRootObject = faceRef.current?.parent;
    if (!labelObject || !cubeRootObject) return;
    const faceNormalWorld = faceNormalWorldRef.current.copy(localNormal).applyNormalMatrix(normalMatrixRef.current.getNormalMatrix(cubeRootObject.matrixWorld)).normalize();
    const toCameraWorld = camera.getWorldDirection(toCameraWorldRef.current).negate().normalize();
    labelObject.visible = shouldShowViewCubeFaceLabel(faceNormalWorld, toCameraWorld);
  });

  return (
    <group
      ref={faceRef}
      name={title}
      position={position}
      rotation={rotation}
      userData={{ title, ariaLabel: title }}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
      }}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelectView({ kind: 'corner', direction });
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(false);
      }}
    >
      <mesh renderOrder={3}>
        <planeGeometry args={[VIEWER_VIEW_CUBE_SIZE * 0.82, VIEWER_VIEW_CUBE_SIZE * 0.82]} />
        <meshBasicMaterial color={hovered ? '#6da4c9' : '#31516b'} depthTest transparent opacity={hovered ? VIEWER_VIEW_CUBE_FACE_HOVER_OPACITY : VIEWER_VIEW_CUBE_FACE_OPACITY} depthWrite={false} toneMapped={false} />
      </mesh>
      <group ref={labelRef} position={[0, 0, 0.075]} renderOrder={4}>
        <GizmoTextLabel
          color={hovered ? '#ffffff' : '#e4eef8'}
          fontSize={VIEWER_VIEW_CUBE_FACE_LABEL_FONT_SIZE}
          opacity={hovered ? 1 : 0.95}
          depthTest
        >
          {label}
        </GizmoTextLabel>
      </group>
    </group>
  );
}

function ViewCubeCorner({
  title,
  position,
  direction,
  onSelectView,
}: ViewCubeCornerDescriptor & {
  onSelectView: (view: GizmoViewRequest) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <Billboard
      name={title}
      position={position}
      scale={hovered ? 1.22 : 1}
      userData={{ title, ariaLabel: title }}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
      }}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelectView({ kind: 'corner', direction });
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(false);
      }}
    >
      <mesh renderOrder={3}>
        <sphereGeometry args={[VIEWER_VIEW_CUBE_CORNER_HIT_RADIUS, 18, 18]} />
        <meshBasicMaterial color="#ffffff" depthTest={false} transparent opacity={0} toneMapped={false} />
      </mesh>
      <mesh renderOrder={5}>
        <sphereGeometry args={[VIEWER_VIEW_CUBE_CORNER_RADIUS, 18, 18]} />
        <meshBasicMaterial color={hovered ? '#f8fbff' : '#a9c9e8'} depthTest={false} transparent opacity={hovered ? 0.96 : 0.78} toneMapped={false} />
      </mesh>
      {hovered && (
        <mesh renderOrder={4}>
          <sphereGeometry args={[VIEWER_VIEW_CUBE_CORNER_RADIUS * 1.7, 18, 18]} />
          <meshBasicMaterial color="#f8fbff" depthTest={false} transparent opacity={0.22} toneMapped={false} />
        </mesh>
      )}
    </Billboard>
  );
}

function IsoOriginButton({ onSelectView }: { onSelectView: (view: GizmoViewRequest) => void }) {
  const [hovered, setHovered] = useState(false);
  const half = VIEWER_VIEW_CUBE_SIZE / 2;

  return (
    <Billboard
      name="Isometric view"
      position={[half, half, half]}
      userData={{ title: 'Isometric view', ariaLabel: 'Isometric view' }}
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
      }}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        onSelectView(gizmoViewTargetToRequest('iso'));
      }}
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(event: ThreeEvent<PointerEvent>) => {
        event.stopPropagation();
        setHovered(false);
      }}
    >
      {hovered && (
        <mesh>
          <ringGeometry args={[0.075, 0.105, 28]} />
          <meshBasicMaterial color="#f8fbff" depthTest={false} transparent opacity={0.42} toneMapped={false} />
        </mesh>
      )}
      <mesh>
        <sphereGeometry args={[0.065, 18, 18]} />
        <meshBasicMaterial color="#d9e8f6" depthTest={false} toneMapped={false} />
      </mesh>
      {hovered && (
        <GizmoTextLabel color="#f8fbff" fontSize={0.095} position={[0, -0.16, 0.01]}>
          Iso
        </GizmoTextLabel>
      )}
    </Billboard>
  );
}

function GizmoTextLabel({
  children,
  color,
  fontSize,
  depthTest = false,
  opacity = 1,
  position = [0, 0, 0.01],
}: {
  children: string;
  color: string;
  fontSize: number;
  depthTest?: boolean;
  opacity?: number;
  position?: [number, number, number];
}) {
  return (
    <Text
      anchorX="center"
      anchorY="middle"
      color={color}
      fillOpacity={opacity}
      fontSize={fontSize}
      frustumCulled={false}
      letterSpacing={0}
      material-depthTest={depthTest}
      material-side={THREE.DoubleSide}
      material-toneMapped={false}
      outlineColor="#07111d"
      outlineOpacity={opacity}
      outlineWidth={0.014}
      position={position}
      renderOrder={5}
    >
      {children}
    </Text>
  );
}

function shouldShowViewCubeFaceLabel(
  faceNormalWorld: THREE.Vector3,
  toCameraWorld: THREE.Vector3,
  threshold = VIEWER_VIEW_CUBE_FACE_VISIBILITY_THRESHOLD
) {
  return faceNormalWorld.clone().normalize().dot(toCameraWorld.clone().normalize()) > threshold;
}

function AutoFit() {
  const { camera, controls, size: canvasSize } = useThree();
  const store = useStore(useShallow((s) => ({
    originalMesh: s.originalMesh,
    sphereMode: s.sphereMode,
    sphereRadius: s.sphereRadius,
    sampleShape: s.sampleShape,
    viewportResetSignal: s.viewportResetSignal,
  })));

  useEffect(() => {
    const resetSession = prepareOrbitControlsForCameraReset(controls);
    const mesh = store.originalMesh;
    let bounds = new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(50, 50, 50),
    );

    if (mesh) {
      bounds = meshBounds(mesh);
    } else if (store.sphereMode && store.sampleShape) {
      bounds = meshBounds(generateSampleMesh(store.sampleShape, store.sphereRadius));
    }

    const center = bounds.getCenter(new THREE.Vector3());
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1);
    const distance = distanceToFitBoundingSphere(camera, radius);

    camera.up.copy(ISO_VIEW_UP);
    camera.position.copy(center).add(ISO_VIEW_DIRECTION.clone().multiplyScalar(distance));
    camera.lookAt(center);
    camera.updateProjectionMatrix();

    return finishOrbitControlsAfterCameraReset(resetSession, center);
  }, [
    store.originalMesh,
    store.sphereMode,
    store.sphereRadius,
    store.sampleShape,
    store.viewportResetSignal,
    camera,
    controls,
    canvasSize.width,
    canvasSize.height,
  ]);

  return null;
}

function ViewerCameraSession() {
  const { camera, controls } = useThree();
  const {
    viewerCameraState,
    setViewerCameraState,
    originalMesh,
    sphereMode,
    sphereRadius,
    sampleShape,
    resultMesh,
    viewMode,
    viewportResetSignal,
  } = useStore(useShallow((s) => ({
    viewerCameraState: s.viewerCameraState,
    setViewerCameraState: s.setViewerCameraState,
    originalMesh: s.originalMesh,
    sphereMode: s.sphereMode,
    sphereRadius: s.sphereRadius,
    sampleShape: s.sampleShape,
    resultMesh: s.resultMesh,
    viewMode: s.viewMode,
    viewportResetSignal: s.viewportResetSignal,
  })));
  const restoredSignatureRef = useRef<string>('');
  const applyingPersistedCameraRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  useEffect(() => {
    if (!isValidViewerCameraState(viewerCameraState)) return;

    const signature = viewerCameraStateSignature(viewerCameraState);
    if (signature === restoredSignatureRef.current) return;

    const bounds = activeViewerBounds({
      originalMesh,
      sphereMode,
      sphereRadius,
      sampleShape,
      resultMesh,
      viewMode,
    });
    if (bounds.isEmpty()) return;

    applyingPersistedCameraRef.current = true;
    restoredSignatureRef.current = signature;
    const cleanup = applyViewerCameraState(viewerCameraState, camera, controls);

    if (typeof window === 'undefined') {
      applyingPersistedCameraRef.current = false;
      return cleanup;
    }

    const frameId = window.requestAnimationFrame(() => {
      applyingPersistedCameraRef.current = false;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      applyingPersistedCameraRef.current = false;
      cleanup?.();
    };
  }, [
    viewerCameraState,
    camera,
    controls,
    originalMesh,
    sphereMode,
    sphereRadius,
    sampleShape,
    resultMesh,
    viewMode,
  ]);

  useEffect(() => {
    const orbitControls = controls as ResettableOrbitControls | null;
    if (!orbitControls?.addEventListener || !orbitControls.removeEventListener) return undefined;

    const saveCameraState = () => {
      if (applyingPersistedCameraRef.current || typeof window === 'undefined') return;

      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        if (applyingPersistedCameraRef.current) return;

        const nextCameraState = captureViewerCameraState(camera, controls);
        if (!nextCameraState) return;

        const nextSignature = viewerCameraStateSignature(nextCameraState);
        restoredSignatureRef.current = nextSignature;
        setViewerCameraState(nextCameraState);
      }, 200);
    };

    orbitControls.addEventListener('change', saveCameraState);
    return () => {
      orbitControls.removeEventListener?.('change', saveCameraState);
      if (saveTimerRef.current && typeof window !== 'undefined') {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [camera, controls, setViewerCameraState, viewportResetSignal]);

  return null;
}

function DemoTileViewerWithMode({ tile, viewMode, clipPlane, selectedLatticeType, onSelectLatticeType }: {
  tile: DemoTileState;
  viewMode: 'original' | 'lattice' | 'cross_section' | 'xray';
  clipPlane: ClipPlaneState;
  selectedLatticeType: LatticeType;
  onSelectLatticeType: (type: LatticeType) => void;
}) {
  const placeholder = useMemo(() => generateSphereMesh(DEMO_VIEW_TARGET_RADIUS, 20), []);
  const placeholderGeom = useDisposable(useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(placeholder.positions, 3));
    g.computeVertexNormals();
    return g;
  }, [placeholder.positions]));

  const showPlaceholder = viewMode === 'original' || !tile.result;
  const tileResult = tile.result;

  const isSelected = tile.type === selectedLatticeType;
  const handleSelect = useCallback(() => {
    onSelectLatticeType(tile.type);
  }, [onSelectLatticeType, tile.type]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectLatticeType(tile.type);
    }
  }, [onSelectLatticeType, tile.type]);

  return (
    <div
      className={`demo-window ${isSelected ? 'demo-window-selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`Select ${tile.label} lattice type`}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
    >
      <div className="demo-window-label">{tile.label}</div>
      <Canvas
        camera={{ fov: 58, near: 0.1, far: 10000, position: [22, -22, 16], up: [0, 0, 1] }}
        gl={{ localClippingEnabled: true }}
      >
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

function DemoGridView({ params, demoParamsByType, runId, viewMode, clipPlane, selectedLatticeType, onSelectLatticeType, sourceMesh, sphereMode, sphereRadius, sampleShape, keepOutTris }: {
  params: LatticeParams;
  demoParamsByType: Partial<Record<LatticeType, LatticeParams>>;
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
}) {
  const [tiles, setTiles] = useState<DemoTileState[]>(() => DEMO_TILE_ITEMS.map((item) => ({ ...item, status: 'pending', result: null })));
  const workersRef = useRef<Map<LatticeType, Worker>>(new Map());
  const tokensRef = useRef<Partial<Record<LatticeType, number>>>({});
  const completedSigRef = useRef<Partial<Record<LatticeType, string>>>({});
  const runningSigRef = useRef<Partial<Record<LatticeType, string>>>({});
  const hasCompletedInitialFullRun = useRef(false);
  const latestParamsRef = useRef(params);
  const latestDemoParamsRef = useRef(demoParamsByType);
  const keepOutKey = useMemo(() => Array.from(keepOutTris).sort((a, b) => a - b).join(','), [keepOutTris]);
  const sourceKey = useMemo(() => {
    if (sourceMesh) return `mesh:${sourceMesh.triCount}:${sourceMesh.positions.length}:${sourceMesh.normals.length}`;
    return `shape:${sampleShape ?? 'none'}:${sphereMode ? 1 : 0}:${sphereRadius}`;
  }, [sampleShape, sourceMesh, sphereMode, sphereRadius]);

  useEffect(() => {
    latestParamsRef.current = params;
  }, [params]);

  useEffect(() => {
    latestDemoParamsRef.current = demoParamsByType;
  }, [demoParamsByType]);

  const stopTileWorker = useCallback((type: LatticeType) => {
    const existing = workersRef.current.get(type);
    if (existing) {
      existing.terminate();
      workersRef.current.delete(type);
      runningSigRef.current[type] = undefined;
    }
  }, []);

  const buildTileSignature = useCallback((type: LatticeType, localParams: LatticeParams) => {
    return JSON.stringify({
      type,
      source: sourceKey,
      keepOut: keepOutKey,
      params: localParams,
    });
  }, [keepOutKey, sourceKey]);

  const generateTiles = useCallback((types: LatticeType[], baseParams: LatticeParams, force = false) => {
    for (const type of types) {
      const savedParams = latestDemoParamsRef.current[type];
      const localParams: LatticeParams = savedParams ? { ...savedParams, latticeType: type } : {
        ...baseParams,
        latticeType: type,
        variant: (type === 'hexagon' || type === 'triangle') ? 'implicit_conformal' : 'shell_core',
        surfaceOnly: (type === 'hexagon' || type === 'triangle'),
        noShell: false,
      };
      const signature = buildTileSignature(type, localParams);

      if (!force) {
        if (runningSigRef.current[type] === signature) continue;
        if (completedSigRef.current[type] === signature) continue;
      }

      stopTileWorker(type);
      const token = (tokensRef.current[type] ?? 0) + 1;
      tokensRef.current[type] = token;

      const worker = new Worker(new URL('../workers/lattice-worker.ts', import.meta.url), { type: 'module' });
      workersRef.current.set(type, worker);
      runningSigRef.current[type] = signature;

      const msg: WorkerMessage = {
        type: 'generate',
        params: localParams,
        sphereMode,
        sampleShape,
        sphereRadius,
        resolution: Math.round(24 + localParams.exportResolution * 24),
        keepOutTris: Array.from(keepOutTris),
      };

      if (sourceMesh) {
        msg.meshPositions = sourceMesh.positions;
        msg.meshNormals = sourceMesh.normals;
        msg.meshTriCount = sourceMesh.triCount;
      }

      setTiles((prev) => prev.map((t) => (t.type === type ? { ...t, status: 'running', error: undefined } : t)));

      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        if (tokensRef.current[type] !== token) return;
        const resp = ev.data;
        if (resp.type === 'result') {
          runningSigRef.current[type] = undefined;
          completedSigRef.current[type] = signature;
          setTiles((prev) => prev.map((t) => t.type === type ? {
            ...t,
            status: 'done',
            result: normalizeDemoResult({ positions: resp.positions!, normals: resp.normals!, triCount: resp.triCount! }),
            error: undefined,
          } : t));
          worker.terminate();
          workersRef.current.delete(type);
        } else if (resp.type === 'error') {
          runningSigRef.current[type] = undefined;
          setTiles((prev) => prev.map((t) => t.type === type ? { ...t, status: 'error', error: resp.message } : t));
          worker.terminate();
          workersRef.current.delete(type);
        }
      };

      worker.postMessage(msg);
    }
  }, [buildTileSignature, keepOutTris, sampleShape, sourceMesh, sphereMode, sphereRadius, stopTileWorker]);

  useEffect(() => {
    const allTypes = DEMO_TILE_ITEMS.map((item) => item.type);
    let cancelled = false;

    if (!sourceMesh && !sphereMode) {
      for (const type of allTypes) stopTileWorker(type);
      queueMicrotask(() => {
        if (cancelled) return;
        setTiles(DEMO_TILE_ITEMS.map((item) => ({
          ...item,
          status: 'error',
          result: null,
          error: 'Import or select a sample model',
        })));
      });
      hasCompletedInitialFullRun.current = false;
      return () => { cancelled = true; };
    }

    completedSigRef.current = {};
    runningSigRef.current = {};
    queueMicrotask(() => {
      if (cancelled) return;
      setTiles(DEMO_TILE_ITEMS.map((item) => ({ ...item, status: 'pending', result: null, error: undefined })));
      generateTiles(allTypes, latestParamsRef.current, true);
    });
    hasCompletedInitialFullRun.current = true;

    return () => {
      cancelled = true;
      for (const type of allTypes) stopTileWorker(type);
    };
  }, [runId, sourceMesh, sphereMode, sphereRadius, sampleShape, keepOutTris, stopTileWorker, generateTiles]);

  useEffect(() => {
    if (!hasCompletedInitialFullRun.current) return;
    if (!sourceMesh && !sphereMode) return;
    queueMicrotask(() => {
      generateTiles([selectedLatticeType], params, false);
    });
  }, [params, selectedLatticeType, sourceMesh, sphereMode, generateTiles]);

  useEffect(() => () => {
    for (const worker of workersRef.current.values()) worker.terminate();
    workersRef.current.clear();
  }, []);

  return (
    <div className="demo-grid-view" aria-label="Demo lattice windows">
      {tiles.map((tile) => (
        <DemoTileViewerWithMode
          key={tile.type}
          tile={tile}
          viewMode={viewMode}
          clipPlane={clipPlane}
          selectedLatticeType={selectedLatticeType}
          onSelectLatticeType={onSelectLatticeType}
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
    demoRunId, params, demoParamsByType, setLatticeType, viewportResetSignal,
  } = useStore(useShallow((s) => ({
    originalMesh: s.originalMesh,
    sphereMode: s.sphereMode,
    sphereRadius: s.sphereRadius,
    sampleShape: s.sampleShape,
    viewMode: s.viewMode,
    clipPlane: s.clipPlane,
    keepOutTris: s.keepOutTris,
    keepInTris: s.keepInTris,
    selectionMode: s.selectionMode,
    resultMesh: s.resultMesh,
    toggleKeepOut: s.toggleKeepOut,
    toggleKeepIn: s.toggleKeepIn,
    viewerBackground: s.viewerBackground,
    demoModeActive: s.demoModeActive,
    demoRunId: s.demoRunId,
    params: s.params,
    demoParamsByType: s.demoParamsByType,
    setLatticeType: s.setLatticeType,
    viewportResetSignal: s.viewportResetSignal,
  })));
  const [gizmoViewRequest, setGizmoViewRequest] = useState<{ view: GizmoViewRequest | null; signal: number }>({ view: null, signal: 0 });

  const handleFaceClick = useCallback((triIdx: number) => {
    if (selectionMode === 'keep_out') toggleKeepOut(triIdx);
    else if (selectionMode === 'keep_in') toggleKeepIn(triIdx);
  }, [selectionMode, toggleKeepOut, toggleKeepIn]);

  if (demoModeActive) {
    return (
      <div style={{ width: '100%', height: '100%', background: viewerBackground }}>
        <DemoGridView
          key={viewportResetSignal}
          params={params}
          demoParamsByType={demoParamsByType}
          runId={demoRunId}
          viewMode={viewMode}
          clipPlane={clipPlane}
          selectedLatticeType={params.latticeType}
          onSelectLatticeType={setLatticeType}
          sourceMesh={originalMesh}
          sphereMode={sphereMode}
          sphereRadius={sphereRadius}
          sampleShape={sampleShape}
          keepOutTris={keepOutTris}
        />
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: viewerBackground }}>
      <Canvas
        camera={{ fov: 50, near: 0.1, far: 10000, up: [0, 0, 1] }}
        gl={{ localClippingEnabled: true }}
        onCreated={({ camera }) => {
          camera.up.set(0, 0, 1);
        }}
      >
        <ambientLight intensity={0.4} />
        <directionalLight position={[50, 50, 50]} intensity={0.8} />
        <directionalLight position={[-30, -20, 40]} intensity={0.3} />

        <AutoFit />
        <GizmoCameraReset view={gizmoViewRequest.view} signal={gizmoViewRequest.signal} />

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
        <ViewerCameraSession />
        <GizmoHelper alignment={VIEWER_GIZMO_ALIGNMENT} margin={VIEWER_GIZMO_MARGIN}>
          <CleanAxisGizmo
            onSelectView={(view) => setGizmoViewRequest((request) => ({ view, signal: request.signal + 1 }))}
          />
        </GizmoHelper>
      </Canvas>
    </div>
  );
}
