import { describe, expect, it, vi } from 'vitest';
import { generationSampleCount, MAX_GENERATION_FIELD_SAMPLES, assertGenerationOutputBudget } from './generation-limits';
import { MAX_MESH_TRIANGLES } from './mesh-limits';
import { sampleSdfField, marchingCubesFromField } from './marching-cubes';
import type { Vec3 } from './vec3';

const bounds = { min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 };

describe('generation allocation budgets', () => {
  it('rejects malformed and oversized grids before evaluating the SDF', () => {
    const sdf = vi.fn(() => -1);
    for (const cells of [[NaN, 4, 4], [Infinity, 4, 4], [-1, 4, 4], [0, 4, 4], [1.5, 4, 4], [1000, 1000, 1000]]) {
      expect(() => sampleSdfField(sdf, bounds, cells as Vec3)).toThrow(/grid/);
      expect(() => marchingCubesFromField(new Float32Array(0), bounds, cells as Vec3)).toThrow(/grid/);
    }
    expect(sdf).not.toHaveBeenCalled();
  });

  it('preserves all supported grid settings and accepts exact policy boundaries', () => {
    expect(generationSampleCount([264, 264, 264])).toBe(MAX_GENERATION_FIELD_SAMPLES);
    expect(() => generationSampleCount([265, 264, 264])).toThrow(/memory limit/);
    expect(() => assertGenerationOutputBudget(MAX_MESH_TRIANGLES)).not.toThrow();
    expect(() => assertGenerationOutputBudget(MAX_MESH_TRIANGLES + 1)).toThrow(/memory limit/);
    expect(() => assertGenerationOutputBudget(1, MAX_MESH_TRIANGLES * 12, 1)).toThrow(/memory limit/);
    const field = sampleSdfField((x) => x - 0.5, bounds, [4, 4, 4]);
    expect(field).toHaveLength(125);
    expect(marchingCubesFromField(field, bounds, [4, 4, 4]).triCount).toBeGreaterThan(0);
  });

  it('refuses a dense alternating field before allocating its oversized triangle output', () => {
    const cells = 120;
    const field = new Float32Array((cells + 1) ** 3);
    for (let i = 0; i < field.length; i++) field[i] = i % 2 ? -1 : 1;
    expect(() => marchingCubesFromField(field, bounds, [cells, cells, cells])).toThrow(/triangle memory limit/);
  });
});
