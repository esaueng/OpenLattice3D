import { describe, expect, it } from 'vitest';
import { generateCubeMesh } from '../geometry/mesh-analysis';
import { DEFAULT_IMPORT_LIMITS, estimateDecodedBase64Bytes } from '../geometry/mesh-limits';
import { DEFAULT_PARAMS } from '../types/project';
import { createProjectFile, meshFingerprint, parseProjectFile } from './project-file';

function cubeProject() {
  return createProjectFile({
    params: DEFAULT_PARAMS,
    generationSeed: 123,
    source: { kind: 'mesh', fileName: 'cube.stl', mesh: generateCubeMesh(10) },
    keepOutTris: new Set(),
    keepInTris: new Set(),
    validation: null,
    clipPlane: { axis: 'z', position: 0.5, flipped: false },
    viewerBackground: '#000000',
  });
}

describe('OpenLattice3D project files', () => {
  it('round-trips an embedded mesh, parameters, and bound selection masks', () => {
    const mesh = generateCubeMesh(30);
    const exported = createProjectFile({
      params: { ...DEFAULT_PARAMS, cellSize: 12, escapeHoleAxis: 'x' },
      generationSeed: 123,
      source: { kind: 'mesh', fileName: 'cube.stl', mesh },
      keepOutTris: new Set([1, 3, 5]),
      keepInTris: new Set([2]),
      validation: null,
      clipPlane: { axis: 'y', position: 0.25, flipped: true },
      viewerBackground: '#112233',
    });

    const restored = parseProjectFile(exported);
    expect(exported.reproducibility).toEqual({
      prng: 'mulberry32-fnv1a-v1',
      seedVersion: 1,
      seed: 123,
    });
    expect(restored.kind).toBe('project');
    if (restored.kind !== 'project') return;
    expect(restored.params.cellSize).toBe(12);
    expect(restored.generationSeed).toBe(123);
    expect(restored.params.escapeHoleAxis).toBe('x');
    expect(restored.meshFileName).toBe('cube.stl');
    expect(restored.originalMesh?.positions).toEqual(mesh.positions);
    expect(meshFingerprint(restored.originalMesh!)).toBe(meshFingerprint(mesh));
    expect(restored.keepOutTris).toEqual([1, 3, 5]);
    expect(restored.keepInTris).toEqual([2]);
    expect(restored.clipPlane).toEqual({ axis: 'y', position: 0.25, flipped: true });
    expect(restored.viewerBackground).toBe('#112233');
  });

  it('discards selection masks when their fingerprint is altered', () => {
    const mesh = generateCubeMesh(10);
    const exported = createProjectFile({
      params: DEFAULT_PARAMS,
      generationSeed: 123,
      source: { kind: 'mesh', fileName: 'cube.stl', mesh },
      keepOutTris: new Set([0]),
      keepInTris: new Set([1]),
      validation: null,
      clipPlane: { axis: 'z', position: 0.5, flipped: false },
      viewerBackground: '#000000',
    });
    (exported.selectionMask as Record<string, unknown>).meshFingerprint = '00000000';
    const restored = parseProjectFile(exported);
    expect(restored.kind).toBe('project');
    if (restored.kind !== 'project') return;
    expect(restored.keepOutTris).toEqual([]);
    expect(restored.keepInTris).toEqual([]);
    expect(restored.warnings.join(' ')).toMatch(/fingerprint/);
  });

  it('keeps legacy parameter-only JSON importable', () => {
    const restored = parseProjectFile({ parameters: { latticeType: 'bcc', cellSize: 9 } });
    expect(restored.kind).toBe('parameters');
    if (restored.kind !== 'parameters') return;
    expect(restored.params).toEqual({ latticeType: 'bcc', cellSize: 9 });
  });

  it('migrates version 2 projects to the compatibility seed', () => {
    const exported = createProjectFile({
      params: DEFAULT_PARAMS,
      generationSeed: 456,
      source: { kind: 'sample', fileName: 'cube', shape: 'cube', sphereRadius: 25 },
      keepOutTris: new Set(),
      keepInTris: new Set(),
      validation: null,
      clipPlane: { axis: 'z', position: 0.5, flipped: false },
      viewerBackground: '#000000',
    });
    exported.version = 2;
    delete exported.reproducibility;
    const restored = parseProjectFile(exported);
    expect(restored.kind).toBe('project');
    if (restored.kind !== 'project') return;
    expect(restored.generationSeed).toBe(0);
    expect(restored.warnings.join(' ')).toMatch(/legacy project/);
  });

  it('fails closed when current reproducibility metadata is malformed', () => {
    const exported = createProjectFile({
      params: DEFAULT_PARAMS,
      generationSeed: 456,
      source: { kind: 'sample', fileName: 'cube', shape: 'cube', sphereRadius: 25 },
      keepOutTris: new Set(),
      keepInTris: new Set(),
      validation: null,
      clipPlane: { axis: 'z', position: 0.5, flipped: false },
      viewerBackground: '#000000',
    });
    (exported.reproducibility as Record<string, unknown>).seedVersion = 99;
    expect(() => parseProjectFile(exported)).toThrow(/reproducibility/);
  });

  it('rejects project backgrounds that can load external CSS resources', () => {
    const exported = createProjectFile({
      params: DEFAULT_PARAMS,
      generationSeed: 123,
      source: { kind: 'sample', fileName: 'cube', shape: 'cube', sphereRadius: 25 },
      keepOutTris: new Set(),
      keepInTris: new Set(),
      validation: null,
      clipPlane: { axis: 'z', position: 0.5, flipped: false },
      viewerBackground: '#000000',
    });
    (exported.viewer as Record<string, unknown>).background = 'url(https://attacker.example/pixel)';

    const restored = parseProjectFile(exported);
    expect(restored.kind).toBe('project');
    if (restored.kind !== 'project') return;
    expect(restored.viewerBackground).toBeUndefined();
    expect(restored.warnings).toContain('Ignored invalid viewer background color');
  });
});

