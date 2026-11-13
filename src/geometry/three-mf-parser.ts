// 3MF import: package -> model part(s) -> one merged triangle mesh in millimetres.
//
// Supports the core spec's <object>/<mesh>/<components> and <build>/<item>
// with 3x4 transforms, plus production-extension p:path references to model
// parts elsewhere in the package (common in slicer-saved projects).
// Optional extension data such as materials and slices is ignored. Declared
// units are converted to millimetres and reported to the caller for logging.
import { alignNormalsToWinding } from './mesh-analysis';
import { DEFAULT_IMPORT_LIMITS, formatByteCount, validateMeshPositions, type ImportLimits } from './mesh-limits';
import type { TriangleMesh } from './stl-parser';
import { scanXml, xmlAttribute, type XmlElement } from './xml-scan';
import { extractZipEntry, hasZipSignature, readZipDirectory, type ZipEntry } from './zip-reader';

export const THREE_MF_CORE_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
export const THREE_MF_PRODUCTION_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const MODEL_RELATIONSHIP_TYPE = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const DEFAULT_MODEL_PATH = '3d/3dmodel.model';
const MAX_COMPONENT_DEPTH = 64;

/** Millimetres per declared 3MF unit (3MF core spec, `model@unit`). */
export const THREE_MF_UNIT_TO_MM: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

export interface ThreeMfImport {
  /** Merged build, in millimetres, with normals computed from winding. */
  mesh: TriangleMesh;
  /**
   * The recognized `unit` attribute as declared, or null when absent (the spec
   * default, millimeter, is then assumed) or unrecognized (kept as written).
   */
  declaredUnit: string | null;
  /** Factor applied to reach millimetres (1 when declared or defaulted to millimeter). */
  scaleToMm: number;
  /** Build items merged into the mesh. */
  buildItems: number;
  /** Object instances placed with a mirroring transform (winding reversed to stay outward). */
  mirroredInstances: number;
  /** Non-fatal observations worth logging. */
  warnings: string[];
}

type Transform = Float64Array; // m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32 (row-vector convention)
const IDENTITY: Transform = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

interface Reference { objectId: string; path: string | null; transform: Transform }
interface ModelObject {
  id: string;
  type: string;
  vertices: GrowableF64 | null;
  triangles: GrowableU32 | null;
  components: Reference[];
}
interface ModelPart {
  path: string;
  unit: string | null;
  objects: Map<string, ModelObject>;
  build: Reference[];
}

class GrowableF64 {
  data = new Float64Array(3 * 1024);
  length = 0;
  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) { const next = new Float64Array(this.data.length * 2); next.set(this.data); this.data = next; }
    this.data[this.length++] = a; this.data[this.length++] = b; this.data[this.length++] = c;
  }
}
class GrowableU32 {
  data = new Uint32Array(3 * 1024);
  length = 0;
  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) { const next = new Uint32Array(this.data.length * 2); next.set(this.data); this.data = next; }
    this.data[this.length++] = a; this.data[this.length++] = b; this.data[this.length++] = c;
  }
}

/** Package part names compare case-insensitively without a leading slash. */
function normalizePartName(name: string): string {
  let decoded = name;
  try { decoded = decodeURIComponent(name); } catch { /* keep as written */ }
  return decoded.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function parseNumber(value: string | undefined, what: string): number {
  if (value === undefined || value.trim() === '') throw new Error(`3MF model is invalid: ${what} is missing`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`3MF model is invalid: ${what} is not a finite number ("${value.slice(0, 40)}")`);
  return number;
}

function parseIndex(value: string | undefined, what: string): number {
  const number = parseNumber(value, what);
  if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) throw new Error(`3MF model is invalid: ${what} is not a vertex index ("${value}")`);
  return number;
}

export function parseTransform(value: string | undefined): Transform {
  if (value === undefined || value.trim() === '') return IDENTITY;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 12) throw new Error(`3MF model is invalid: transform needs 12 numbers, found ${parts.length}`);
  return new Float64Array(parts.map((part) => parseNumber(part, 'transform entry')));
}

/** The transform that applies `first`, then `second`. */
function compose(first: Transform, second: Transform): Transform {
  const out = new Float64Array(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = row === 3 ? second[9 + col] : 0;
      for (let k = 0; k < 3; k++) sum += first[row * 3 + k] * second[k * 3 + col];
      out[row * 3 + col] = sum;
    }
  }
  return out;
}

function determinant(m: Transform): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

