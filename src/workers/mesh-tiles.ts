// Imported-mesh tiling: tile planning with conservative sparse skipping, the
// per-tile field/extraction kernel shared by tile workers and tests, and the
// grid-order merge.
//
// Every tile is a window of the single-worker sampling grid. Samples are taken
// at the whole grid's coordinates, escape holes and the boundary seal are
// applied per sample exactly as the single-worker path applies them to the
// whole field, and triangles are merged back in whole-grid emission order. The
// merged soup is therefore byte-identical to the single-worker soup before
// cleanup, for any worker count.
import { workerFailure } from '../utils/failure-cause';
import { MeshBVH, type SerializedMeshBVH } from '../geometry/bvh';
import { unpackSerializedMeshBVH } from '../geometry/bvh-serialization';
import {
  resolveEscapeHoleCenters,
  escapeHolesSdf,
  shouldApplyEscapeHoles,
} from '../geometry/escape-holes';
import { assertGenerationGrid, assertGenerationOutputBudget, generationSampleCount } from '../geometry/generation-limits';
import { buildCombinedSDF, type SdfFunction } from '../geometry/lattice';
import {
  marchingCubesFromFieldWindow,
  type FieldWindowResult,
  type MarchingCubesResult,
} from '../geometry/marching-cubes';
import type { Vec3 } from '../geometry/vec3';
import type { LatticeParams } from '../types/project';
import type {
  LatticeTileResult,
  MeshTileInit,
  MeshTileJob,
  TileSkipStats,
} from './tile-types';

/** Field for an imported mesh; the single-worker path and tile workers both build it here. */
export function buildImportedMeshSdf(
  bvh: MeshBVH,
  fieldParams: LatticeParams,
  generationSeed: number,
  keepOutTris: readonly number[],
  keepInTris: readonly number[],
): SdfFunction {
  return buildCombinedSDF({
    bvh,
    params: fieldParams,
    generationSeed,
    keepOutTris: new Set(keepOutTris),
    keepInTris: new Set(keepInTris),
  });
}

export interface MeshTileContext {
  sdf: SdfFunction;
  params: LatticeParams;
  gridBounds: { min: Vec3; max: Vec3 };
  gridCells: Vec3;
  holeCenters: Vec3[] | null;
}

/**
 * Rebuild the field inside a tile worker. The BVH and its pseudonormal tables
 * are used in place; only painted keep-in/keep-out subsets, if any, are
 * rebuilt (they are small distance-only BVHs built from the same triangles).
 */
export function createMeshTileContext(init: MeshTileInit): MeshTileContext {
  assertGenerationGrid(init.gridCells, 'cpu-tiled');
  const bvh = MeshBVH.fromSerialized(unpackSerializedMeshBVH(init.bvh));
  return {
    sdf: buildImportedMeshSdf(bvh, init.fieldParams, init.generationSeed, init.keepOutTris, init.keepInTris),
    params: init.params,
    gridBounds: init.gridBounds,
    gridCells: init.gridCells,
    holeCenters: shouldApplyEscapeHoles(init.params)
      ? resolveEscapeHoleCenters(init.gridBounds, init.params)
      : null,
  };
}

/**
 * Sample, cut escape holes, seal and extract one window. Each step matches
 * the single-worker sequence `sampleSdfField` -> `cutEscapeHolesInField` ->
 * `sealFieldBoundary` -> `marchingCubesFromField` for the samples it covers.
 */
