import { describe, expect, it } from 'vitest';
import { buildSphereLattice } from './lattice';
import { marchingCubes, type MarchingCubesResult } from './marching-cubes';
import { DEFAULT_PARAMS } from '../types/project';
import { createProjectFile, parseProjectFile } from '../utils/project-file';

function geometryHash(result: MarchingCubesResult): string {
  let hash = 2166136261;
  const update = (value: number) => {
    hash = Math.imul((hash ^ value) >>> 0, 16777619) >>> 0;
  };
  for (let shift = 0; shift < 32; shift += 8) update(result.triCount >>> shift);
  for (const array of [result.positions, result.normals]) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (const byte of bytes) update(byte);
  }
  return hash.toString(16).padStart(8, '0');
}

function generateSpinodal(seed: number): MarchingCubesResult {
  const params = {
    ...DEFAULT_PARAMS,
    latticeType: 'spinodal' as const,
    noShell: true,
    shellThickness: 0,
    cellSize: 9,
    wallThickness: 1.2,
  };
  return marchingCubes(
    buildSphereLattice(12, params, seed),
    { min: [-16, -16, -16], max: [16, 16, 16] },
    18,
  );
}

describe('generation reproducibility', () => {
  it('produces identical geometry hashes on repeated runs with the same seed', () => {
    const first = generateSpinodal(0x10203040);
    const second = generateSpinodal(0x10203040);
    expect(first.positions).toEqual(second.positions);
    expect(first.normals).toEqual(second.normals);
    expect(geometryHash(first)).toBe(geometryHash(second));
  });

  it('changes stochastic geometry after an explicit reseed', () => {
    expect(geometryHash(generateSpinodal(11))).not.toBe(geometryHash(generateSpinodal(12)));
  });

  it('preserves deterministic regeneration through project export and import', () => {
    const seed = 0xdecafbad;
    const project = createProjectFile({
      params: { ...DEFAULT_PARAMS, latticeType: 'spinodal', noShell: true, shellThickness: 0 },
      generationSeed: seed,
      source: { kind: 'sample', fileName: 'sphere', shape: 'sphere', sphereRadius: 12 },
      keepOutTris: new Set(),
      keepInTris: new Set(),
      validation: null,
      clipPlane: { axis: 'z', position: 0.5, flipped: false },
      viewerBackground: '#000000',
    });
    const restored = parseProjectFile(JSON.parse(JSON.stringify(project)));
    expect(restored.kind).toBe('project');
    if (restored.kind !== 'project') return;
    const before = marchingCubes(
      buildSphereLattice(12, project.parameters as typeof restored.params, seed),
      { min: [-16, -16, -16], max: [16, 16, 16] },
      18,
    );
    const after = marchingCubes(
      buildSphereLattice(12, restored.params, restored.generationSeed),
      { min: [-16, -16, -16], max: [16, 16, 16] },
      18,
    );
    expect(restored.generationSeed).toBe(seed);
    expect(geometryHash(after)).toBe(geometryHash(before));
  });
});
