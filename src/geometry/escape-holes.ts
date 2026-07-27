// Escape holes: drainage channels cut through the outer shell so unfused
// powder (SLS/MJF) or uncured resin (SLA/DLP) can leave the lattice core.
//
// A shell+core part is a sealed vessel without them, which is the most common
// way a lattice print comes back unusable.
import type { Vec3 } from './vec3';
import type { GridSdfSampler } from './marching-cubes';
import type { LatticeParams } from '../types/project';

type SdfFunction = ((x: number, y: number, z: number) => number) & Partial<GridSdfSampler>;
type ObjectSdf = (x: number, y: number, z: number) => number;

export interface EscapeHole {
  /** Mouth of the channel, sitting slightly outside the surface for a clean breach. */
  origin: Vec3;
  /** Unit vector pointing into the part. */
  axis: Vec3;
  radius: number;
  /** Channel length measured from `origin` along `axis`. */
  depth: number;
}

/**
 * Evenly distributed directions on the sphere.
 *
 * The endpoints are included deliberately: for the common count of 2 this
 * yields the two poles, which is what you want for drainage, rather than the
 * two mid-latitude points a pure Fibonacci spiral would give.
 */
function distributedDirections(count: number): Vec3[] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const dirs: Vec3[] = [];

  for (let i = 0; i < count; i++) {
    const z = count === 1 ? 1 : 1 - (2 * i) / (count - 1);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const theta = goldenAngle * i;
    dirs.push([r * Math.cos(theta), r * Math.sin(theta), z]);
  }

  return dirs;
}

/**
 * March inward from a point outside the object until the surface is reached.
 * Safe to step by the sampled distance because `objectSdf` is a true distance
 * field (mesh BVH or an analytic primitive), unlike the lattice field.
 */
function traceToSurface(objectSdf: ObjectSdf, start: Vec3, dir: Vec3, maxDistance: number): Vec3 | null {
  const minStep = maxDistance * 1e-3;
  let t = 0;

  for (let i = 0; i < 256; i++) {
    const x = start[0] + dir[0] * t;
    const y = start[1] + dir[1] * t;
    const z = start[2] + dir[2] * t;
    const d = objectSdf(x, y, z);
    if (d <= 1e-4) return [x, y, z];
    t += Math.max(d, minStep);
    if (t > maxDistance) return null;
  }

  return null;
}

/** Any unit vector perpendicular to `v`. */
function perpendicular(v: Vec3): Vec3 {
  const a: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const px = a[1] * v[2] - a[2] * v[1];
  const py = a[2] * v[0] - a[0] * v[2];
  const pz = a[0] * v[1] - a[1] * v[0];
  const len = Math.sqrt(px * px + py * py + pz * pz);
  return len < 1e-9 ? [1, 0, 0] : [px / len, py / len, pz / len];
}

/**
 * Fallback for directions whose ray misses the solid entirely — the axis of a
 * torus, the mouth of a C-shape, anything whose centroid sits in empty space.
 * Walks the point onto the nearest surface along the field gradient.
 *
 * Must not be started on an axis of rotational symmetry: there the central
 * difference is exactly zero sideways (`hypot(x, y)` is even in x), so the
 * gradient carries no lateral information and the walk oscillates forever.
 * Callers offset the start point off-axis for this reason.
 */
function projectToSurface(objectSdf: ObjectSdf, from: Vec3, step: number): Vec3 | null {
  let x = from[0], y = from[1], z = from[2];

  for (let i = 0; i < 48; i++) {
    const d = objectSdf(x, y, z);
    if (Math.abs(d) < 1e-4) return [x, y, z];
    const n = surfaceNormal(objectSdf, [x, y, z], step);
    x -= n[0] * d;
    y -= n[1] * d;
    z -= n[2] * d;
  }

  return Math.abs(objectSdf(x, y, z)) < step * 10 ? [x, y, z] : null;
}

function surfaceNormal(objectSdf: ObjectSdf, p: Vec3, h: number): Vec3 {
  const nx = objectSdf(p[0] + h, p[1], p[2]) - objectSdf(p[0] - h, p[1], p[2]);
  const ny = objectSdf(p[0], p[1] + h, p[2]) - objectSdf(p[0], p[1] - h, p[2]);
  const nz = objectSdf(p[0], p[1], p[2] + h) - objectSdf(p[0], p[1], p[2] - h);
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-9) return [0, 0, 1];
  return [nx / len, ny / len, nz / len];
}

/** True when the current settings actually enclose a void worth draining. */
export function escapeHolesApply(params: LatticeParams): boolean {
  // noShell and surfaceOnly leave the interior open already, so a drain would
  // only remove structure.
  return params.escapeHoles
    && !params.noShell
    && !params.surfaceOnly
    && params.escapeHoleCount > 0
    && params.escapeHoleDiameter > 0;
}

/**
 * Place drainage channels on the surface, spread over evenly distributed
 * directions. Each channel starts just outside the surface and runs inward far
 * enough to pass through the shell and open into the lattice core.
 *
 * Directions that miss the object (concave shapes, a torus hole) are skipped
 * rather than forced, so the returned count may be lower than requested.
 */
