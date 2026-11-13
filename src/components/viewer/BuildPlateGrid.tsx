import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { buildPlateGridLines, type BuildPlateGridSpec } from './build-plate-grid';

const GRID_COLOR = '#9fb3c8';
const MAJOR_OPACITY = 0.34;
const MINOR_OPACITY = 0.12;

function gridLayer(positions: Float32Array, opacity: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: GRID_COLOR,
    transparent: true,
    opacity,
    depthWrite: false,
    toneMapped: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  // Draw before the part so transparent views (X-Ray) blend over the grid.
  lines.renderOrder = -1;
  lines.raycast = () => {};
  return lines;
}

/** Faint millimetre grid in the plane just below the part (see build-plate-grid.ts). */
export function BuildPlateGrid({ spec }: { spec: BuildPlateGridSpec }) {
  const layers = useMemo(() => {
    const lines = buildPlateGridLines(spec);
    return {
      major: gridLayer(lines.major, MAJOR_OPACITY),
      minor: lines.minor.length > 0 ? gridLayer(lines.minor, MINOR_OPACITY) : null,
    };
  }, [spec]);

  useEffect(() => () => {
    for (const layer of [layers.major, layers.minor]) {
      if (!layer) continue;
      layer.geometry.dispose();
      (layer.material as THREE.Material).dispose();
    }
  }, [layers]);

  return (
    <group name="Build-plate grid">
      {layers.minor && <primitive object={layers.minor} />}
      <primitive object={layers.major} />
    </group>
  );
}