class ModelBudget {
  vertices = 0;
  triangles = 0;
  private readonly limits: ImportLimits;
  constructor(limits: ImportLimits) { this.limits = limits; }
  addVertex() {
    if (++this.vertices > this.limits.maxVertices) throw new Error(`3MF model has more than the supported limit of ${this.limits.maxVertices} vertices`);
  }
  addTriangle() {
    if (++this.triangles > this.limits.maxTriangles) throw new Error(`3MF model has more than the supported limit of ${this.limits.maxTriangles} triangles`);
  }
}

function parseModelPart(bytes: Uint8Array, path: string, budget: ModelBudget, isRoot: boolean): ModelPart {
  const part: ModelPart = { path, unit: null, objects: new Map(), build: [] };
  let rootSeen = false;
  let object: ModelObject | null = null;
  let mesh = false;
  let inBuild = false;
  const core = (element: { ns: string | undefined }) => element.ns === THREE_MF_CORE_NAMESPACE || element.ns === undefined;
  const reference = (element: XmlElement, what: string): Reference => {
    const objectId = xmlAttribute(element, 'objectid');
    if (!objectId) throw new Error(`3MF model is invalid: ${what} has no objectid`);
    const rawPath = xmlAttribute(element, 'path', THREE_MF_PRODUCTION_NAMESPACE);
    if (rawPath && !isRoot) throw new Error(`3MF child model part ${path} cannot reference another model part`);
    return { objectId, path: rawPath ? normalizePartName(rawPath) : null, transform: parseTransform(xmlAttribute(element, 'transform')) };
  };

  scanXml(bytes, {
    start(element, namespaces) {
      if (!rootSeen) {
        rootSeen = true;
        if (element.local !== 'model' || !core(element)) throw new Error(`3MF part ${path} is not a 3MF model (root element <${element.local}>)`);
        const required = xmlAttribute(element, 'requiredextensions')?.trim();
        if (required) {
          for (const prefix of required.split(/\s+/)) {
            if (namespaces.get(prefix) !== THREE_MF_PRODUCTION_NAMESPACE) {
              throw new Error(`3MF part ${path} requires an unsupported extension ("${prefix.slice(0, 40)}")`);
            }
          }
        }
        part.unit = xmlAttribute(element, 'unit') ?? null;
        return;
      }
      if (!core(element)) return;
      switch (element.local) {
        case 'object': {
          const id = xmlAttribute(element, 'id');
          if (!id) throw new Error('3MF model is invalid: <object> has no id');
          if (part.objects.has(id)) throw new Error(`3MF model is invalid: duplicate object id ${id}`);
          object = { id, type: xmlAttribute(element, 'type') ?? 'model', vertices: null, triangles: null, components: [] };
          break;
        }
        case 'mesh':
          if (object) { mesh = true; object.vertices ??= new GrowableF64(); object.triangles ??= new GrowableU32(); }
          break;
        case 'vertex':
          if (mesh && object?.vertices) {
            budget.addVertex();
            object.vertices.push3(
              parseNumber(xmlAttribute(element, 'x'), 'vertex x'),
              parseNumber(xmlAttribute(element, 'y'), 'vertex y'),
              parseNumber(xmlAttribute(element, 'z'), 'vertex z'),
            );
          }
          break;
        case 'triangle':
          if (mesh && object?.triangles) {
            budget.addTriangle();
            object.triangles.push3(
              parseIndex(xmlAttribute(element, 'v1'), 'triangle v1'),
              parseIndex(xmlAttribute(element, 'v2'), 'triangle v2'),
              parseIndex(xmlAttribute(element, 'v3'), 'triangle v3'),
            );
          }
          break;
        case 'component':
          if (object && !mesh) object.components.push(reference(element, '<component>'));
          break;
        case 'build':
          inBuild = true;
          break;
        case 'item':
          if (inBuild && isRoot) part.build.push(reference(element, 'build <item>'));
          break;
      }
    },
    end(local, ns) {
      if (ns !== THREE_MF_CORE_NAMESPACE && ns !== undefined) return;
      if (local === 'mesh') mesh = false;
      else if (local === 'build') inBuild = false;
      else if (local === 'object' && object) {
        const finished: ModelObject = object;
        if (finished.vertices && finished.triangles) {
          const vertexCount = finished.vertices.length / 3;
          const indices = finished.triangles.data;
          for (let k = 0; k < finished.triangles.length; k++) {
            if (indices[k] >= vertexCount) {
              throw new Error(`3MF model is invalid: object ${finished.id} triangle references vertex ${indices[k]}, but it has ${vertexCount} vertices`);
            }
          }
        }
        part.objects.set(finished.id, finished);
        object = null;
      }
    },
  }, `3MF part ${path}`);
  return part;
}

