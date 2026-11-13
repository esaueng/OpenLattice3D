import { describe, expect, it } from 'vitest';
import { computeSignedVolume, countNormalWindingAgreement, generateCubeMesh, generateTorusMesh } from './mesh-analysis';
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from './mesh-limits';
import { parseOBJ } from './obj-parser';
import { buildObj } from '../utils/obj';
import { DEFAULT_PARAMS } from '../types/project';

const encode = (text: string) => new TextEncoder().encode(text);
const limits = (overrides: Partial<ImportLimits>): ImportLimits => ({ ...DEFAULT_IMPORT_LIMITS, ...overrides });

describe('OBJ import', () => {
  it('reads back the repo OBJ writer output with identical geometry', () => {
    for (const mesh of [generateCubeMesh(30), generateTorusMesh(20, 6, 24, 12)]) {
      const parsed = parseOBJ(buildObj(mesh, { meshFileName: 'part.stl', params: DEFAULT_PARAMS, generationSeed: 7 }));
      expect(parsed.mesh.triCount).toBe(mesh.triCount);
      // The writer prints exact float32 values, so the round trip is exact.
      expect(parsed.mesh.positions).toEqual(mesh.positions);
      expect(countNormalWindingAgreement(parsed.mesh).disagree).toBe(0);
      expect(parsed.warnings).toEqual([]);
    }
  });

  it('fan-triangulates polygons and accepts every index form, ignoring other statements', () => {
    const text = [
      '# unit cube as quads', 'mtllib part.mtl', 'o cube', 'g sides', 's 1', 'usemtl steel',
      'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'v 0 0 1 1.0', 'v 1 0 1 0.2 0.3 0.4', 'v 1 1 1', 'v 0 1 1',
      'vt 0 0', 'vt 1 0', 'vt 1 1', 'vn 0 0 1',
      'f 1 4 3 2', // bottom
      'f 5/1 6/2 7/3 8/1', // top
      'f 1//1 2//1 6//1 5//1', // front
      'f 2/2/1 3/3/1 7/1/1 6/2/1', // right
      'f 3 4 \\', '  8 7', // back, continued onto the next line
      'f -8 -4 -1 -5 # left, relative', 'l 1 2', 'p 3',
    ].join('\r\n');
    const parsed = parseOBJ(encode(text));
    expect(parsed.mesh.triCount).toBe(12);
    expect(parsed.polygonFaces).toBe(6);
    expect(parsed.warnings).toEqual(['Triangulated 6 polygon face(s) with more than three corners.']);
    expect(computeSignedVolume(parsed.mesh)).toBeCloseTo(1, 6);
    expect(countNormalWindingAgreement(parsed.mesh).disagree).toBe(0);
  });

  it('resolves negative indices relative to the vertices read so far', () => {
    const parsed = parseOBJ(encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\nv 5 5 5\nf -4 -3 -1\n'));
    expect(Array.from(parsed.mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 5, 5]);
    // Normals come from winding: the first face points +Z.
    expect(Array.from(parsed.mesh.normals.subarray(0, 3))).toEqual([0, 0, 1]);
  });

  it('allows forward positive references and drops degenerate fan triangles', () => {
    const parsed = parseOBJ(encode('f 1 2 3 3\nv 0 0 0\nv 1 0 0\nv 0 1 0\n'));
    expect(parsed.mesh.triCount).toBe(1);
    expect(parsed.warnings).toContain('Dropped 1 triangle(s) that repeat a vertex.');
  });

  it('rejects malformed input with line numbers', () => {
    const cases: [string, RegExp][] = [
      ['v 0 0 0\nv 1 0 0\nv 0 1 0\n', /no faces/],
      ['v 0 0\n', /line 1: vertex needs x, y and z/],
      ['v 0 0 0\nv 1 nan 0\n', /line 2: invalid vertex coordinate "nan"/],
      ['v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2\n', /line 4: face needs at least three vertices/],
      ['v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2\n', /invalid face vertex reference "0"/],
      ['v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 x/1\n', /invalid face vertex reference "x\/1"/],
      ['v 0 0 0\nv 1 0 0\nv 0 1 0\nf -4 -2 -1\n', /only 3 vertices precede it/],
      ['v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n', /refers to vertex 9, but the file defines 3/],
      ['v 0 0 0\nv 1e7 0 0\nv 0 1 0\nf 1 2 3\n', /coordinate/],
    ];
    for (const [text, error] of cases) expect(() => parseOBJ(encode(text))).toThrow(error);
  });

  it('enforces byte, vertex and triangle limits', () => {
    const quad = encode('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
    expect(() => parseOBJ(quad, limits({ maxObjBytes: quad.length - 1 }))).toThrow(/exceeding the .* import limit/);
    expect(parseOBJ(quad, limits({ maxObjBytes: quad.length })).mesh.triCount).toBe(2);
    expect(() => parseOBJ(quad, limits({ maxVertices: 3 }))).toThrow(/vertex count exceeds the supported limit of 3/);
    expect(() => parseOBJ(quad, limits({ maxTriangles: 1 }))).toThrow(/triangle count exceeds the supported limit of 1/);
  });
});
