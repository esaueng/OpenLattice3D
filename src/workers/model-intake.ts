import { parseSTL, type TriangleMesh } from '../geometry/stl-parser';
import { parse3MF } from '../geometry/three-mf-parser';
import { parseOBJ } from '../geometry/obj-parser';
import { hasZipSignature } from '../geometry/zip-reader';
import { assertFileSizeWithinBudget, DEFAULT_IMPORT_LIMITS, MESH_FORMAT_LABEL, meshFileByteBudget, type MeshFileFormat } from '../geometry/mesh-limits';
import { alignNormalsToWinding, analyzeMesh, computeSignedVolume, countNormalWindingAgreement, flipMeshOrientation, repairMesh } from '../geometry/mesh-analysis';
import { parseProjectFile, type ParsedProjectFile } from '../utils/project-file';
import { describeMeshCondition, formatDimensions, modelExtents } from '../utils/model-summary';
import type { ImportNotice, LogEntry } from '../store/useStore';
import type { MeshInfo } from '../types/project';

export type IntakeKind = MeshFileFormat | 'json';

export interface MeshIntake {
  kind: 'mesh';
  /** The format actually parsed (content sniffing can override the extension). */
  format: MeshFileFormat;
  mesh: TriangleMesh;
  info: MeshInfo;
  notice: ImportNotice;
  logs: Pick<LogEntry, 'message' | 'level'>[];
}
export type ModelIntake = MeshIntake | { kind: 'json'; parsed: ParsedProjectFile };
export interface IntakeRequest { kind: IntakeKind; file: File }

/** How the parsed coordinates relate to millimetres. */
export type MeshUnits =
  /** The format has no unit (STL, OBJ): coordinates as written, ask if implausible. */
  | { kind: 'unitless' }
  /** A unit was declared and coordinates were converted explicitly. */
  | { kind: 'declared'; unit: string; scaleToMm: number }
  /** The format defines a default (3MF: millimeter) but the file did not declare one. */
  | { kind: 'default-mm' };

export interface ParsedMeshSource {
  format: MeshFileFormat;
  mesh: TriangleMesh;
  units: MeshUnits;
  /** Parser observations, logged as warnings. */
  warnings?: string[];
  /** Parser facts, logged as info. */
  notes?: string[];
}

const UNIT_NAMES: Record<string, string> = {
  micron: 'microns', millimeter: 'millimetres', centimeter: 'centimetres', inch: 'inches', foot: 'feet', meter: 'metres',
};

/**
 * Which parser to use: the extension proposes, the content decides when it is
 * unambiguous. A ZIP signature (`PK\x03\x04`) can only be a 3MF package here.
 */
export function detectMeshFormat(bytes: Uint8Array, byExtension: MeshFileFormat): MeshFileFormat {
  return hasZipSignature(bytes) ? '3mf' : byExtension;
}

