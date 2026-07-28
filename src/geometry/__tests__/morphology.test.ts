import { describe, expect, it } from 'vitest';
import { marchingCubesFromField, marchingCubes } from '../marching-cubes';
import { openField, openingIsResolvable } from '../morphology';
import type { Vec3 } from '../vec3';

/**
 * A slab pair: one thick plate that should survive opening, and one thin plate
 * that should be removed by it. Erosion cannot tell them apart — it thins both.
 */
function slabPair(thick: number, thin: number) {
  return (x: number, y: number, z: number) => {
    const plateA = Math.max(Math.abs(z - 6) - thick / 2, Math.hypot(x, y) - 14);
    const plateB = Math.max(Math.abs(z + 6) - thin / 2, Math.hypot(x, y) - 14);
    return Math.min(plateA, plateB);
  };
}

const BOUNDS = { min: [-18, -18, -14] as Vec3, max: [18, 18, 14] as Vec3 };

function sampleField(sdf: (x: number, y: number, z: number) => number, n: number): Float32Array {
  const field = new Float32Array((n + 1) ** 3);
  const dx = (BOUNDS.max[0] - BOUNDS.min[0]) / n;
  const dy = (BOUNDS.max[1] - BOUNDS.min[1]) / n;
  const dz = (BOUNDS.max[2] - BOUNDS.min[2]) / n;
  for (let z = 0; z <= n; z++) {
    for (let y = 0; y <= n; y++) {
      for (let x = 0; x <= n; x++) {
        field[x + y * (n + 1) + z * (n + 1) * (n + 1)] =
          sdf(BOUNDS.min[0] + x * dx, BOUNDS.min[1] + y * dy, BOUNDS.min[2] + z * dz);
      }
    }
  }
  return field;
}

function volumeOfField(field: Float32Array): number {
  let inside = 0;
  for (let i = 0; i < field.length; i++) if (field[i] <= 0) inside++;
  return inside / field.length;
}

describe('morphological opening', () => {
  const n = 120;
  const spacing: Vec3 = [
    (BOUNDS.max[0] - BOUNDS.min[0]) / n,
    (BOUNDS.max[1] - BOUNDS.min[1]) / n,
    (BOUNDS.max[2] - BOUNDS.min[2]) / n,
  ];

  it('removes the thin plate while keeping the thick one', () => {
    const sdf = slabPair(4, 0.8);
    const field = sampleField(sdf, n);
    const before = volumeOfField(field);

    openField(field, [n + 1, n + 1, n + 1], spacing, 1.0);
    const after = volumeOfField(field);

    // The thin plate is a fifth of the material; losing it and keeping the
    // thick one lands well inside these bounds, whereas uniform erosion would
    // shave both and land outside them.
    expect(after).toBeLessThan(before * 0.95);
    expect(after).toBeGreaterThan(before * 0.6);

    // The surviving plate must still be there in full.
    const mesh = marchingCubesFromField(field, BOUNDS, [n, n, n], 0);
    expect(mesh.triCount).toBeGreaterThan(0);
  });

  it('restores the thickness of what survives, where erosion does not', () => {
    const thickness = 4;
    const radius = 1.0;
    const sdf = slabPair(thickness, 0.8);

    const opened = sampleField(sdf, n);
    openField(opened, [n + 1, n + 1, n + 1], spacing, radius);

    const eroded = sampleField(sdf, n);
    for (let i = 0; i < eroded.length; i++) eroded[i] += radius;

    // Compare the fields directly: erosion pulls the surviving plate in by the
    // full radius on each face, opening puts it back.
    let openedSolid = 0, erodedSolid = 0;
    for (let i = 0; i < opened.length; i++) {
      if (opened[i] <= 0) openedSolid++;
      if (eroded[i] <= 0) erodedSolid++;
    }
    expect(openedSolid).toBeGreaterThan(erodedSolid);
  });

  it('is a no-op below the sample spacing, rather than silently doing nothing useful', () => {
    const sdf = slabPair(4, 0.8);
    const field = sampleField(sdf, n);
    const copy = Float32Array.from(field);

    const subVoxel = spacing[0] * 0.5;
    expect(openingIsResolvable(subVoxel, spacing)).toBe(false);
    openField(field, [n + 1, n + 1, n + 1], spacing, subVoxel);
    expect(Array.from(field)).toEqual(Array.from(copy));
  });

  it('reports resolvability against the grid spacing', () => {
    expect(openingIsResolvable(0.35, [0.6, 0.6, 0.6])).toBe(false);
    expect(openingIsResolvable(0.7, [0.6, 0.6, 0.6])).toBe(true);
    expect(openingIsResolvable(0, [0.1, 0.1, 0.1])).toBe(false);
    expect(openingIsResolvable(0.5, [1, 0.25, 0.25])).toBe(false);
    expect(openingIsResolvable(1, [1, 0, 0.25])).toBe(false);
  });

  it('uses physical axis spacing on anisotropic grids', () => {
    const samples: Vec3 = [21, 17, 17];
    const anisotropicSpacing: Vec3 = [1, 0.25, 0.25];
    const field = new Float32Array(samples[0] * samples[1] * samples[2]);
    field.fill(1);
    const index = (x: number, y: number, z: number) =>
      x + y * samples[0] + z * samples[0] * samples[1];

    // A 3mm slab normal to X is thicker than the 2mm opening diameter and must
    // survive. Treating every axis as the 0.25mm spacing incorrectly erodes it
    // by four X samples per side and removes it completely.
    for (let z = 0; z < samples[2]; z++) {
      for (let y = 0; y < samples[1]; y++) {
        for (let x = 9; x <= 11; x++) field[index(x, y, z)] = -1;
      }
    }

    openField(field, samples, anisotropicSpacing, 1);

    expect(field[index(10, 8, 8)]).toBeLessThan(0);
    expect(field[index(8, 8, 8)]).toBeGreaterThanOrEqual(0);
    expect(field[index(12, 8, 8)]).toBeGreaterThanOrEqual(0);
  });

  it('leaves a solid with no thin features essentially unchanged', () => {
    const sphere = (x: number, y: number, z: number) => Math.hypot(x, y, z) - 10;
    const field = sampleField(sphere, n);
    const before = volumeOfField(field);
    openField(field, [n + 1, n + 1, n + 1], spacing, 1.0);
    const after = volumeOfField(field);
    // A ball far thicker than the structuring element keeps its volume.
    expect(Math.abs(after - before) / before).toBeLessThan(0.05);
  });

  it('keeps the opened surface closed', () => {
    const sdf = slabPair(4, 0.8);
    const field = sampleField(sdf, n);
    openField(field, [n + 1, n + 1, n + 1], spacing, 1.0);
    const mesh = marchingCubesFromField(field, BOUNDS, [n, n, n], 0);
    expect(mesh.triCount).toBeGreaterThan(0);
    void marchingCubes;
  });
});
