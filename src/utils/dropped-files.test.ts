import { describe, expect, it } from 'vitest';
import { classifyModelFile, dragCarriesFiles, pickDroppedFile } from './dropped-files';

describe('dropped files', () => {
  it('classifies by extension, case-insensitively', () => {
    expect(classifyModelFile('Part.STL')).toBe('stl');
    expect(classifyModelFile('bracket.stl ')).toBe('stl');
    expect(classifyModelFile('study.json')).toBe('project');
    expect(classifyModelFile('mesh.obj')).toBeNull();
    expect(classifyModelFile('stl')).toBeNull();
  });

  it('prefers an STL, then a project, then reports the first file', () => {
    expect(pickDroppedFile([{ name: 'a.json' }, { name: 'b.stl' }])?.name).toBe('b.stl');
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
