// Morphological opening on a sampled scalar field.
//
// The thin-section control was implemented as `sdf + filter`, which erodes the
// solid uniformly. That removes features thinner than twice the filter, but it
// also permanently thins everything that survives — measured on a default
// gyroid sphere the minimum wall fell from 0.587mm to 0.064mm across the
// control's range, so the setting made thin sections worse rather than removing
// them.
//
// Opening is erode-then-dilate, which drops features too thin to contain the
// structuring element and restores the thickness of the rest. It cannot be done
// by adding and subtracting a constant: `(f + r) - r` is arithmetically the
// original field. The distance field of the eroded solid has to be re-derived
// between the two steps, which is what this does.
import type { Vec3 } from './vec3';

const INF = 1e20;

/**
 * Exact squared distance transform of a 1D sampled function, after
 * Felzenszwalb and Huttenlocher: the lower envelope of the parabolas rooted at
 * each sample, computed in linear time.
 */
function edt1d(
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
  spacingSquared: number,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    let s = (
      (f[q] + spacingSquared * q * q)
      - (f[v[k]] + spacingSquared * v[k] * v[k])
    ) / (2 * spacingSquared * (q - v[k]));
    while (s <= z[k]) {
      k--;
      s = (
        (f[q] + spacingSquared * q * q)
        - (f[v[k]] + spacingSquared * v[k] * v[k])
      ) / (2 * spacingSquared * (q - v[k]));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dist = q - v[k];
    d[q] = spacingSquared * dist * dist + f[v[k]];
  }
}

/**
 * Squared physical distance, in millimetres, from every sample to the nearest
 * sample where `seed` is set. Axis weights keep the transform Euclidean when
 * the sampled bounds produce anisotropic voxels.
 */
function squaredDistanceToSeeds(
  seed: Uint8Array,
  cells: Vec3,
  spacing: Vec3,
): Float64Array {
  const [nx, ny, nz] = cells;
  const out = new Float64Array(nx * ny * nz);
  for (let i = 0; i < out.length; i++) out[i] = seed[i] ? 0 : INF;

  const maxDim = Math.max(nx, ny, nz);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  const idx = (x: number, y: number, z2: number) => x + y * nx + z2 * nx * ny;

  for (let z2 = 0; z2 < nz; z2++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) f[x] = out[idx(x, y, z2)];
      edt1d(f, d, v, z, nx, spacing[0] * spacing[0]);
      for (let x = 0; x < nx; x++) out[idx(x, y, z2)] = d[x];
    }
  }
  for (let z2 = 0; z2 < nz; z2++) {
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) f[y] = out[idx(x, y, z2)];
      edt1d(f, d, v, z, ny, spacing[1] * spacing[1]);
      for (let y = 0; y < ny; y++) out[idx(x, y, z2)] = d[y];
    }
  }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      for (let z2 = 0; z2 < nz; z2++) f[z2] = out[idx(x, y, z2)];
      edt1d(f, d, v, z, nz, spacing[2] * spacing[2]);
      for (let z2 = 0; z2 < nz; z2++) out[idx(x, y, z2)] = d[z2];
    }
  }

  return out;
}

/**
 * Open the solid region of `field` with a ball of `radius` millimetres.
 *
 * Resolution bound: the structuring element is realised on the sample grid, so
 * a radius smaller than the spacing between samples cannot be represented and
 * the call is a no-op. Callers should check `openingIsResolvable` and tell the
 * user rather than silently doing nothing.
 */
export function openField(
  field: Float32Array,
  cells: Vec3,
  spacing: Vec3,
  radius: number
): void {
  const [nx, ny, nz] = cells;
  const voxels = nx * ny * nz;
  if (field.length < voxels || !openingIsResolvable(radius, spacing)) return;
  const radiusSquared = radius * radius;

  // Erode: keep only samples at least `radius` inside the original solid.
  // Distance to the outside comes from a transform seeded on outside samples.
  const outside = new Uint8Array(voxels);
  for (let i = 0; i < voxels; i++) outside[i] = field[i] > 0 ? 1 : 0;
  const distToOutsideSq = squaredDistanceToSeeds(outside, cells, spacing);

  const eroded = new Uint8Array(voxels);
  for (let i = 0; i < voxels; i++) {
    eroded[i] = !outside[i] && distToOutsideSq[i] >= radiusSquared ? 1 : 0;
  }

  // Dilate the eroded set back by the same radius. Everything within `radius`
  // of surviving material is solid again, so survivors regain their thickness
  // while anything too thin to hold the ball stays gone.
  const distToErodedSq = squaredDistanceToSeeds(eroded, cells, spacing);
  for (let i = 0; i < voxels; i++) {
    // Signed distance to the opened solid, in millimetres.
    field[i] = Math.sqrt(distToErodedSq[i]) - radius;
  }
}

/** Whether a radius is large enough to be represented along every grid axis. */
export function openingIsResolvable(radius: number, spacing: Vec3): boolean {
  return radius > 0
    && spacing.every((value) => Number.isFinite(value) && value > 0)
    && radius >= Math.max(spacing[0], spacing[1], spacing[2]);
}
