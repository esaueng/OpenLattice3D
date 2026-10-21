import { parseSTL, type TriangleMesh } from '../geometry/stl-parser';
import { assertFileSizeWithinBudget, DEFAULT_IMPORT_LIMITS } from '../geometry/mesh-limits';
import { alignNormalsToWinding, analyzeMesh, computeSignedVolume, countNormalWindingAgreement, flipMeshOrientation, repairMesh } from '../geometry/mesh-analysis';
import { parseProjectFile, type ParsedProjectFile } from '../utils/project-file';
import { describeMeshCondition, formatDimensions, modelExtents } from '../utils/model-summary';
import type { ImportNotice, LogEntry } from '../store/useStore';
import type { MeshInfo } from '../types/project';

export type IntakeKind = 'stl' | 'json';
export interface StlIntake {
  kind: 'stl';
  mesh: TriangleMesh;
  info: MeshInfo;
  notice: ImportNotice;
  logs: Pick<LogEntry, 'message' | 'level'>[];
}
export type ModelIntake = StlIntake | { kind: 'json'; parsed: ParsedProjectFile };
export interface IntakeRequest { kind: IntakeKind; file: File }

/** The same import preparation as the UI used, without touching application state. */
export function prepareStl(buffer: ArrayBuffer, fileName: string): StlIntake {
  let mesh = parseSTL(buffer);
  let info = analyzeMesh(mesh);
  const logs: StlIntake['logs'] = [];
  const log = (message: string, level: LogEntry['level'] = 'info') => logs.push({ message, level });
  log(`Loaded: ${info.triangleCount} triangles, ${info.vertexCount} vertices`);
  log(`Bounding box: [${info.boundingBox.min.map(v => v.toFixed(1))}] to [${info.boundingBox.max.map(v => v.toFixed(1))}]`);
  if (info.isWatertight) {
    const signedVolume = computeSignedVolume(mesh);
    if (signedVolume < 0) {
      mesh = flipMeshOrientation(mesh);
      log(`Inverted winding detected (signed volume ${signedVolume.toFixed(1)}mm3). Flipped mesh orientation.`, 'warn');
    }
    const agreement = countNormalWindingAgreement(mesh);
    const compared = agreement.agree + agreement.disagree;
    if (compared > 0 && agreement.disagree > agreement.agree) {
      mesh = alignNormalsToWinding(mesh);
      log(`Stored normals disagreed with winding on ${agreement.disagree}/${compared} faces. Recomputed normals.`, 'warn');
    }
    log(`Volume: ${Math.abs(signedVolume).toFixed(1)}mm3`);
  } else {
    log('Mesh is not closed - skipped orientation check', 'warn');
  }
  const extents = modelExtents(info, null, 25)!;
  const dims = formatDimensions(extents.size);
  const largest = Math.max(...extents.size);
  // STL has no units; retain the existing explicit scale prompt, never rescale.
  const scalePrompt = largest > 0 && (largest < 5 || largest > 1000);
  let notice: ImportNotice;
  if (!info.isManifold || !info.isWatertight) {
    const repaired = repairMesh(mesh);
    mesh = repaired.mesh;
    info = { ...info, repaired: repaired.repaired };
    const condition = describeMeshCondition(info);
    log(condition.message, 'warn');
    notice = { level: 'warn', message: `Imported ${fileName} (${dims}), but it is not closed.`, detail: condition.message, scalePrompt };
  } else {
    log('Mesh is closed and manifold');
    notice = {
      level: scalePrompt ? 'warn' : 'info',
      message: scalePrompt
        ? `Imported ${fileName} at ${dims}. STL files carry no units; is that right?`
        : `Imported ${fileName}: ${info.triangleCount.toLocaleString()} triangles, ${dims}.`,
      scalePrompt,
    };
  }
  return { kind: 'stl', mesh, info, logs, notice };
}

/** Preflight again inside the worker before reading or allocating file contents. */
export async function readModelFile({ kind, file }: IntakeRequest): Promise<ModelIntake> {
  if (kind === 'stl') {
    assertFileSizeWithinBudget(file.size, DEFAULT_IMPORT_LIMITS.maxStlBytes, `STL file ${file.name}`);
    return prepareStl(await file.arrayBuffer(), file.name);
  }
  assertFileSizeWithinBudget(file.size, DEFAULT_IMPORT_LIMITS.maxProjectBytes, `Project file ${file.name}`);
  const data: unknown = JSON.parse(await file.text());
  return { kind: 'json', parsed: parseProjectFile(data) };
}

/** Only newly parsed worker-owned buffers leave the worker; no live model is sent. */
export function intakeTransfers(result: ModelIntake): ArrayBuffer[] {
  const mesh = result.kind === 'stl' ? result.mesh : result.parsed.kind === 'project' ? result.parsed.originalMesh : null;
  return mesh ? [...new Set([mesh.positions.buffer as ArrayBuffer, mesh.normals.buffer as ArrayBuffer])] : [];
}
