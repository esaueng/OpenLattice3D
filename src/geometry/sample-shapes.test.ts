import { describe, expect, it } from 'vitest';
import type { SampleShape } from '../types/project';
import { sampleShapeMaxSpan } from './sample-shapes';

// The hard-coded spans proceduralMaxSpan in src/hooks/useLatticeGeneration.ts
// uses to size sampling voxels; the derived helper must reproduce them exactly.
function legacyProceduralMaxSpan(shape: SampleShape | null, sphereRadius: number): number {
  switch (shape) {
    case 'sphere': return (sphereRadius || 25) * 2;
    case 'cube': return 30;
    case 'cylinder': return 40;
    case 'torus': return 56;
    case 'capsule': return 54;
    default: return (sphereRadius || 25) * 2;
  }
}

describe('sampleShapeMaxSpan', () => {
  const shapes: (SampleShape | null)[] = ['sphere', 'cube', 'cylinder', 'torus', 'capsule', null];

  it('matches the hard-coded generation spans for every shape', () => {
    for (const sphereRadius of [0, 25, 12.3, 40]) {
      for (const shape of shapes) {
        // Exact equality on purpose: the helper must be output-preserving.
        expect(sampleShapeMaxSpan(shape, sphereRadius), `${shape} r=${sphereRadius}`)
          .toBe(legacyProceduralMaxSpan(shape, sphereRadius));
      }
    }
  });

  it('reports the documented spans in mm', () => {
    expect(sampleShapeMaxSpan('cube', 25)).toBe(30);
    expect(sampleShapeMaxSpan('cylinder', 25)).toBe(40);
    expect(sampleShapeMaxSpan('torus', 25)).toBe(56);
    expect(sampleShapeMaxSpan('capsule', 25)).toBe(54);
    expect(sampleShapeMaxSpan('sphere', 0)).toBe(50);
    expect(sampleShapeMaxSpan(null, 10)).toBe(20);
  });
});
