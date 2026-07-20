import { analyzeMesh } from '../geometry/mesh-analysis';
import { exportBinarySTL, parseSTL, type TriangleMesh } from '../geometry/stl-parser';
import {
  DEFAULT_PARAMS,
  sanitizeLatticeParams,
  type LatticeParams,
  type MeshInfo,
  type SampleShape,
  type ValidationResult,
} from '../types/project';
import type { ClipPlaneState } from '../store/useStore';

const PROJECT_SCHEMA = 'openlattice3d-project';
const PROJECT_VERSION = 2;
const SAMPLE_SHAPES: readonly SampleShape[] = ['sphere', 'cube', 'cylinder', 'torus', 'capsule'];

export type ProjectSource =
  | { kind: 'mesh'; fileName: string; mesh: TriangleMesh }
  | { kind: 'sample'; fileName: string; shape: SampleShape; sphereRadius: number };

export interface ProjectExportInput {
  params: LatticeParams;
  source: ProjectSource;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
  validation: ValidationResult | null;
  clipPlane: ClipPlaneState;
  viewerBackground: string;
}

export interface RestoredProjectFile {
  kind: 'project';
  params: LatticeParams;
  originalMesh: TriangleMesh | null;
  meshInfo: MeshInfo | null;
  meshFileName: string;
  sampleShape: SampleShape | null;
  sphereRadius: number;
  keepOutTris: number[];
  keepInTris: number[];
  clipPlane?: ClipPlaneState;
  viewerBackground?: string;
  warnings: string[];
}

export interface ParameterImportFile {
  kind: 'parameters';
  params: Partial<LatticeParams>;
  accepted: (keyof LatticeParams)[];
  warnings: string[];
}

export type ParsedProjectFile = RestoredProjectFile | ParameterImportFile;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** FNV-1a fingerprint of triangle count and exact Float32 position bytes. */
export function meshFingerprint(mesh: TriangleMesh): string {
  let hash = 2166136261;
  const update = (value: number) => {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  };
  update(mesh.triCount & 0xff);
  update((mesh.triCount >>> 8) & 0xff);
  update((mesh.triCount >>> 16) & 0xff);
  update((mesh.triCount >>> 24) & 0xff);
  const bytes = new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength);
  for (let i = 0; i < bytes.length; i++) update(bytes[i]);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function createProjectFile(input: ProjectExportInput): Record<string, unknown> {
  const source = input.source.kind === 'mesh'
    ? (() => {
      const stl = exportBinarySTL(input.source.mesh.positions, input.source.mesh.normals, input.source.mesh.triCount);
      return {
        kind: 'mesh',
        fileName: input.source.fileName,
        fingerprint: meshFingerprint(input.source.mesh),
        encoding: 'base64-binary-stl',
        data: bytesToBase64(new Uint8Array(stl)),
      };
    })()
    : {
      kind: 'sample',
      fileName: input.source.fileName,
      shape: input.source.shape,
      sphereRadius: input.source.sphereRadius,
    };

  return {
    schema: PROJECT_SCHEMA,
    version: PROJECT_VERSION,
    createdAt: new Date().toISOString(),
    units: 'millimeter',
    source,
    parameters: input.params,
    selectionMask: {
      meshFingerprint: input.source.kind === 'mesh' ? meshFingerprint(input.source.mesh) : null,
      keepOut: Array.from(input.keepOutTris),
      keepIn: Array.from(input.keepInTris),
    },
    viewer: {
      clipPlane: input.clipPlane,
      background: input.viewerBackground,
    },
    validationAtExport: input.validation,
  };
}

function validIndices(value: unknown, upperBound: number): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(
    (index): index is number => Number.isInteger(index) && index >= 0 && index < upperBound,
  )));
}