export function computeMeshTile(context: MeshTileContext, job: Pick<MeshTileJob, 'origin' | 'cells'>): FieldWindowResult {
  const { sdf, params, gridBounds, gridCells, holeCenters } = context;
  const [cx, cy, cz] = job.cells;
  const [ox, oy, oz] = job.origin;
  const field = new Float32Array(generationSampleCount(job.cells));
  const minX = gridBounds.min[0], minY = gridBounds.min[1], minZ = gridBounds.min[2];
  const dx = (gridBounds.max[0] - minX) / gridCells[0];
  const dy = (gridBounds.max[1] - minY) / gridCells[1];
  const dz = (gridBounds.max[2] - minZ) / gridCells[2];

  let index = 0;
  for (let z = 0; z <= cz; z++) {
    const pz = minZ + (oz + z) * dz;
    for (let y = 0; y <= cy; y++) {
      const py = minY + (oy + y) * dy;
      for (let x = 0; x <= cx; x++, index++) {
        field[index] = sdf(minX + (ox + x) * dx, py, pz);
      }
    }
  }

  if (holeCenters) {
    index = 0;
    for (let z = 0; z <= cz; z++) {
      const pz = minZ + (oz + z) * dz;
      for (let y = 0; y <= cy; y++) {
        const py = minY + (oy + y) * dy;
        for (let x = 0; x <= cx; x++, index++) {
          const hole = escapeHolesSdf(
            minX + (ox + x) * dx,
            py,
            pz,
            holeCenters,
            params.escapeHoleAxis,
            params.escapeHoleDiameter,
          );
          field[index] = Math.max(field[index], -hole);
        }
      }
    }
  }

  // Seal only samples on the whole grid's outer faces.
  const [nx, ny, nz] = gridCells;
  index = 0;
  for (let z = 0; z <= cz; z++) {
    const zFace = oz + z === 0 || oz + z === nz;
    for (let y = 0; y <= cy; y++) {
      const yFace = oy + y === 0 || oy + y === ny;
      for (let x = 0; x <= cx; x++, index++) {
        if (!(zFace || yFace || ox + x === 0 || ox + x === nx)) continue;
        if (field[index] <= 0) field[index] = 1;
      }
    }
  }

  return marchingCubesFromFieldWindow(field, gridBounds, gridCells, job.origin, job.cells, 0);
}

// ─── Sparse tile skipping ────────────────────────────────────────────────

/** Cracks narrower than this fraction of the bounding diagonal are bridged. */
const CRACK_TOLERANCE_REL = 1e-6;
/** Faces meeting across a bridged crack must bend by less than ~87 degrees. */
const MIN_CRACK_NORMAL_DOT = 0.05;
/** Largest face fan examined around one bridged crack vertex. */
const MAX_CRACK_FAN = 1024;

function unitFaceNormal(data: SerializedMeshBVH, tri: number, out: Float64Array): boolean {
  const o = tri * 3;
  const abx = data.triAB[o], aby = data.triAB[o + 1], abz = data.triAB[o + 2];
  const acx = data.triAC[o], acy = data.triAC[o + 1], acz = data.triAC[o + 2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 0)) return false;
  out[0] = nx / length;
  out[1] = ny / length;
  out[2] = nz / length;
  return true;
}

function normalsAgree(data: SerializedMeshBVH, a: number, b: number): boolean {
  const na = new Float64Array(3);
  const nb = new Float64Array(3);
  if (!unitFaceNormal(data, a, na) || !unitFaceNormal(data, b, nb)) return false;
  return na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] > MIN_CRACK_NORMAL_DOT;
}

/**
 * Bridge sub-tolerance cracks (float seams such as y = 0 vs y = -6e-16 on a
 * UV sphere, or split pole vertices) by merging boundary vertices that lie
 * within the tolerance, and check the result is closed and oriented.
 *
 * Across a bridged crack each side's pseudonormal sees only its own faces.
 * The sign stays correct for points whose nearest feature is a crack edge or
 * vertex as long as the faces there bend by less than 90 degrees (every
 * direction in the feature's Voronoi cone then has a positive component along
 * each adjacent face normal), so sharper cracks disable skipping.
 */
