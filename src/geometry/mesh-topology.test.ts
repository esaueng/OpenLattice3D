import { describe, expect, it } from 'vitest';
import { buildEdgeTopology, countEdgeDefects, findConnectedComponents } from './mesh-topology';
import { generateCubeMesh } from './mesh-analysis';

describe('mesh topology', () => {
  it('classifies a closed cube as defect-free with one component', () => {
    const cube = generateCubeMesh(10);
    const topology = buildEdgeTopology(cube.positions, cube.triCount);
    const defects = countEdgeDefects(topology);
    expect(defects.boundaryEdges).toBe(0);
    expect(defects.nonManifoldEdges).toBe(0);
    expect(findConnectedComponents(topology)).toHaveLength(1);
  });

  it('detects boundary edges on an open mesh', () => {
    const cube = generateCubeMesh(10);
    // Drop the last triangle to open the surface.
    const open = {
      positions: cube.positions.subarray(0, (cube.triCount - 1) * 9),
      triCount: cube.triCount - 1,
    };
    const defects = countEdgeDefects(buildEdgeTopology(open.positions, open.triCount));
    expect(defects.boundaryEdges).toBe(3);
  });

  it('finds two components for two separated cubes', () => {
    const a = generateCubeMesh(10);
    const b = generateCubeMesh(10);
    const positions = new Float32Array(a.positions.length * 2);
    positions.set(a.positions, 0);
    // Shift second cube far away on x.
    for (let i = 0; i < b.positions.length; i += 3) {
      positions[a.positions.length + i] = b.positions[i] + 100;
      positions[a.positions.length + i + 1] = b.positions[i + 1];
      positions[a.positions.length + i + 2] = b.positions[i + 2];
    }
    const topology = buildEdgeTopology(positions, a.triCount * 2);
    const components = findConnectedComponents(topology);
    expect(components).toHaveLength(2);
    expect(components[0]).toHaveLength(12);
    expect(components[1]).toHaveLength(12);
  });

  it('handles empty meshes', () => {
    const topology = buildEdgeTopology(new Float32Array(0), 0);
    expect(findConnectedComponents(topology)).toHaveLength(0);
    expect(countEdgeDefects(topology)).toEqual({ boundaryEdges: 0, nonManifoldEdges: 0 });
  });

  it('keeps distinct high-magnitude quantized vertices separate despite hash collisions', () => {
    const positions = new Float32Array([
      1_000_000, 0, 0, 1_000_001, 0, 0, 1_000_000, 1, 0,
      -1_000_000, 0, 0, -1_000_001, 0, 0, -1_000_000, -1, 0,
    ]);
    const topology = buildEdgeTopology(positions, 2);
    expect(topology.edgeTriangleLists).toHaveLength(6);
    expect(findConnectedComponents(topology)).toHaveLength(2);
  });
});