export function planEscapeHoles(
  objectSdf: ObjectSdf,
  bounds: { min: Vec3; max: Vec3 },
  params: LatticeParams
): EscapeHole[] {
  if (!escapeHolesApply(params)) return [];

  const center: Vec3 = [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
  const sx = bounds.max[0] - bounds.min[0];
  const sy = bounds.max[1] - bounds.min[1];
  const sz = bounds.max[2] - bounds.min[2];
  const reach = 0.5 * Math.sqrt(sx * sx + sy * sy + sz * sz) + 1;

  const radius = params.escapeHoleDiameter * 0.5;
  const overcut = Math.max(0.25, params.shellThickness * 0.5);
  // Past the shell and into the core by at least one cell, so the channel
  // actually opens into the lattice void instead of stopping in the wall.
  const breach = Math.max(params.cellSize, params.shellThickness * 2);
  const depth = overcut + params.shellThickness + breach;
  const normalStep = Math.max(1e-3, Math.min(sx, sy, sz) * 1e-3);

  const holes: EscapeHole[] = [];
  for (const dir of distributedDirections(params.escapeHoleCount)) {
    const start: Vec3 = [
      center[0] + dir[0] * reach,
      center[1] + dir[1] * reach,
      center[2] + dir[2] * reach,
    ];
    const inward: Vec3 = [-dir[0], -dir[1], -dir[2]];
    let hit = traceToSurface(objectSdf, start, inward, reach * 2);

    if (!hit) {
      // Offset off the direction axis before projecting, so a shape that is
      // rotationally symmetric about it still has a usable lateral gradient.
      const lateral = perpendicular(dir);
      const offset = reach * 0.35;
      hit = projectToSurface(
        objectSdf,
        [
          start[0] + lateral[0] * offset,
          start[1] + lateral[1] * offset,
          start[2] + lateral[2] * offset,
        ],
        normalStep
      );
    }
    if (!hit) continue;

    // Projection can land several directions on the same patch of a concave
    // shape, so reject candidates that would overlap an existing channel.
    const tooClose = holes.some((h) => {
      const dx = h.origin[0] - hit[0];
      const dy = h.origin[1] - hit[1];
      const dz = h.origin[2] - hit[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz) < radius * 2.5;
    });
    if (tooClose) continue;

    const normal = surfaceNormal(objectSdf, hit, normalStep);
    holes.push({
      origin: [
        hit[0] + normal[0] * overcut,
        hit[1] + normal[1] * overcut,
        hit[2] + normal[2] * overcut,
      ],
      axis: [-normal[0], -normal[1], -normal[2]],
      radius,
      depth,
    });
  }

  return holes;
}

/** Distance to the nearest channel; negative inside one. */
export function escapeHoleDistance(holes: EscapeHole[], x: number, y: number, z: number): number {
  let best = Infinity;

  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    const lx = x - h.origin[0];
    const ly = y - h.origin[1];
    const lz = z - h.origin[2];
    const axial = lx * h.axis[0] + ly * h.axis[1] + lz * h.axis[2];
    const rx = lx - h.axis[0] * axial;
    const ry = ly - h.axis[1] * axial;
    const rz = lz - h.axis[2] * axial;

    // Capped cylinder: radial and axial slabs combined.
    const dRadial = Math.sqrt(rx * rx + ry * ry + rz * rz) - h.radius;
    const dAxial = Math.abs(axial - h.depth * 0.5) - h.depth * 0.5;
    const outside = Math.sqrt(Math.max(dRadial, 0) ** 2 + Math.max(dAxial, 0) ** 2);
    const inside = Math.min(Math.max(dRadial, dAxial), 0);
    const d = outside + inside;
    if (d < best) best = d;
  }

  return best;
}

/**
 * Subtract the channels from a lattice field.
 *
 * Mirrors the thin-section filter: the grid sampler is wrapped as well as the
 * scalar evaluator, because marching cubes bypasses the scalar path entirely
 * for TPMS lattices and would otherwise extract a surface with no holes in it.
 */
export function withEscapeHoles(sdf: SdfFunction, holes: EscapeHole[]): SdfFunction {
  if (holes.length === 0) return sdf;

  const wrapped: SdfFunction = (x, y, z) =>
    Math.max(sdf(x, y, z), -escapeHoleDistance(holes, x, y, z));

  if (sdf.sampleField) {
    wrapped.sampleField = (bounds, resolution, out, onProgress) => {
      sdf.sampleField!(bounds, resolution, out, onProgress);
      cutEscapeHolesInField(out, bounds, [resolution, resolution, resolution], holes);
    };
  }

  return wrapped;
}

/**
 * Subtract the channels from an already-sampled scalar field, in place.
 *
 * Used by the paths that produce a field directly rather than through an
 * SdfFunction — the tiled CPU backend and the WebGPU field sampler.
 */
export function cutEscapeHolesInField(
  field: Float32Array,
  bounds: { min: Vec3; max: Vec3 },
  cells: Vec3,
  holes: EscapeHole[]
): void {
  if (holes.length === 0) return;

  const nx = cells[0], ny = cells[1], nz = cells[2];
  const minX = bounds.min[0];
  const minY = bounds.min[1];
  const minZ = bounds.min[2];
  const dx = (bounds.max[0] - minX) / nx;
  const dy = (bounds.max[1] - minY) / ny;
  const dz = (bounds.max[2] - minZ) / nz;
  const strideY = nx + 1;
  const strideZ = strideY * (ny + 1);

  for (let z = 0; z <= nz; z++) {
    const pz = minZ + z * dz;
    for (let y = 0; y <= ny; y++) {
      const py = minY + y * dy;
      const rowOffset = y * strideY + z * strideZ;
      for (let x = 0; x <= nx; x++) {
        const index = rowOffset + x;
        field[index] = Math.max(field[index], -escapeHoleDistance(holes, minX + x * dx, py, pz));
      }
    }
  }
}
