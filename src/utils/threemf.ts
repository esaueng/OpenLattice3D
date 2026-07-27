// 3MF export.
//
// The format the AM industry actually standardised on, and it fixes the two
// things STL cannot express: it is indexed, and it carries a unit. STL is
// unitless, so a file authored in inches is indistinguishable from millimetres
// and silently scales the lattice by 25.4.
import { buildIndexedMesh } from '../geometry/mesh-indexing';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { LatticeMetrics } from '../geometry/metrics';
import type { LatticeParams, ValidationResult } from '../types/project';
import { createZip } from './zip';

const MODEL_PATH = '3D/3dmodel.model';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Trim to micron precision; beyond that is noise, and it roughly halves the file. */
function coord(value: number): string {
  return Number(value.toFixed(4)).toString();
}

export interface ThreeMfOptions {
  meshFileName: string;
  params: LatticeParams;
  validation?: ValidationResult | null;
  metrics?: LatticeMetrics | null;
  material?: { name: string; density: number } | null;
}

function buildMetadata(options: ThreeMfOptions): string {
  const entries: Array<[string, string]> = [
    ['Application', 'OpenLattice3D'],
    ['Title', options.meshFileName || 'Lattice'],
    ['Designer', 'OpenLattice3D'],
    ['Description', `${options.params.latticeType} lattice, ${options.params.cellSize}mm cell`],
  ];

  // Namespaced entries so the recipe travels with the part. 3MF requires custom
  // metadata names to be namespace-qualified.
  const custom: Array<[string, string]> = [
    ['ol:latticeType', options.params.latticeType],
    ['ol:cellSize', `${options.params.cellSize}`],
    ['ol:wallThickness', `${options.params.wallThickness}`],
    ['ol:strutDiameter', `${options.params.strutDiameter}`],
    ['ol:shellThickness', `${options.params.shellThickness}`],
    ['ol:processPreset', options.params.processPreset],
    ['ol:minFeatureSize', `${options.params.minFeatureSize}`],
  ];
  if (options.metrics) {
    custom.push(
      ['ol:relativeDensity', options.metrics.relativeDensity.toFixed(4)],
      ['ol:latticeVolumeMm3', options.metrics.latticeVolume.toFixed(2)],
      ['ol:envelopeVolumeMm3', options.metrics.envelopeVolume.toFixed(2)],
    );
  }
  if (options.material) {
    custom.push(
      ['ol:material', options.material.name],
      ['ol:materialDensityGramsPerCm3', `${options.material.density}`],
    );
  }
  if (options.validation) {
    custom.push(['ol:validationPassed', options.validation.passed ? 'true' : 'false']);
  }

  return [...entries, ...custom]
    .map(([name, value]) => `  <metadata name="${escapeXml(name)}">${escapeXml(value)}</metadata>`)
    .join('\n');
}

function buildModelXml(result: MarchingCubesResult, options: ThreeMfOptions): Uint8Array {
  const mesh = buildIndexedMesh(result);
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
    // Encode incrementally; a large lattice is tens of megabytes of XML and
    // building it as one string first would double peak memory for no reason.
    if (buffer.length >= 4096) flush();
  };

  write('<?xml version="1.0" encoding="UTF-8"?>\n');
  write('<model unit="millimeter" xml:lang="en-US"');
  write(' xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"');
  write(' xmlns:ol="https://openlattice3d.com/3mf">\n');
  write(buildMetadata(options));
  write('\n <resources>\n  <object id="1" type="model">\n   <mesh>\n    <vertices>\n');

  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * 3;
    write(`     <vertex x="${coord(mesh.positions[o])}" y="${coord(mesh.positions[o + 1])}" z="${coord(mesh.positions[o + 2])}"/>\n`);
  }

  write('    </vertices>\n    <triangles>\n');
  for (let i = 0; i < mesh.triangleCount; i++) {
    const o = i * 3;
    write(`     <triangle v1="${mesh.indices[o]}" v2="${mesh.indices[o + 1]}" v3="${mesh.indices[o + 2]}"/>\n`);
  }
  write('    </triangles>\n   </mesh>\n  </object>\n </resources>\n');
  write(' <build>\n  <item objectid="1"/>\n </build>\n</model>\n');
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

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/${MODEL_PATH}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

/** Build a complete 3MF package. */
export async function buildThreeMf(
  result: MarchingCubesResult,
  options: ThreeMfOptions
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  return createZip([
    { path: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES) },
    { path: '_rels/.rels', data: encoder.encode(ROOT_RELS) },
    { path: MODEL_PATH, data: buildModelXml(result, options) },
  ]);
}
