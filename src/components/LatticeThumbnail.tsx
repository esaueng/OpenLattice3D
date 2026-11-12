// A small cross-section of a lattice type, drawn once per type and reused.
import { useEffect, useRef } from 'react';
import type { LatticeType } from '../types/project';
import { LATTICE_PREVIEW_RESOLUTION, latticeSlice, sliceCoverage } from '../geometry/lattice-preview';

// Coverage depends only on the type (fixed preview parameters), so compute it once per session.
const coverageCache = new Map<LatticeType, Uint8ClampedArray>();

function coverageFor(type: LatticeType): Uint8ClampedArray {
  let coverage = coverageCache.get(type);
  if (!coverage) {
    coverage = sliceCoverage(latticeSlice(type, LATTICE_PREVIEW_RESOLUTION));
    coverageCache.set(type, coverage);
  }
  return coverage;
}

function parseRgb(color: string): [number, number, number] {
  const match = color.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [200, 200, 200];
}

export function LatticeThumbnail({ type, active = false }: { type: LatticeType; active?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const size = LATTICE_PREVIEW_RESOLUTION;
    // Material takes the element's text colour, so it follows the option's state and theme.
    const [r, g, b] = parseRgb(getComputedStyle(canvas).color);
    const coverage = coverageFor(type);
    const image = context.createImageData(size, size);
    for (let i = 0; i < coverage.length; i++) {
      image.data[i * 4] = r;
      image.data[i * 4 + 1] = g;
      image.data[i * 4 + 2] = b;
      image.data[i * 4 + 3] = coverage[i];
    }
    context.putImageData(image, 0, 0);
    // Redrawn when the option is selected, since its colour changes with it.
  }, [type, active]);

  return (
    <canvas
      ref={canvasRef}
      className="lattice-thumb"
      width={LATTICE_PREVIEW_RESOLUTION}
      height={LATTICE_PREVIEW_RESOLUTION}
      aria-hidden="true"
    />
  );
}