function bridgeCracks(
  data: SerializedMeshBVH,
  boundarySlots: number[],
  collapsed: Uint8Array,
  parent: Int32Array,
  find: (v: number) => number,
): boolean {
  const { triCount, triVertex } = data;
  const vertexCount = parent.length;
  const diagonal = Math.hypot(
    data.nodeMax[0] - data.nodeMin[0],
    data.nodeMax[1] - data.nodeMin[1],
    data.nodeMax[2] - data.nodeMin[2],
  );
  const tolerance = diagonal * CRACK_TOLERANCE_REL;
  if (!(tolerance > 0)) return false;

  const firstCorner = new Int32Array(vertexCount).fill(-1);
  for (let corner = 0; corner < triCount * 3; corner++) {
    if (firstCorner[triVertex[corner]] < 0) firstCorner[triVertex[corner]] = corner;
  }
  const position = (v: number, axis: number) => data.positions[firstCorner[v] * 3 + axis];
  const isBoundary = new Uint8Array(vertexCount);
  const boundaryVertices: number[] = [];
  const nextCorner = (slot: number) => (slot % 3 === 2 ? slot - 2 : slot + 1);
  for (const slot of boundarySlots) {
    for (const v of [triVertex[slot], triVertex[nextCorner(slot)]]) {
      if (!isBoundary[v]) {
        isBoundary[v] = 1;
        boundaryVertices.push(v);
      }
    }
  }

  // Merge boundary vertices closer than the tolerance (spatial hash, 27 cells).
  const cells = new Map<string, number[]>();
  const merged = new Uint8Array(vertexCount);
  for (const v of boundaryVertices) {
    const cx = Math.floor(position(v, 0) / tolerance);
    const cy = Math.floor(position(v, 1) / tolerance);
    const cz = Math.floor(position(v, 2) / tolerance);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const u of bucket) {
            const distance = Math.hypot(
              position(u, 0) - position(v, 0),
              position(u, 1) - position(v, 1),
              position(u, 2) - position(v, 2),
            );
            if (distance > tolerance) continue;
            const ru = find(u);
            const rv = find(v);
            if (ru !== rv) parent[ru] = rv;
            merged[u] = 1;
            merged[v] = 1;
          }
        }
      }
    }
    const key = `${cx},${cy},${cz}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(v);
    else cells.set(key, [v]);
  }

  // No further triangle may collapse under the merge.
  for (let t = 0; t < triCount; t++) {
    if (collapsed[t]) continue;
    const a = find(triVertex[t * 3]);
    const b = find(triVertex[t * 3 + 1]);
    const c = find(triVertex[t * 3 + 2]);
    if (a === b || b === c || a === c) return false;
  }

  // Every edge between boundary vertices, re-keyed on merged ids, must be
  // used exactly twice in opposite directions.
  const edges = new Map<string, { uses: number; direction: number; tris: number[]; crack: boolean }>();
  const boundarySet = new Set(boundarySlots);
  for (let slot = 0; slot < triCount * 3; slot++) {
    if (collapsed[Math.floor(slot / 3)]) continue;
    const a = triVertex[slot];
    const b = triVertex[nextCorner(slot)];
    if (!isBoundary[a] || !isBoundary[b]) continue;
    const ra = find(a);
    const rb = find(b);
    const key = ra < rb ? `${ra},${rb}` : `${rb},${ra}`;
    let entry = edges.get(key);
    if (!entry) {
      entry = { uses: 0, direction: 0, tris: [], crack: false };
      edges.set(key, entry);
    }
    entry.uses++;
    entry.direction += ra < rb ? 1 : -1;
    entry.tris.push(Math.floor(slot / 3));
    if (boundarySet.has(slot)) entry.crack = true;
  }
  for (const entry of edges.values()) {
    if (entry.uses !== 2 || entry.direction !== 0) return false;
    if (entry.crack && !normalsAgree(data, entry.tris[0], entry.tris[1])) return false;
  }

  // Faces around each bridged vertex must agree pairwise.
  const fans = new Map<number, number[]>();
  for (let corner = 0; corner < triCount * 3; corner++) {
    if (collapsed[Math.floor(corner / 3)]) continue;
    const v = triVertex[corner];
    if (!merged[v]) continue;
    const root = find(v);
    const fan = fans.get(root);
    if (fan) fan.push(Math.floor(corner / 3));
    else fans.set(root, [Math.floor(corner / 3)]);
  }
  const normal = new Float64Array(3);
  for (const fan of fans.values()) {
    if (fan.length > MAX_CRACK_FAN) return false;
    const normals = new Float64Array(fan.length * 3);
    for (let i = 0; i < fan.length; i++) {
      if (!unitFaceNormal(data, fan[i], normal)) return false;
      normals.set(normal, i * 3);
    }
    for (let i = 0; i < fan.length; i++) {
      for (let j = i + 1; j < fan.length; j++) {
        const dot = normals[i * 3] * normals[j * 3]
          + normals[i * 3 + 1] * normals[j * 3 + 1]
          + normals[i * 3 + 2] * normals[j * 3 + 2];
        if (!(dot > MIN_CRACK_NORMAL_DOT)) return false;
      }
    }
  }
  return true;
}

/**
 * Whether the pseudonormal sign of `bvh` is a trustworthy inside/outside test
 * far from its surface: every edge is shared by exactly two triangles with
 * opposite directions (closed, consistently oriented) once sub-tolerance
 * cracks are bridged (see `bridgeCracks`), and separate shells have disjoint
 * bounding boxes, so overlapping or nested shells cannot make the sign flip
 * away from the surface. Self-intersections within one shell are not
 * detected.
 */
export function signIsReliableForSkipping(data: SerializedMeshBVH): boolean {
  const { triCount, triVertex, triEdge } = data;
  const edgeCount = data.edgeNormals.length / 3;
  const vertexCount = data.vertexNormals.length / 3;
  // A triangle with two corners welded together (a UV-sphere pole, say) is a
  // segment lying on real edges. It adds nothing to the pseudonormals, and its
  // edge slots carry the welded edge ids of the faces it lies on, so it is
  // left out of the topology check.
  const collapsed = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = triVertex[t * 3], b = triVertex[t * 3 + 1], c = triVertex[t * 3 + 2];
    if (a === b || b === c || a === c) collapsed[t] = 1;
  }
  const uses = new Uint8Array(edgeCount);
  const direction = new Int8Array(edgeCount);
  for (let slot = 0; slot < triCount * 3; slot++) {
    if (collapsed[Math.floor(slot / 3)]) continue;
    const edge = triEdge[slot];
    const a = triVertex[slot];
    const b = triVertex[slot % 3 === 2 ? slot - 2 : slot + 1];
    if (uses[edge] >= 2) return false;
    uses[edge]++;
    direction[edge] += a < b ? 1 : -1;
  }
  const boundarySlots: number[] = [];
  for (let slot = 0; slot < triCount * 3; slot++) {
    if (collapsed[Math.floor(slot / 3)]) continue;
    const edge = triEdge[slot];
    if (uses[edge] === 1) boundarySlots.push(slot);
    else if (direction[edge] !== 0) return false;
  }

  const parent = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) parent[v] = v;
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  if (boundarySlots.length > 0 && !bridgeCracks(data, boundarySlots, collapsed, parent, find)) return false;

  // Shells: connected components over (bridged) vertices.
  for (let t = 0; t < triCount; t++) {
    const a = find(triVertex[t * 3]);
    const b = find(triVertex[t * 3 + 1]);
    if (b !== a) parent[b] = a;
    const c = find(triVertex[t * 3 + 2]);
    if (c !== a) parent[c] = a;
  }
  const shellBoxes = new Map<number, Float64Array>();
  for (let t = 0; t < triCount; t++) {
    const root = find(triVertex[t * 3]);
    let box = shellBoxes.get(root);
    if (!box) {
      box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      shellBoxes.set(root, box);
    }
    for (let k = 0; k < 9; k++) {
      const value = data.positions[t * 9 + k];
      const axis = k % 3;
      if (value < box[axis]) box[axis] = value;
      if (value > box[axis + 3]) box[axis + 3] = value;
    }
  }
  const boxes = [...shellBoxes.values()];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = a[0] <= b[3] && b[0] <= a[3]
        && a[1] <= b[4] && b[1] <= a[4]
        && a[2] <= b[5] && b[2] <= a[5];
      if (overlap) return false;
    }
  }
  return true;
}

/**
 * Whether any BVH leaf box lies within `radius` of the axis-aligned box. Leaf
 * boxes contain their triangles, so `false` proves every surface point is
 * farther than `radius` from every point of the box.
 */
export function surfaceMayBeWithin(
  data: SerializedMeshBVH,
  boxMin: Vec3,
  boxMax: Vec3,
  radius: number,
): boolean {
  const { nodeMin, nodeMax, leftFirst, count } = data;
  const radiusSq = radius * radius;
  const stack: number[] = [0];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const o = node * 3;
    let distSq = 0;
    for (let axis = 0; axis < 3; axis++) {
      const gap = Math.max(nodeMin[o + axis] - boxMax[axis], boxMin[axis] - nodeMax[o + axis], 0);
      distSq += gap * gap;
    }
    if (distSq > radiusSq) continue;
    if (count[node] > 0) return true;
    stack.push(leftFirst[node], leftFirst[node] + 1);
  }
  return false;
}

/**
 * Distance beyond which the material field is provably positive.
 *
 * Outside the object every mode is `max(..., dObj)` or a smooth union with
 * `dObj`, at most two blends (blendK / 6 each, blendK <= 0.3 x min(wall,
 * strut)) below it, and escape holes only raise the field. The same feature
 * margin as procedural skipping covers that with room to spare.
 */
function featureMargin(params: LatticeParams): number {
  return Math.max(
    params.cellSize * 0.25,
    params.wallThickness,
    params.strutDiameter,
    params.shellThickness,
    params.surfaceDepth,
    params.thinSectionFilter,
    0,
  );
}

/**
 * Depth below the surface that surface-only material (and painted regions)
 * can reach: the band itself, keep-in solid under painted faces and the
 * keep-out skin. Deeper than this the field is `|dObj| - reach > 0`.
 */
function surfaceOnlyReach(params: LatticeParams, hasKeepOut: boolean, hasKeepIn: boolean): number {
  return Math.max(
    params.surfaceDepth,
    hasKeepIn ? Math.max(0.01, params.keepInDepth) : 0,
    hasKeepOut ? Math.max(params.shellThickness, params.minFeatureSize, 0.01) : 0,
  );
}

export interface MeshTilePlan {
  jobs: MeshTileJob[];
  stats: TileSkipStats;
  /** Tiles per axis of the grid; jobs carry their window origins. */
  tilesPerAxis: Vec3;
  tileSize: number;
  sparseSkipping: boolean;
}

/**
 * Split the grid into tiles and drop tiles whose samples are all provably
 * positive, so the single-worker path extracts no triangles there either.
 * A tile is skipped when no surface lies within the feature margin of its box
 * and the tile is outside the object, or (surface-only) deeper inside than
 * the material can reach. Skipping requires a closed, consistently oriented
 * mesh, whose pseudonormal sign is constant on any region the surface does
 * not cross; other meshes process every tile.
 */
export function planMeshTiles(options: {
  bvh: MeshBVH;
  serialized: SerializedMeshBVH;
  params: LatticeParams;
  bounds: { min: Vec3; max: Vec3 };
  resolution: number;
  tileSize: number;
  hasKeepOut: boolean;
  hasKeepIn: boolean;
  enableSparseSkipping: boolean;
}): MeshTilePlan {
  const { bvh, serialized, params, bounds, resolution, tileSize } = options;
  const cells: Vec3 = [resolution, resolution, resolution];
  assertGenerationGrid(cells, 'cpu-tiled');
  const sparseSkipping = options.enableSparseSkipping && signIsReliableForSkipping(serialized);
  const outsideMargin = featureMargin(params);
  const insideMargin = outsideMargin + surfaceOnlyReach(params, options.hasKeepOut, options.hasKeepIn);
  const dx = (bounds.max[0] - bounds.min[0]) / resolution;
  const dy = (bounds.max[1] - bounds.min[1]) / resolution;
  const dz = (bounds.max[2] - bounds.min[2]) / resolution;
  const perAxis = Math.ceil(resolution / tileSize);
  const jobs: MeshTileJob[] = [];
  let tilesTotal = 0;
  let tilesSkipped = 0;

  for (let z = 0; z < resolution; z += tileSize) {
    const cellsZ = Math.min(tileSize, resolution - z);
    for (let y = 0; y < resolution; y += tileSize) {
      const cellsY = Math.min(tileSize, resolution - y);
      for (let x = 0; x < resolution; x += tileSize) {
        const cellsX = Math.min(tileSize, resolution - x);
        tilesTotal++;
        if (sparseSkipping) {
          const min: Vec3 = [bounds.min[0] + x * dx, bounds.min[1] + y * dy, bounds.min[2] + z * dz];
          const max: Vec3 = [
            bounds.min[0] + (x + cellsX) * dx,
            bounds.min[1] + (y + cellsY) * dy,
            bounds.min[2] + (z + cellsZ) * dz,
          ];
          const center: Vec3 = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5];
          if (!surfaceMayBeWithin(serialized, min, max, outsideMargin)) {
            const outside = bvh.signedDistance(center) > 0;
            if (outside || (params.surfaceOnly && !surfaceMayBeWithin(serialized, min, max, insideMargin))) {
              tilesSkipped++;
              continue;
            }
          }
        }
        jobs.push({
          type: 'mesh-tile',
          tileId: jobs.length,
          origin: [x, y, z],
          cells: [cellsX, cellsY, cellsZ],
        });
      }
    }
  }
  return {
    jobs,
    stats: { tilesTotal, tilesSkipped, tilesProcessed: jobs.length },
    tilesPerAxis: [perAxis, perAxis, perAxis],
    tileSize,
    sparseSkipping,
  };
}

/** Check a mesh-tile response's row table against its job before merging. */
export function isValidRowTable(result: LatticeTileResult, job: MeshTileJob): boolean {
  const rows = result.rowTriangleStarts;
  if (!(rows instanceof Uint32Array) || rows.length !== job.cells[1] * job.cells[2] + 1) return false;
  if (rows[rows.length - 1] !== result.triCount) return false;
  for (let i = 1; i < rows.length; i++) if (rows[i] < rows[i - 1]) return false;
  return true;
}

/**
 * Interleave tile rows into whole-grid emission order (z, then y, then x),
 * which reproduces the single-worker triangle order exactly.
 */
export function mergeMeshTilesInGridOrder(
  plan: MeshTilePlan,
  results: readonly LatticeTileResult[],
  resolution: number,
): MarchingCubesResult {
  const [tilesX, tilesY] = plan.tilesPerAxis;
  const byTile: (LatticeTileResult | null)[] = new Array(tilesX * tilesY * plan.tilesPerAxis[2]).fill(null);
  const jobByTile: (MeshTileJob | null)[] = new Array(byTile.length).fill(null);
  let triCount = 0;
  for (const job of plan.jobs) {
    const result = results[job.tileId];
    if (!result || !isValidRowTable(result, job)) {
      throw workerFailure('Tile worker returned a malformed response');
    }
    const slot = Math.floor(job.origin[0] / plan.tileSize)
      + tilesX * (Math.floor(job.origin[1] / plan.tileSize) + tilesY * Math.floor(job.origin[2] / plan.tileSize));
    byTile[slot] = result;
    jobByTile[slot] = job;
    triCount += result.triCount;
  }
  assertGenerationOutputBudget(triCount);
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 3);
  let written = 0;
  for (let gz = 0; gz < resolution; gz++) {
    const tz = Math.floor(gz / plan.tileSize);
    const lz = gz - tz * plan.tileSize;
    for (let gy = 0; gy < resolution; gy++) {
      const ty = Math.floor(gy / plan.tileSize);
      const ly = gy - ty * plan.tileSize;
      for (let tx = 0; tx < tilesX; tx++) {
        const slot = tx + tilesX * (ty + tilesY * tz);
        const result = byTile[slot];
        if (!result) continue;
        const row = lz * jobByTile[slot]!.cells[1] + ly;
        const rows = result.rowTriangleStarts!;
        const start = rows[row];
        const end = rows[row + 1];
        if (end === start) continue;
        positions.set(result.positions.subarray(start * 9, end * 9), written * 9);
        normals.set(result.normals.subarray(start * 3, end * 3), written * 3);
        written += end - start;
      }
    }
  }
  return { positions, normals, triCount };
}