function findRootModelPath(relationships: Uint8Array | null, names: Map<string, ZipEntry>): string {
  if (relationships) {
    let target: string | null = null;
    scanXml(relationships, {
      start(element) {
        if (target !== null || element.local !== 'Relationship') return;
        const type = xmlAttribute(element, 'Type');
        const candidate = xmlAttribute(element, 'Target');
        if (candidate && type && (type === MODEL_RELATIONSHIP_TYPE || type.endsWith('/3dmodel'))) target = normalizePartName(candidate);
      },
    }, '3MF package relationships');
    if (target !== null && names.has(target)) return target;
  }
  if (names.has(DEFAULT_MODEL_PATH)) return DEFAULT_MODEL_PATH;
  for (const name of names.keys()) if (name.endsWith('.model')) return name;
  throw new Error('3MF package contains no 3D model part');
}

/**
 * Parse a 3MF package into one mesh in millimetres. Async because DEFLATE
 * entries are inflated with the platform DecompressionStream.
 */
export async function parse3MF(input: ArrayBuffer | Uint8Array, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): Promise<ThreeMfImport> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > limits.maxThreeMfBytes) {
    throw new Error(`3MF package is ${formatByteCount(bytes.length)}, exceeding the ${formatByteCount(limits.maxThreeMfBytes)} import limit`);
  }
  if (!hasZipSignature(bytes)) throw new Error('Not a 3MF package: the file does not start with a ZIP signature');
  const entries = readZipDirectory(bytes, { maxEntries: limits.maxZipEntries, maxEntryBytes: limits.maxThreeMfUncompressedBytes });
  const names = new Map<string, ZipEntry>();
  for (const entry of entries) if (!entry.name.endsWith('/')) names.set(normalizePartName(entry.name), entry);

  // One uncompressed budget across every extracted part.
  let extracted = 0;
  const extract = async (name: string): Promise<Uint8Array> => {
    const entry = names.get(name);
    if (!entry) throw new Error(`3MF package is missing part ${name}`);
    if (extracted + entry.uncompressedSize > limits.maxThreeMfUncompressedBytes) {
      throw new Error(`3MF package expands beyond the ${formatByteCount(limits.maxThreeMfUncompressedBytes)} uncompressed import limit`);
    }
    extracted += entry.uncompressedSize;
    return extractZipEntry(bytes, entry, { maxEntries: limits.maxZipEntries, maxEntryBytes: limits.maxThreeMfUncompressedBytes - (extracted - entry.uncompressedSize) });
  };

  const relationships = names.has('_rels/.rels') ? await extract('_rels/.rels') : null;
  const rootPath = findRootModelPath(relationships, names);
  const budget = new ModelBudget(limits);
  const parts = new Map<string, ModelPart>();
  const pending = [rootPath];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (parts.has(path)) continue;
    const part = parseModelPart(await extract(path), path, budget, path === rootPath);
    parts.set(path, part);
    const referenced = [...part.build, ...[...part.objects.values()].flatMap((object) => object.components)];
    for (const ref of referenced) if (ref.path && !parts.has(ref.path)) pending.push(ref.path);
  }
  const root = parts.get(rootPath)!;
  const warnings: string[] = [];

  let declaredUnit = root.unit;
  let scaleToMm = 1;
  if (declaredUnit !== null) {
    const factor = Object.hasOwn(THREE_MF_UNIT_TO_MM, declaredUnit) ? THREE_MF_UNIT_TO_MM[declaredUnit] : undefined;
    if (factor === undefined) {
      // Tolerate it, but do not guess: keep coordinates as written and let
      // the caller ask about units as it would for a unitless format.
      warnings.push(`3MF model declares unrecognized unit "${declaredUnit.slice(0, 40)}"; coordinates were kept as written.`);
      declaredUnit = null;
    } else {
      scaleToMm = factor;
    }
  }

  const lookup = (ref: Reference, containing: string): { object: ModelObject; path: string } => {
    const path = ref.path ?? containing;
    const object = parts.get(path)?.objects.get(ref.objectId);
    if (!object) throw new Error(`3MF model is invalid: object ${ref.objectId} is not defined${path === rootPath ? '' : ` in ${path}`}`);
    return { object, path };
  };

  // Count triangles and instances after component expansion before allocating
  // anything: one object instanced many times can otherwise amplify a small
  // file into an enormous mesh.
  const counts = new Map<ModelObject, { triangles: number; instances: number }>();
  const visiting = new Set<ModelObject>();
  const count = (object: ModelObject, path: string, depth: number): { triangles: number; instances: number } => {
    const known = counts.get(object);
    if (known) return known;
    if (visiting.has(object)) throw new Error(`3MF model is invalid: object ${object.id} contains itself through its components`);
    if (depth > MAX_COMPONENT_DEPTH) throw new Error(`3MF components nest deeper than ${MAX_COMPONENT_DEPTH} levels`);
    visiting.add(object);
    let triangles = object.triangles ? object.triangles.length / 3 : 0;
    let instances = 1;
    for (const component of object.components) {
      const child = lookup(component, path);
      const sub = count(child.object, child.path, depth + 1);
      triangles += sub.triangles;
      instances += sub.instances;
    }
    visiting.delete(object);
    const result = { triangles, instances };
    counts.set(object, result);
    return result;
  };

  const items: { object: ModelObject; path: string; transform: Transform }[] = [];
  let skipped = 0;
  let totalTriangles = 0;
  let totalInstances = 0;
  for (const item of root.build) {
    const { object, path } = lookup(item, rootPath);
    // Supports and "other" objects are not part of the printed solid.
    if (object.type !== 'model') { skipped++; continue; }
    const sub = count(object, path, 0);
    totalTriangles += sub.triangles;
    totalInstances += sub.instances;
    if (totalInstances > limits.maxComponentInstances) {
      throw new Error(`3MF build places more than the supported limit of ${limits.maxComponentInstances} object instances`);
    }
    if (totalTriangles > limits.maxTriangles) {
      throw new Error(`3MF build expands to ${totalTriangles} triangles, exceeding the supported limit of ${limits.maxTriangles}`);
    }
    items.push({ object, path, transform: item.transform });
  }
  if (skipped > 0) warnings.push(`Skipped ${skipped} build item(s) that are not model objects (supports or other).`);
  if (items.length === 0) throw new Error(root.build.length === 0 ? '3MF model has no build items' : '3MF build contains no model objects');

  const positions = new Float32Array(totalTriangles * 9);
  let written = 0;
  let degenerate = 0;
  let mirroredInstances = 0;
  const emit = (object: ModelObject, path: string, transform: Transform) => {
    if (object.vertices && object.triangles) {
      const mirrored = determinant(transform) < 0;
      if (mirrored) mirroredInstances++;
      const v = object.vertices.data;
      const t = object.triangles.data;
      const m = transform;
      const put = (index: number) => {
        const x = v[index * 3], y = v[index * 3 + 1], z = v[index * 3 + 2];
        positions[written++] = (x * m[0] + y * m[3] + z * m[6] + m[9]) * scaleToMm;
        positions[written++] = (x * m[1] + y * m[4] + z * m[7] + m[10]) * scaleToMm;
        positions[written++] = (x * m[2] + y * m[5] + z * m[8] + m[11]) * scaleToMm;
      };
      for (let k = 0; k < object.triangles.length; k += 3) {
        const a = t[k], b = t[k + 1], c = t[k + 2];
        if (a === b || b === c || a === c) { degenerate++; continue; }
        put(a);
        if (mirrored) { put(c); put(b); } else { put(b); put(c); }
      }
    }
    for (const component of object.components) {
      const child = lookup(component, path);
      emit(child.object, child.path, compose(component.transform, transform));
    }
  };
  for (const item of items) emit(item.object, item.path, item.transform);
  if (degenerate > 0) warnings.push(`Dropped ${degenerate} triangle(s) that repeat a vertex.`);
  if (mirroredInstances > 0) warnings.push(`Reversed winding on ${mirroredInstances} mirrored object instance(s) to keep faces outward.`);

  const triCount = written / 9;
  if (triCount === 0) throw new Error('3MF build contains no triangles');
  const merged = positions.length === written ? positions : positions.slice(0, written);
  validateMeshPositions(merged);
  return {
    mesh: alignNormalsToWinding({ positions: merged, normals: new Float32Array(0), triCount }),
    declaredUnit,
    scaleToMm,
    buildItems: items.length,
    mirroredInstances,
    warnings,
  };
}
