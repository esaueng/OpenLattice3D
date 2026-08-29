// Wavefront OBJ export.
//
// Indexed and human-readable, which makes it the useful interchange format when
// something downstream cannot read 3MF. Like STL it carries no unit, so 3MF
// remains the right default for anything heading to a printer.
import { buildIndexedMesh } from '../geometry/mesh-indexing';
import type { IndexedMesh } from '../geometry/mesh-indexing';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { LatticeParams } from '../types/project';
import { escapeControlCharacters } from './text-safety';
import { formatGenerationSeed } from '../geometry/deterministic-random';

function coord(value: number): string {
  return Number(value.toFixed(4)).toString();
}

export interface ObjOptions {
  meshFileName: string;
  params: LatticeParams;
  generationSeed?: number;
}

export function buildObj(
  source: MarchingCubesResult | IndexedMesh,
  options: ObjOptions
): Uint8Array {
  const mesh = 'indices' in source ? source : buildIndexedMesh(source);
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push(encoder.encode(buffer.join('')));
    buffer = [];
  };
  const write = (text: string) => {
    buffer.push(text);
    if (buffer.length >= 4096) flush();
  };

  write(`# OpenLattice3D\n`);
  write(`# source: ${escapeControlCharacters(options.meshFileName || 'lattice')}\n`);
  write(`# lattice: ${options.params.latticeType}, cell ${options.params.cellSize}mm\n`);
  if (options.generationSeed !== undefined) {
    write(`# generation-seed: ${formatGenerationSeed(options.generationSeed)}\n`);
  }
  // OBJ has no unit declaration; state it in a comment so a reader at least has
  // a chance of noticing.
  write(`# units: millimeters\n`);
  write(`o lattice\n`);

  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * 3;
    write(`v ${coord(mesh.positions[o])} ${coord(mesh.positions[o + 1])} ${coord(mesh.positions[o + 2])}\n`);
  }
  // OBJ indices are 1-based.
  for (let i = 0; i < mesh.triangleCount; i++) {
    const o = i * 3;
    write(`f ${mesh.indices[o] + 1} ${mesh.indices[o + 1] + 1} ${mesh.indices[o + 2] + 1}\n`);
  }
  flush();

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
