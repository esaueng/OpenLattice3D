// Characterization of every lattice field at the identity orientation. The
// golden hashes were captured from the code before lattice orientation and
// stretched cells (latticeRotationDeg / cellScale) were added; identity
// parameters, whether explicit or absent (older saved params), must keep
// producing bit-identical fields on every builder path. A golden may only
// change together with an intentional, documented change to generated output.
// Print fresh values with
//   CAPTURE_LATTICE_IDENTITY_GOLDENS=1 npx vitest run <this file> --silent=false
//
// V8 on arm64 rounds some transcendental results differently from x64, so the
// goldens are checked on x64 only; every architecture still checks that the
// explicit and absent identity parameters agree bit for bit.
import { arch } from 'node:os';
import { describe, expect, it } from 'vitest';
import { MeshBVH } from './bvh';
import {
  buildCombinedSDF,
  buildCubeLattice,
  buildLatticeEvaluator,
  type SdfFunction,
} from './lattice';
import { generateCubeMesh } from './mesh-analysis';
import { DEFAULT_PARAMS, type LatticeParams, type LatticeType } from '../types/project';

const TYPES: LatticeType[] = [
  'gyroid', 'schwarzP', 'schwarzD', 'neovius', 'iwp', 'bcc',
  'octet', 'diamond', 'hexagon', 'triangle', 'voronoi', 'spinodal',
];

type Layout = 'shell_core' | 'implicit_conformal' | 'noShell' | 'surfaceOnly' | 'graded';
const LAYOUTS: Layout[] = ['shell_core', 'implicit_conformal', 'noShell', 'surfaceOnly', 'graded'];
const SEED = 0x5eed1234;

function fnv(values: Float64Array): string {
  let value = 2166136261;
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  for (const byte of bytes) value = Math.imul((value ^ byte) >>> 0, 16777619) >>> 0;
  return value.toString(16).padStart(8, '0');
}

function layoutParams(type: LatticeType, layout: Layout): LatticeParams {
  const base: LatticeParams = { ...DEFAULT_PARAMS, latticeType: type, cellSize: 7.3, wallThickness: 1.1, strutDiameter: 1.3 };
  switch (layout) {
    case 'shell_core': return base;
    case 'implicit_conformal': return { ...base, variant: 'implicit_conformal' };
    case 'noShell': return { ...base, noShell: true };
    case 'surfaceOnly': return { ...base, surfaceOnly: true, surfaceDepth: 4 };
    case 'graded': return { ...base, gradientEnabled: true, gradientStrength: 0.7 };
  }
}

/** Params as an older client stored them, without the orientation fields. */
function withoutOrientation(params: LatticeParams): LatticeParams {
  const copy: Record<string, unknown> = { ...params };
  delete copy.latticeRotationDeg;
  delete copy.cellScale;
  return copy as unknown as LatticeParams;
}

function points(): [number, number, number][] {
  const out: [number, number, number][] = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        out.push([-17.3 + i * 4.31, -16.9 + j * 4.27, -17.7 + k * 4.41]);
      }
    }
  }
  out.push([0, 0, 0], [15, 0, 0], [15, 15, 15], [-7.3, 3.65, 14.6], [3.65, 3.65, 3.65]);
  return out;
}

function fieldHash(sdf: (x: number, y: number, z: number) => number): string {
  const pts = points();
  const values = new Float64Array(pts.length);
  pts.forEach(([x, y, z], index) => { values[index] = sdf(x, y, z); });
  return fnv(values);
}

/** Hash of the fast grid sampler output, or '-' when the field has none. */
function gridHash(sdf: SdfFunction): string {
  if (typeof sdf.sampleField !== 'function') return '-';
  const resolution = 10;
  const out = new Float32Array((resolution + 1) ** 3);
  sdf.sampleField({ min: [-17.1, -16.3, -17.9], max: [17.4, 16.8, 17.2] }, resolution, out);
  return fnv(new Float64Array(out));
}

