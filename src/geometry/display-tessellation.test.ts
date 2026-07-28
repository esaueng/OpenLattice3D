import { describe, expect, it } from 'vitest';
import {
  chordalDeflection,
  DEFAULT_CURVE_TESSELLATION,
  generateCylinderDisplayMesh,
  perspectiveProjectedRadiusPx,
  radialSegmentsForProjectedRadius,
  sampleCircularEdge,
} from './display-tessellation';

const VIEWPORT_HEIGHT_PX = 900;
const VERTICAL_FOV_RAD = 50 * Math.PI / 180;

describe('adaptive curved display tessellation', () => {
  it.each([
    { diameter: 3, normalDistance: 8, closeDistance: 2 },
    { diameter: 30, normalDistance: 80, closeDistance: 20 },
    { diameter: 300, normalDistance: 800, closeDistance: 200 },
  ])(
    'keeps the $diameter mm cylinder silhouette sub-pixel at normal and close zoom',
    ({ diameter, normalDistance, closeDistance }) => {
      const radius = diameter / 2;
      const normalProjectedRadius = perspectiveProjectedRadiusPx(
        radius,
        normalDistance,
        VERTICAL_FOV_RAD,
        VIEWPORT_HEIGHT_PX,
      );
      const closeProjectedRadius = perspectiveProjectedRadiusPx(
        radius,
        closeDistance,
        VERTICAL_FOV_RAD,
        VIEWPORT_HEIGHT_PX,
      );
      const normalSegments = radialSegmentsForProjectedRadius(normalProjectedRadius);
      const closeSegments = radialSegmentsForProjectedRadius(closeProjectedRadius);

      expect(chordalDeflection(normalProjectedRadius, normalSegments))
        .toBeLessThanOrEqual(DEFAULT_CURVE_TESSELLATION.maxChordalDeflectionPx);
      expect(chordalDeflection(closeProjectedRadius, closeSegments))
        .toBeLessThanOrEqual(DEFAULT_CURVE_TESSELLATION.maxChordalDeflectionPx);
      expect((Math.PI * 2) / normalSegments)
        .toBeLessThanOrEqual(DEFAULT_CURVE_TESSELLATION.maxAngularDeflectionRad);
      expect((Math.PI * 2) / closeSegments)
        .toBeLessThanOrEqual(DEFAULT_CURVE_TESSELLATION.maxAngularDeflectionRad);
      expect(closeSegments).toBeGreaterThanOrEqual(normalSegments);
      expect(closeSegments).toBeLessThanOrEqual(DEFAULT_CURVE_TESSELLATION.maxSegments);
    },
  );

  it('refines in bounded LOD tiers as the projected curve grows', () => {
    const segmentCounts = [40, 120, 400, 1200]
      .map((projectedRadius) => radialSegmentsForProjectedRadius(projectedRadius));

    expect(segmentCounts).toEqual([...segmentCounts].sort((a, b) => a - b));
    expect(new Set(segmentCounts).size).toBeGreaterThan(1);
    for (const segments of segmentCounts) {
      expect(segments % DEFAULT_CURVE_TESSELLATION.segmentStep).toBe(0);
      expect(segments).toBeLessThanOrEqual(DEFAULT_CURVE_TESSELLATION.maxSegments);
    }
  });

  it.each([3, 30, 300])(
    'keeps the %d mm cylinder edge coincident with its smooth-normal display surface',
    (diameter) => {
      const radius = diameter / 2;
      const projectedRadius = perspectiveProjectedRadiusPx(
        radius,
        diameter * 0.75,
        VERTICAL_FOV_RAD,
        VIEWPORT_HEIGHT_PX,
      );
      const segments = radialSegmentsForProjectedRadius(projectedRadius);
      const height = diameter * 1.5;
      const mesh = generateCylinderDisplayMesh(radius, height, segments);
      const topEdge = sampleCircularEdge(radius, height / 2, segments);

      expect(mesh.triCount).toBe(segments * 4);
      expect(mesh.positions).toHaveLength(mesh.triCount * 9);
      expect(mesh.normals).toHaveLength(mesh.positions.length);

      for (let segment = 0; segment < segments; segment++) {
        const edgeOffset = segment * 3;
        const surfaceOffset = segment * 36 + 21;
        expect(topEdge[edgeOffset]).toBeCloseTo(mesh.positions[surfaceOffset], 5);
        expect(topEdge[edgeOffset + 1]).toBeCloseTo(mesh.positions[surfaceOffset + 1], 5);
        expect(topEdge[edgeOffset + 2]).toBeCloseTo(mesh.positions[surfaceOffset + 2], 5);

        const radialLength = Math.hypot(topEdge[edgeOffset], topEdge[edgeOffset + 1]);
        expect(Math.abs(radialLength - radius)).toBeLessThanOrEqual(Math.max(1e-6, radius * 1e-6));

        const sideNormalOffset = segment * 36;
        const sideNormalLength = Math.hypot(
          mesh.normals[sideNormalOffset],
          mesh.normals[sideNormalOffset + 1],
          mesh.normals[sideNormalOffset + 2],
        );
        expect(sideNormalLength).toBeCloseTo(1, 6);
        expect(mesh.normals[sideNormalOffset + 2]).toBeCloseTo(0, 6);
        expect(mesh.normals[sideNormalOffset]).toBeCloseTo(
          topEdge[edgeOffset] / radius,
          6,
        );
        expect(mesh.normals[sideNormalOffset + 1]).toBeCloseTo(
          topEdge[edgeOffset + 1] / radius,
          6,
        );
      }
    },
  );
});
