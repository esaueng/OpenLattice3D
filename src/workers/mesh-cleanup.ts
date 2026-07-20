import { buildEdgeTopology, findConnectedComponents } from '../geometry/mesh-topology';

export function removeDisconnectedFragments(
  mesh: { positions: Float32Array; normals: Float32Array; triCount: number },
  minComponentRatio = 0.003,
): { positions: Float32Array; normals: Float32Array; triCount: number; removedTriangles: number } {
  const { positions, normals, triCount } = mesh;
  if (triCount <= 0) return { positions, normals, triCount, removedTriangles: 0 };
  const components = findConnectedComponents(buildEdgeTopology(positions, triCount));
  if (components.length <= 1) return { positions, normals, triCount, removedTriangles: 0 };

  components.sort((a, b) => b.length - a.length);
  const largest = components[0].length;
  const keep = new Uint8Array(triCount);
  for (const component of components) {
    if (component.length === largest || component.length >= largest * minComponentRatio) {
      for (const triangle of component) keep[triangle] = 1;
    }
  }

  let keptCount = 0;
  for (let triangle = 0; triangle < triCount; triangle++) keptCount += keep[triangle];
  if (keptCount === triCount || keptCount === 0) return { positions, normals, triCount, removedTriangles: 0 };

  const outputPositions = new Float32Array(keptCount * 9);
  const outputNormals = new Float32Array(keptCount * 3);
  let outputTriangle = 0;
  for (let triangle = 0; triangle < triCount; triangle++) {
    if (!keep[triangle]) continue;
    outputPositions.set(positions.subarray(triangle * 9, triangle * 9 + 9), outputTriangle * 9);
    outputNormals.set(normals.subarray(triangle * 3, triangle * 3 + 3), outputTriangle * 3);
    outputTriangle++;
  }
  return {
    positions: outputPositions,
    normals: outputNormals,
    triCount: outputTriangle,
    removedTriangles: triCount - outputTriangle,
  };
}