describe('project embedded-mesh budgets', () => {
  it('accepts an embedded mesh at the decoded-byte budget and rejects one byte under', () => {
    const exported = cubeProject();
    const encoded = (exported.source as { data: string }).data;
    // 12 triangles -> 684 decoded bytes; the base64 estimate is exact here.
    const decodedBytes = 684;
    expect(estimateDecodedBase64Bytes(encoded.length)).toBe(decodedBytes);

    const atBudget = { ...DEFAULT_IMPORT_LIMITS, maxEmbeddedStlBytes: decodedBytes };
    const restored = parseProjectFile(exported, atBudget);
    expect(restored.kind).toBe('project');
    if (restored.kind !== 'project') return;
    expect(restored.originalMesh?.triCount).toBe(12);

    const oneUnder = { ...DEFAULT_IMPORT_LIMITS, maxEmbeddedStlBytes: decodedBytes - 1 };
    expect(() => parseProjectFile(exported, oneUnder)).toThrow(/decodes to more than/);
  });

  it('rejects oversized base64 before atob() runs', () => {
    const exported = cubeProject();
    // Invalid base64: if the budget check did not run first, atob() would
    // throw an InvalidCharacterError instead of the limit error.
    (exported.source as Record<string, unknown>).data = '!'.repeat(64);
    const limits = { ...DEFAULT_IMPORT_LIMITS, maxEmbeddedStlBytes: 8 };
    expect(() => parseProjectFile(exported, limits)).toThrow(/decodes to more than the 8 B import limit/);
  });

  it('counts whitespace toward the conservative estimate but decodes what passes', () => {
    const exported = cubeProject();
    const encoded = (exported.source as { data: string }).data;
    (exported.source as Record<string, unknown>).data = `${encoded.slice(0, 8)}  ${encoded.slice(8)}`;
    // 914 encoded chars -> 687-byte estimate: rejected at a 684-byte budget...
    const tight = { ...DEFAULT_IMPORT_LIMITS, maxEmbeddedStlBytes: 684 };
    expect(() => parseProjectFile(exported, tight)).toThrow(/decodes to more than/);
    // ...and accepted once the budget covers the estimate, because atob()
    // strips the whitespace and the post-decode check sees the true 684 bytes.
    const padded = { ...DEFAULT_IMPORT_LIMITS, maxEmbeddedStlBytes: 687 };
    const restored = parseProjectFile(exported, padded);
    expect(restored.kind).toBe('project');
  });
});
