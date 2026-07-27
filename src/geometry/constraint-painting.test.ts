import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MeshBVH } from './bvh';
import { computeTriangleCentroids, facesWithinBrush } from './constraint-painting';
import { buildCombinedSDF } from './lattice';
import { parseSTL, type TriangleMesh } from './stl-parser';
import { DEFAULT_PARAMS } from '../types/project';
import type { Vec3 } from './vec3';

function loadAsset(name: string): TriangleMesh {
  const source = readFileSync(new URL(`../../public/assets/${name}`, import.meta.url));
  const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  return parseSTL(buffer);
}

function triangleCentroid(mesh: TriangleMesh, triangle: number): Vec3 {
  const offset = triangle * 9;
  return [
    (mesh.positions[offset] + mesh.positions[offset + 3] + mesh.positions[offset + 6]) / 3,
    (mesh.positions[offset + 1] + mesh.positions[offset + 4] + mesh.positions[offset + 7]) / 3,
    (mesh.positions[offset + 2] + mesh.positions[offset + 5] + mesh.positions[offset + 8]) / 3,
  ];
}

function pointBelowFace(mesh: TriangleMesh, triangle: number, depth: number): Vec3 {
  const centroid = triangleCentroid(mesh, triangle);
  const normalOffset = triangle * 3;
  return [
    centroid[0] - mesh.normals[normalOffset] * depth,
    centroid[1] - mesh.normals[normalOffset + 1] * depth,
    centroid[2] - mesh.normals[normalOffset + 2] * depth,
  ];
}

describe('imported-STL constraint painting', () => {
  it('expands a brush on the imported sphere without bleeding through the far side', () => {
    const mesh = loadAsset('sphere-25mm.stl');
    const centroids = computeTriangleCentroids(mesh);
    const faceIndex = Math.floor(mesh.triCount / 3);
    const point = triangleCentroid(mesh, faceIndex);
    const painted = facesWithinBrush(mesh, centroids, point, faceIndex, 4);

    expect(painted).toContain(faceIndex);
    expect(painted.length).toBeGreaterThan(1);
    const normalOffset = faceIndex * 3;
    for (const triangle of painted) {
      const offset = triangle * 3;
      const facing = mesh.normals[offset] * mesh.normals[normalOffset]
        + mesh.normals[offset + 1] * mesh.normals[normalOffset + 1]
        + mesh.normals[offset + 2] * mesh.normals[normalOffset + 2];
      expect(facing).toBeGreaterThan(0);
    }
  });

  it('preserves solid keep-in material below a painted imported-cube face', () => {
    const mesh = loadAsset('cube-30mm.stl');
    const bvh = new MeshBVH(mesh.positions, mesh.normals, mesh.triCount);
    const params = {
      ...DEFAULT_PARAMS,
      noShell: true,
      escapeHoles: false,
      wallThickness: 0.6,
      keepInDepth: 3,
    };
    const unconstrained = buildCombinedSDF({ bvh, params });

    let candidate: { triangle: number; point: Vec3 } | null = null;
    for (let triangle = 0; triangle < mesh.triCount && !candidate; triangle++) {
      for (let depth = 0.25; depth < params.keepInDepth; depth += 0.25) {
        const point = pointBelowFace(mesh, triangle, depth);
        if (unconstrained(...point) > 0.05) {
          candidate = { triangle, point };
          break;
        }
      }
    }
    expect(candidate).not.toBeNull();

    const constrained = buildCombinedSDF({
      bvh,
      params,
      keepInTris: new Set([candidate!.triangle]),
    });
    expect(unconstrained(...candidate!.point)).toBeGreaterThan(0);
    expect(constrained(...candidate!.point)).toBeLessThan(0);
  });

  it('applies painted constraints identically in the optimized grid sampler', () => {
    const mesh = loadAsset('cube-30mm.stl');
    const bvh = new MeshBVH(mesh.positions, mesh.normals, mesh.triCount);
    const sdf = buildCombinedSDF({
      bvh,
      params: {
        ...DEFAULT_PARAMS,
        noShell: true,
        escapeHoles: false,
        keepInDepth: 3,
      },
      keepInTris: new Set([0, 1]),
      keepOutTris: new Set([2, 3]),
    });
    expect(sdf.sampleField).toBeTypeOf('function');

    const bounds = bvh.getBounds();
    const resolution = 8;
    const field = new Float32Array((resolution + 1) ** 3);
    sdf.sampleField!(bounds, resolution, field);
    const dx = (bounds.max[0] - bounds.min[0]) / resolution;
    const dy = (bounds.max[1] - bounds.min[1]) / resolution;
    const dz = (bounds.max[2] - bounds.min[2]) / resolution;
    let index = 0;
    for (let z = 0; z <= resolution; z++) {
      for (let y = 0; y <= resolution; y++) {
        for (let x = 0; x <= resolution; x++, index++) {
          expect(field[index]).toBeCloseTo(sdf(
            bounds.min[0] + x * dx,
            bounds.min[1] + y * dy,
            bounds.min[2] + z * dz,
          ), 4);
        }
      }
    }
  });
});
