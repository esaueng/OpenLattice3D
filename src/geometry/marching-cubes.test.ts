import { describe, expect, it } from 'vitest';
import { marchingCubes, marchingCubesFromField } from './marching-cubes';
import { checkTopology } from './validation';
import type { Vec3 } from './vec3';

const SPHERE_R = 10;
const sphereSdf = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z) - SPHERE_R;
const bounds = { min: [-12, -12, -12] as Vec3, max: [12, 12, 12] as Vec3 };

describe('marchingCubes', () => {
  it('extracts a closed, manifold, single-component sphere surface', () => {
    const result = marchingCubes(sphereSdf, bounds, 24);
    expect(result.triCount).toBeGreaterThan(100);
    expect(result.positions.length).toBe(result.triCount * 9);
    expect(result.normals.length).toBe(result.triCount * 3);

    const { manifold, disconnected } = checkTopology(result);
    expect(manifold.passed).toBe(true);
    expect(disconnected.fragmentCount).toBe(1);
  });

  it('places all vertices near the iso-surface', () => {
    const result = marchingCubes(sphereSdf, bounds, 24);
    const cellDiag = Math.sqrt(3) * (24 / 24);
    for (let i = 0; i < result.positions.length; i += 3) {
      const r = Math.hypot(result.positions[i], result.positions[i + 1], result.positions[i + 2]);
      expect(Math.abs(r - SPHERE_R)).toBeLessThan(cellDiag);
    }
  });

  it('produces outward-facing normals for an SDF (negative inside)', () => {
    const result = marchingCubes(sphereSdf, bounds, 16);
    let outward = 0;
    for (let i = 0; i < result.triCount; i++) {
      const o = i * 9;
      const cx = (result.positions[o] + result.positions[o + 3] + result.positions[o + 6]) / 3;
      const cy = (result.positions[o + 1] + result.positions[o + 4] + result.positions[o + 7]) / 3;
      const cz = (result.positions[o + 2] + result.positions[o + 5] + result.positions[o + 8]) / 3;
      const dot = cx * result.normals[i * 3] + cy * result.normals[i * 3 + 1] + cz * result.normals[i * 3 + 2];
      if (dot > 0) outward++;
    }
    expect(outward).toBe(result.triCount);
  });

  it('returns an empty mesh when the field never crosses the iso-value', () => {
    const result = marchingCubes(() => 1, bounds, 8);
    expect(result.triCount).toBe(0);
  });

  it('reports monotonically non-decreasing progress', () => {
    const seen: number[] = [];
    marchingCubes(sphereSdf, bounds, 12, 0, (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(1);
  });
});

describe('marchingCubesFromField', () => {
  it('rejects fields whose length does not match the cell grid', () => {
    expect(() => marchingCubesFromField(new Float32Array(10), bounds, [4, 4, 4])).toThrow(/does not match/);
  });

  it('matches the direct sampling path', () => {
    const n = 12;
    const field = new Float32Array((n + 1) ** 3);
    const d = 24 / n;
    let idx = 0;
    for (let z = 0; z <= n; z++) {
      for (let y = 0; y <= n; y++) {
        for (let x = 0; x <= n; x++) {
          field[idx++] = sphereSdf(-12 + x * d, -12 + y * d, -12 + z * d);
        }
      }
    }
    const fromField = marchingCubesFromField(field, bounds, [n, n, n]);
    const direct = marchingCubes(sphereSdf, bounds, n);
    expect(fromField.triCount).toBe(direct.triCount);
    expect(Array.from(fromField.positions)).toEqual(Array.from(direct.positions));
  });
});
