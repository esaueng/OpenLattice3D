import { describe, expect, it } from 'vitest';
import { classifyModelFile, dragCarriesFiles, isMeshFileKind, MESH_FILE_ACCEPT, pickDroppedFile } from './dropped-files';

describe('dropped files', () => {
  it('classifies by extension, case-insensitively', () => {
    expect(classifyModelFile('Part.STL')).toBe('stl');
    expect(classifyModelFile('bracket.stl ')).toBe('stl');
    expect(classifyModelFile('study.json')).toBe('project');
    expect(classifyModelFile('mesh.OBJ')).toBe('obj');
    expect(classifyModelFile('plate.3mf')).toBe('3mf');
    expect(classifyModelFile('part.step')).toBeNull();
    expect(classifyModelFile('stl')).toBeNull();
    expect(classifyModelFile('3mf')).toBeNull();
  });

  it('offers exactly the mesh extensions it classifies', () => {
    for (const extension of MESH_FILE_ACCEPT.split(',')) expect(isMeshFileKind(classifyModelFile(`part${extension}`))).toBe(true);
    expect(isMeshFileKind(classifyModelFile('part.json'))).toBe(false);
  });

  it('prefers a mesh, then a project, then reports the first file', () => {
    expect(pickDroppedFile([{ name: 'a.json' }, { name: 'b.stl' }])?.name).toBe('b.stl');
    expect(pickDroppedFile([{ name: 'a.json' }, { name: 'b.3mf' }, { name: 'c.stl' }])?.name).toBe('b.3mf');
    expect(pickDroppedFile([{ name: 'a.png' }, { name: 'b.obj' }])?.name).toBe('b.obj');
    expect(pickDroppedFile([{ name: 'a.png' }, { name: 'b.json' }])?.name).toBe('b.json');
    expect(pickDroppedFile([{ name: 'a.png' }])?.name).toBe('a.png');
    expect(pickDroppedFile([])).toBeNull();
  });

  it('only reacts to drags that carry files', () => {
    expect(dragCarriesFiles(['Files'])).toBe(true);
    expect(dragCarriesFiles(['text/plain', 'text/uri-list'])).toBe(false);
    expect(dragCarriesFiles(undefined)).toBe(false);
  });
});
