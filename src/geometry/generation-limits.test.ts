import { describe, expect, it, vi } from 'vitest';
import {
  assertGenerationGrid,
  assertGenerationOutputBudget,
  BYTES_PER_OUTPUT_TRIANGLE,
  conservativeGenerationTriangles,
  estimatedGenerationTriangles,
  estimateGenerationMemoryBytes,
  expectedGenerationPath,
  fullFieldRequirement,
  generationSampleCount,
  gridForResolutionLevel,
  MAX_EXPORT_RESOLUTION_LEVEL,
  MAX_GENERATION_FIELD_SAMPLES,
  MAX_SINGLE_GENERATION_GRID,
  MAX_TILED_GENERATION_GRID,
  maxGenerationGrid,
  maxResolutionLevel,
  TILED_GENERATION_GRID_CEILING,
} from './generation-limits';
import { DEFAULT_PARAMS, sanitizeLatticeParams, type LatticeParams } from '../types/project';
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

describe('path-aware generation limits', () => {
  it('keeps the old cap for the single-field path and derives the tiled cap from the triangle budget', () => {
    expect(maxGenerationGrid('cpu-single')).toBe(MAX_SINGLE_GENERATION_GRID);
    expect((MAX_SINGLE_GENERATION_GRID + 1) ** 3).toBe(MAX_GENERATION_FIELD_SAMPLES);
    // floor(sqrt(5M / (44 x 1.15))) = 314, under the 512 scheduling ceiling.
    expect(maxGenerationGrid('cpu-tiled')).toBe(314);
    expect(MAX_TILED_GENERATION_GRID).toBeLessThanOrEqual(TILED_GENERATION_GRID_CEILING);
    expect(conservativeGenerationTriangles(MAX_TILED_GENERATION_GRID)).toBeLessThanOrEqual(MAX_MESH_TRIANGLES);
    expect(conservativeGenerationTriangles(MAX_TILED_GENERATION_GRID + 1)).toBeGreaterThan(MAX_MESH_TRIANGLES);
    expect(maxResolutionLevel('cpu-single')).toBe(10);
    expect(maxResolutionLevel('cpu-tiled')).toBe(12);
    expect(MAX_EXPORT_RESOLUTION_LEVEL).toBe(12);
    expect(gridForResolutionLevel(12)).toBeLessThanOrEqual(MAX_TILED_GENERATION_GRID);
  });

  it('accepts each path up to its limit and rejects beyond it with the reason', () => {
    expect(assertGenerationGrid([264, 264, 264], 'cpu-single')).toBe(265 ** 3);
    expect(() => assertGenerationGrid([288, 288, 288], 'cpu-single', 'thin-feature removal needs the whole field in memory'))
      .toThrow(/288³ generation grid exceeds the 264³ memory limit for single-worker generation \(thin-feature removal/);
    expect(assertGenerationGrid([314, 314, 314], 'cpu-tiled')).toBe(315 ** 3);
    expect(() => assertGenerationGrid([315, 315, 315], 'cpu-tiled'))
      .toThrow(/315³ generation grid exceeds the 314³ memory limit for tiled generation \(up to about 5\.0 M triangles/);
    for (const cells of [[NaN, 4, 4], [0, 4, 4], [1.5, 4, 4]]) {
      expect(() => assertGenerationGrid(cells as Vec3, 'cpu-tiled')).toThrow(/positive finite integers/);
    }
    // A tile field is still bounded by the single-allocation cap.
    expect(() => generationSampleCount([288, 288, 288])).toThrow(/memory limit/);
  });

  it('forces the single-field path only for whole-field features', () => {
    expect(fullFieldRequirement(DEFAULT_PARAMS)).toBeNull();
    expect(expectedGenerationPath(DEFAULT_PARAMS)).toBe('cpu-tiled');
    // Escape holes are cut per tile and do not need the whole field.
    const withHoles: LatticeParams = { ...DEFAULT_PARAMS, escapeHoles: true };
    expect(expectedGenerationPath(withHoles)).toBe('cpu-tiled');
    expect(fullFieldRequirement({ ...DEFAULT_PARAMS, thinSectionFilter: 0.8 })).toMatch(/thin-feature/);
    expect(expectedGenerationPath({ ...DEFAULT_PARAMS, variant: 'implicit_conformal', latticeType: 'hexagon' })).toBe('cpu-single');
    expect(expectedGenerationPath({ ...DEFAULT_PARAMS, variant: 'implicit_conformal', latticeType: 'triangle' })).toBe('cpu-single');
    expect(expectedGenerationPath({ ...DEFAULT_PARAMS, variant: 'implicit_conformal', latticeType: 'gyroid' })).toBe('cpu-tiled');
  });

  it('estimates memory from the field the path allocates plus the output', () => {
    const triangles = estimatedGenerationTriangles(264);
    expect(estimateGenerationMemoryBytes(264, 'cpu-single', triangles)).toBe(265 ** 3 * 4 + triangles * BYTES_PER_OUTPUT_TRIANGLE);
    expect(estimateGenerationMemoryBytes(264, 'cpu-tiled', triangles)).toBe(8 * 33 ** 3 * 4 + triangles * BYTES_PER_OUTPUT_TRIANGLE);
    // About 0.9 GB at the highest tiled level.
    expect(estimateGenerationMemoryBytes(312, 'cpu-tiled', estimatedGenerationTriangles(312)) / 1e9).toBeCloseTo(0.9, 1);
  });

  it('lets saved settings and project files keep every offered resolution level', () => {
    expect(sanitizeLatticeParams({ exportResolution: MAX_EXPORT_RESOLUTION_LEVEL }).params.exportResolution).toBe(12);
    expect(sanitizeLatticeParams({ exportResolution: MAX_EXPORT_RESOLUTION_LEVEL + 1 }).rejected).toEqual(['exportResolution']);
  });
});
