import { describe, expect, it } from 'vitest';
import {
  MAX_DEMO_GRID_RESOLUTION,
  demoGridResolution,
  demoGridWorkerLimit,
} from './demo-grid-limits';

describe('multiview resource limits', () => {
  it('caps preview resolution independently of export resolution', () => {
    expect(demoGridResolution(1)).toBe(48);
    expect(demoGridResolution(10)).toBe(MAX_DEMO_GRID_RESOLUTION);
    expect(demoGridResolution(1_000_000)).toBe(MAX_DEMO_GRID_RESOLUTION);
  });

  it('serializes imported meshes and bounds procedural worker concurrency', () => {
    expect(demoGridWorkerLimit(true, 32)).toBe(1);
    expect(demoGridWorkerLimit(false, 32)).toBe(2);
    expect(demoGridWorkerLimit(false, 2)).toBe(1);
  });
});
