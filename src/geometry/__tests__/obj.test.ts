import { describe, expect, it } from 'vitest';
import { marchingCubes } from '../marching-cubes';
import { buildIndexedMesh } from '../mesh-indexing';
import { buildObj } from '../../utils/obj';
import { DEFAULT_PARAMS } from '../../types/project';
import { SOLIDS } from './helpers';

const OPTIONS = { meshFileName: 'part.stl', params: { ...DEFAULT_PARAMS } };

describe('OBJ export', () => {
  const solid = SOLIDS.sphere(25);
  const mesh = marchingCubes(solid.sdf, solid.bounds, 32, 0);
  const text = () => new TextDecoder().decode(buildObj(mesh, OPTIONS));

  it('writes one vertex and one face line per welded element', () => {
    const indexed = buildIndexedMesh(mesh);
    const lines = text().split('\n');
    expect(lines.filter((l) => l.startsWith('v ')).length).toBe(indexed.vertexCount);
    expect(lines.filter((l) => l.startsWith('f ')).length).toBe(indexed.triangleCount);
  });

  it('uses 1-based indices, as the format requires', () => {
    const faces = text().split('\n').filter((l) => l.startsWith('f '));
    const indices = faces.flatMap((l) => l.slice(2).split(' ').map(Number));
    expect(Math.min(...indices)).toBeGreaterThanOrEqual(1);
  });

  it('keeps every index inside the vertex list', () => {
    const lines = text().split('\n');
    const vertexCount = lines.filter((l) => l.startsWith('v ')).length;
    for (const line of lines.filter((l) => l.startsWith('f '))) {
      for (const index of line.slice(2).split(' ').map(Number)) {
        expect(index).toBeGreaterThanOrEqual(1);
        expect(index).toBeLessThanOrEqual(vertexCount);
      }
    }
  });

  it('records the unit in a comment, since OBJ cannot declare one', () => {
    expect(text()).toContain('# units: millimeters');
  });

  it('keeps untrusted source names inside a single comment record', () => {
    const malicious = new TextDecoder().decode(buildObj(mesh, {
      ...OPTIONS,
      meshFileName: 'part.stl\nv 999 999 999\nmtllib https://attacker.example/file.mtl',
    }));
    const lines = malicious.split('\n');
    expect(lines[1]).toBe('# source: part.stl\\nv 999 999 999\\nmtllib https://attacker.example/file.mtl');
    expect(lines.filter((line) => line.startsWith('v '))).toHaveLength(buildIndexedMesh(mesh).vertexCount);
    expect(lines).not.toContain('mtllib https://attacker.example/file.mtl');
  });
});