/** The same import preparation as the UI used, without touching application state. */
export function prepareMesh(source: ParsedMeshSource, fileName: string): MeshIntake {
  const { format, units } = source;
  const label = MESH_FORMAT_LABEL[format];
  let mesh = source.mesh;
  let info = analyzeMesh(mesh);
  const logs: MeshIntake['logs'] = [];
  const log = (message: string, level: LogEntry['level'] = 'info') => logs.push({ message, level });
  for (const note of source.notes ?? []) log(note);
  for (const warning of source.warnings ?? []) log(warning, 'warn');
  let conversion: string | undefined;
  if (units.kind === 'declared' && units.scaleToMm !== 1) {
    conversion = `converted from ${UNIT_NAMES[units.unit] ?? units.unit}`;
    log(`${label} declares unit "${units.unit}": converted coordinates to millimetres (×${units.scaleToMm}).`);
  } else if (units.kind === 'declared') {
    log(`${label} declares unit "${units.unit}"; no conversion needed.`);
  } else if (units.kind === 'default-mm') {
    log(`${label} declares no unit; millimetres assumed (the ${label} default).`, 'warn');
  }
  log(`Loaded: ${info.triangleCount} triangles, ${info.vertexCount} vertices`);
  log(`Bounding box: [${info.boundingBox.min.map(v => v.toFixed(1))}] to [${info.boundingBox.max.map(v => v.toFixed(1))}]`);
  if (info.isWatertight) {
    const signedVolume = computeSignedVolume(mesh);
    if (signedVolume < 0) {
      mesh = flipMeshOrientation(mesh);
      log(`Inverted winding detected (signed volume ${signedVolume.toFixed(1)}mm3). Flipped mesh orientation.`, 'warn');
    }
    // Winding (made outward above) is authoritative. Any stored normal that
    // disagrees with it, even a minority, is replaced so that downstream
    // consumers of per-face normals (surface sampling, display) see the same
    // orientation the signed distance uses.
    const agreement = countNormalWindingAgreement(mesh);
    const compared = agreement.agree + agreement.disagree;
    if (compared > 0 && agreement.disagree > 0) {
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
  // A declared unit was converted explicitly, so there is nothing to ask.
  // Otherwise retain the explicit scale prompt; never rescale on a guess.
  const scalePrompt = units.kind !== 'declared' && largest > 0 && (largest < 5 || largest > 1000);
  const unitQuestion = units.kind === 'default-mm'
    ? `This ${label} declares no unit, so millimetres were assumed; is that right?`
    : `${label} files carry no units; is that right?`;
  let notice: ImportNotice;
  if (!info.isManifold || !info.isWatertight) {
    const repaired = repairMesh(mesh);
    mesh = repaired.mesh;
    info = { ...info, repaired: repaired.repaired };
    const condition = describeMeshCondition(info);
    log(condition.message, 'warn');
    const detail = conversion ? `${condition.message} Coordinates were ${conversion} to millimetres.` : condition.message;
    notice = { level: 'warn', message: `Imported ${fileName} (${dims}), but it is not closed.`, detail, scalePrompt };
  } else {
    log('Mesh is closed and manifold');
    notice = {
      level: scalePrompt ? 'warn' : 'info',
      message: scalePrompt
        ? `Imported ${fileName} at ${dims}. ${unitQuestion}`
        : `Imported ${fileName}: ${info.triangleCount.toLocaleString()} triangles, ${dims}${conversion ? ` (${conversion})` : ''}.`,
      scalePrompt,
    };
  }
  return { kind: 'mesh', format, mesh, info, logs, notice };
}

/** STL preparation (kept for callers that only deal in STL). */
export function prepareStl(buffer: ArrayBuffer, fileName: string): MeshIntake {
  return prepareMesh({ format: 'stl', mesh: parseSTL(buffer), units: { kind: 'unitless' } }, fileName);
}

/** Parse mesh bytes of any supported format into a prepared intake. */
export async function prepareMeshFile(buffer: ArrayBuffer, fileName: string, byExtension: MeshFileFormat): Promise<MeshIntake> {
  const bytes = new Uint8Array(buffer);
  const format = detectMeshFormat(bytes, byExtension);
  const notes: string[] = [];
  if (format !== byExtension) notes.push(`${fileName} is a ZIP package; reading it as 3MF.`);
  if (format === 'stl') return prepareMesh({ format, mesh: parseSTL(buffer), units: { kind: 'unitless' }, notes }, fileName);
  if (format === 'obj') {
    const parsed = parseOBJ(bytes);
    return prepareMesh({ format, mesh: parsed.mesh, units: { kind: 'unitless' }, warnings: parsed.warnings, notes }, fileName);
  }
  const parsed = await parse3MF(bytes);
  notes.push(`3MF build: merged ${parsed.buildItems} build item(s) into one mesh.`);
  return prepareMesh({
    format,
    mesh: parsed.mesh,
    units: parsed.declaredUnit === null ? { kind: 'default-mm' } : { kind: 'declared', unit: parsed.declaredUnit, scaleToMm: parsed.scaleToMm },
    warnings: parsed.warnings,
    notes,
  }, fileName);
}

/** Preflight again inside the worker before reading or allocating file contents. */
export async function readModelFile({ kind, file }: IntakeRequest): Promise<ModelIntake> {
  if (kind !== 'json') {
    assertFileSizeWithinBudget(file.size, meshFileByteBudget(kind), `${MESH_FORMAT_LABEL[kind]} file ${file.name}`);
    return prepareMeshFile(await file.arrayBuffer(), file.name, kind);
  }
  assertFileSizeWithinBudget(file.size, DEFAULT_IMPORT_LIMITS.maxProjectBytes, `Project file ${file.name}`);
  const data: unknown = JSON.parse(await file.text());
  return { kind: 'json', parsed: parseProjectFile(data) };
}

/** Only newly parsed worker-owned buffers leave the worker; no live model is sent. */
export function intakeTransfers(result: ModelIntake): ArrayBuffer[] {
  const mesh = result.kind === 'mesh' ? result.mesh : result.parsed.kind === 'project' ? result.parsed.originalMesh : null;
  return mesh ? [...new Set([mesh.positions.buffer as ArrayBuffer, mesh.normals.buffer as ArrayBuffer])] : [];
}
