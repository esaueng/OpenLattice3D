import type { TriangleMesh } from './stl-parser';
import type { Vec3 } from './vec3';

export function computeTriangleCentroids(mesh: TriangleMesh): Float32Array {
  const centroids = new Float32Array(mesh.triCount * 3);
  for (let triangle = 0; triangle < mesh.triCount; triangle++) {
    const positionOffset = triangle * 9;
    const centroidOffset = triangle * 3;
    centroids[centroidOffset] = (
      mesh.positions[positionOffset]
      + mesh.positions[positionOffset + 3]
      + mesh.positions[positionOffset + 6]
    ) / 3;
    centroids[centroidOffset + 1] = (
      mesh.positions[positionOffset + 1]
      + mesh.positions[positionOffset + 4]
      + mesh.positions[positionOffset + 7]
    ) / 3;
    centroids[centroidOffset + 2] = (
      mesh.positions[positionOffset + 2]
      + mesh.positions[positionOffset + 5]
      + mesh.positions[positionOffset + 8]
    ) / 3;
  }
  return centroids;
}

/**
 * Return faces within the world-space brush radius that face the same
 * hemisphere as the hit face. The facing check prevents strokes from bleeding
 * through thin imported walls.
 */
export function facesWithinBrush(
  mesh: TriangleMesh,
  centroids: Float32Array,
  point: Vec3,
  faceIndex: number,
  brushRadius: number,
): number[] {
  if (faceIndex < 0 || faceIndex >= mesh.triCount) return [];
  if (brushRadius <= 0) return [faceIndex];

  const radiusSquared = brushRadius * brushRadius;
  const normalOffset = faceIndex * 3;
  const nx = mesh.normals[normalOffset];
  const ny = mesh.normals[normalOffset + 1];
  const nz = mesh.normals[normalOffset + 2];
  const faces: number[] = [];

  for (let triangle = 0; triangle < mesh.triCount; triangle++) {
    const offset = triangle * 3;
    const dx = centroids[offset] - point[0];
    const dy = centroids[offset + 1] - point[1];
    const dz = centroids[offset + 2] - point[2];
    if (dx * dx + dy * dy + dz * dz > radiusSquared) continue;
    const facing = mesh.normals[offset] * nx
      + mesh.normals[offset + 1] * ny
      + mesh.normals[offset + 2] * nz;
    if (facing <= 0) continue;
    faces.push(triangle);
  }

  return faces;
}