function parseClipPlane(value: unknown): ClipPlaneState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<ClipPlaneState>;
  if (!['x', 'y', 'z'].includes(candidate.axis ?? '')) return undefined;
  if (typeof candidate.position !== 'number' || !Number.isFinite(candidate.position)) return undefined;
  if (typeof candidate.flipped !== 'boolean') return undefined;
  return {
    axis: candidate.axis!,
    position: Math.max(0, Math.min(1, candidate.position)),
    flipped: candidate.flipped,
  };
}

export function parseProjectFile(data: unknown): ParsedProjectFile {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Project JSON must contain an object');
  }
  const root = data as Record<string, unknown>;
  const parameterSource = 'parameters' in root ? root.parameters : root;
  const sanitized = sanitizeLatticeParams(parameterSource);
  const warnings = sanitized.rejected.length > 0
    ? [`Ignored invalid parameter value(s): ${sanitized.rejected.join(', ')}`]
    : [];

  if (root.schema !== PROJECT_SCHEMA || root.version !== PROJECT_VERSION) {
    return { kind: 'parameters', params: sanitized.params, accepted: sanitized.accepted, warnings };
  }
  if (sanitized.accepted.length === 0) throw new Error('Project contains no valid lattice parameters');
  if (root.units !== 'millimeter') throw new Error(`Unsupported project units: ${String(root.units)}`);

  const source = root.source as Record<string, unknown> | null;
  if (!source || typeof source !== 'object') throw new Error('Project source is missing');
  const params: LatticeParams = { ...DEFAULT_PARAMS, ...sanitized.params };
  const selection = typeof root.selectionMask === 'object' && root.selectionMask !== null
    ? root.selectionMask as Record<string, unknown>
    : {};
  const viewer = typeof root.viewer === 'object' && root.viewer !== null
    ? root.viewer as Record<string, unknown>
    : {};

  if (source.kind === 'mesh') {
    if (source.encoding !== 'base64-binary-stl' || typeof source.data !== 'string') {
      throw new Error('Embedded mesh is missing or uses an unsupported encoding');
    }
    const bytes = base64ToBytes(source.data);
    const meshBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(meshBuffer).set(bytes);
    const mesh = parseSTL(meshBuffer);
    const fingerprint = meshFingerprint(mesh);
    const expected = typeof source.fingerprint === 'string' ? source.fingerprint : null;
    const selectionFingerprint = typeof selection.meshFingerprint === 'string' ? selection.meshFingerprint : null;
    const masksMatch = expected === fingerprint && selectionFingerprint === fingerprint;
    if (!masksMatch) warnings.push('Selection masks were discarded because the embedded mesh fingerprint did not match');
    return {
      kind: 'project',
      params,
      originalMesh: mesh,
      meshInfo: analyzeMesh(mesh),
      meshFileName: typeof source.fileName === 'string' ? source.fileName : 'restored-model.stl',
      sampleShape: null,
      sphereRadius: 25,
      keepOutTris: masksMatch ? validIndices(selection.keepOut, mesh.triCount) : [],
      keepInTris: masksMatch ? validIndices(selection.keepIn, mesh.triCount) : [],
      clipPlane: parseClipPlane(viewer.clipPlane),
      viewerBackground: typeof viewer.background === 'string' ? viewer.background : undefined,
      warnings,
    };
  }

  if (source.kind === 'sample' && SAMPLE_SHAPES.includes(source.shape as SampleShape)) {
    return {
      kind: 'project',
      params,
      originalMesh: null,
      meshInfo: null,
      meshFileName: typeof source.fileName === 'string' ? source.fileName : String(source.shape),
      sampleShape: source.shape as SampleShape,
      sphereRadius: typeof source.sphereRadius === 'number' && Number.isFinite(source.sphereRadius)
        ? source.sphereRadius
        : 25,
      keepOutTris: [],
      keepInTris: [],
      clipPlane: parseClipPlane(viewer.clipPlane),
      viewerBackground: typeof viewer.background === 'string' ? viewer.background : undefined,
      warnings,
    };
  }

  throw new Error('Project source type is unsupported');
}
