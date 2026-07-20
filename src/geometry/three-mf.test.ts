import { describe, expect, it } from 'vitest';
import { generateCubeMesh } from './mesh-analysis';
import { build3MFModelXml, create3MF } from './three-mf';

describe('3MF export', () => {
  const cube = generateCubeMesh(30);

  it('emits millimetre metadata and indexed cube vertices', () => {
    const xml = build3MFModelXml(cube);
    expect(xml).toContain('unit="millimeter"');
    expect(xml.match(/<vertex /g)).toHaveLength(8);
    expect(xml.match(/<triangle /g)).toHaveLength(12);
  });

  it('packages required 3MF parts in a ZIP container', () => {
    const packageBytes = create3MF(cube);
    const view = new DataView(packageBytes.buffer, packageBytes.byteOffset, packageBytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(packageBytes.length - 22, true)).toBe(0x06054b50);
    const packageText = new TextDecoder().decode(packageBytes);
    expect(packageText).toContain('[Content_Types].xml');
    expect(packageText).toContain('_rels/.rels');
    expect(packageText).toContain('3D/3dmodel.model');
    expect(packageText).toContain('application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
  });

  it('rejects non-finite coordinates', () => {
    const invalid = { ...cube, positions: new Float32Array(cube.positions) };
    invalid.positions[0] = Number.NaN;
    expect(() => create3MF(invalid)).toThrow(/non-finite/);
  });
});