const cubeMesh = generateCubeMesh(30);
const cubeBvh = new MeshBVH(cubeMesh.positions, cubeMesh.normals, cubeMesh.triCount);

function hashesFor(params: LatticeParams): string {
  const analytic = buildCubeLattice(15, params, SEED);
  const imported = buildCombinedSDF({ bvh: cubeBvh, params, generationSeed: SEED });
  return [
    fieldHash(buildLatticeEvaluator(params, SEED)),
    fieldHash(analytic),
    gridHash(analytic),
    fieldHash(imported),
    gridHash(imported),
  ].join(':');
}

const GOLDEN: Record<string, string> = {
  'gyroid/shell_core': 'ff3e77b4:9a137eb1:4b2e9e46:9a137eb1:4b2e9e46',
  'gyroid/implicit_conformal': 'ff3e77b4:642a869d:3389bbd2:642a869d:3389bbd2',
  'gyroid/noShell': 'ff3e77b4:f14c72a7:e5f43065:f14c72a7:e5f43065',
  'gyroid/surfaceOnly': 'ff3e77b4:9f82ea2e:bc71d165:9f82ea2e:bc71d165',
  'gyroid/graded': 'ff3e77b4:b221b0c0:4a0f03a8:b221b0c0:4a0f03a8',
  'schwarzP/shell_core': 'def9648d:fb966888:248f80e0:fb966888:248f80e0',
  'schwarzP/implicit_conformal': 'def9648d:879ef831:aa58066d:879ef831:aa58066d',
  'schwarzP/noShell': 'def9648d:c6c656b2:de1652a4:c6c656b2:de1652a4',
  'schwarzP/surfaceOnly': 'def9648d:01617621:2f7db040:01617621:2f7db040',
  'schwarzP/graded': 'def9648d:57c5f947:d3fc6770:57c5f947:d3fc6770',
  'schwarzD/shell_core': 'bf919bb6:3cd8b393:632dd541:3cd8b393:632dd541',
  'schwarzD/implicit_conformal': 'bf919bb6:fd8cbc8c:6443ee97:fd8cbc8c:6443ee97',
  'schwarzD/noShell': 'bf919bb6:df58053f:1dae9fcc:df58053f:1dae9fcc',
  'schwarzD/surfaceOnly': 'bf919bb6:6c2d3d38:9ddfa5cd:6c2d3d38:9ddfa5cd',
  'schwarzD/graded': 'bf919bb6:22b95452:77aba045:22b95452:77aba045',
  'neovius/shell_core': '887d1a30:31801def:e76de7b5:31801def:e76de7b5',
  'neovius/implicit_conformal': '887d1a30:77ddb435:d38a8974:77ddb435:d38a8974',
  'neovius/noShell': '887d1a30:190943a8:1fdf0c08:190943a8:1fdf0c08',
  'neovius/surfaceOnly': '887d1a30:fcab2b66:df20b03d:fcab2b66:df20b03d',
  'neovius/graded': '887d1a30:2dc593cd:18b66b90:2dc593cd:18b66b90',
  'iwp/shell_core': '4af646a5:4cac4bbe:c154dfb6:4cac4bbe:c154dfb6',
  'iwp/implicit_conformal': '4af646a5:3c758b61:50bf488e:3c758b61:50bf488e',
  'iwp/noShell': '4af646a5:db312c9f:052032fc:db312c9f:052032fc',
  'iwp/surfaceOnly': '4af646a5:f7822f54:cadf6aab:f7822f54:cadf6aab',
  'iwp/graded': '4af646a5:71e11017:a379a3b0:71e11017:a379a3b0',
  'bcc/shell_core': '40a9c491:0b09965b:-:0b09965b:-',
  'bcc/implicit_conformal': '40a9c491:139dbb79:-:139dbb79:-',
  'bcc/noShell': '40a9c491:1ff3ade5:-:1ff3ade5:-',
  'bcc/surfaceOnly': '40a9c491:b3cd6eed:-:b3cd6eed:-',
  'bcc/graded': '40a9c491:53ad53e1:-:53ad53e1:-',
  'octet/shell_core': '90f72ec3:2d92816e:-:2d92816e:-',
  'octet/implicit_conformal': '90f72ec3:8759e6a9:-:8759e6a9:-',
  'octet/noShell': '90f72ec3:018dfa91:-:018dfa91:-',
  'octet/surfaceOnly': '90f72ec3:bff51ef2:-:bff51ef2:-',
  'octet/graded': '90f72ec3:19859a5d:-:19859a5d:-',
  'diamond/shell_core': '267eedeb:dc87e96a:-:dc87e96a:-',
  'diamond/implicit_conformal': '267eedeb:16764cda:-:16764cda:-',
  'diamond/noShell': '267eedeb:e880162a:-:e880162a:-',
  'diamond/surfaceOnly': '267eedeb:c4c7f1ba:-:c4c7f1ba:-',
  'diamond/graded': '267eedeb:cc51e5a8:-:cc51e5a8:-',
  'hexagon/shell_core': 'ad5365bd:c4225168:-:c4225168:-',
  'hexagon/implicit_conformal': 'ad5365bd:5bb57d21:-:5bb57d21:-',
  'hexagon/noShell': 'ad5365bd:3fd9f51f:-:3fd9f51f:-',
  'hexagon/surfaceOnly': 'ad5365bd:54741faf:-:54741faf:-',
  'hexagon/graded': 'ad5365bd:ea6f7e65:-:ea6f7e65:-',
  'triangle/shell_core': 'd24d3558:dc5636fd:-:dc5636fd:-',
  'triangle/implicit_conformal': 'd24d3558:0f87c9a5:-:0f87c9a5:-',
  'triangle/noShell': 'd24d3558:f430e463:-:f430e463:-',
  'triangle/surfaceOnly': 'd24d3558:38dd9ccd:-:38dd9ccd:-',
  'triangle/graded': 'd24d3558:de226b8a:-:de226b8a:-',
  'voronoi/shell_core': '705852e7:79217c59:-:79217c59:-',
  'voronoi/implicit_conformal': '705852e7:158bc467:-:158bc467:-',
  'voronoi/noShell': '705852e7:3de4db24:-:3de4db24:-',
  'voronoi/surfaceOnly': '705852e7:743cbcd8:-:743cbcd8:-',
  'voronoi/graded': '705852e7:8914a518:-:8914a518:-',
  'spinodal/shell_core': '342853dc:a1a9d384:-:a1a9d384:-',
  'spinodal/implicit_conformal': '342853dc:5982ccae:-:5982ccae:-',
  'spinodal/noShell': '342853dc:8ccba88e:-:8ccba88e:-',
  'spinodal/surfaceOnly': '342853dc:41f08390:-:41f08390:-',
  'spinodal/graded': '342853dc:77fa0adf:-:77fa0adf:-',
};

const capture = process.env.CAPTURE_LATTICE_IDENTITY_GOLDENS === '1';
const captured: Record<string, string> = {};

describe('identity lattice orientation characterization', () => {
  describe.each(TYPES)('%s', (type) => {
    it.each(LAYOUTS)('keeps the %s field bit-identical', (layout) => {
      const key = `${type}/${layout}`;
      const params = layoutParams(type, layout);
      const explicit = hashesFor(params);
      expect(hashesFor(withoutOrientation(params))).toBe(explicit);
      if (capture) captured[key] = explicit;
      else if (arch() === 'x64') expect(explicit).toBe(GOLDEN[key]);
    });
  });

  it.runIf(capture)('prints captured goldens', () => {
    console.log(JSON.stringify(captured, null, 2));
  });
});
