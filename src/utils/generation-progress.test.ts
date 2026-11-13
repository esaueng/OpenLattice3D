import { describe, expect, it } from 'vitest';
import { describeGenerationProgress } from './generation-progress';

describe('describeGenerationProgress', () => {
  it('turns tiled worker diagnostics into a plain phase with a percent', () => {
    const view = describeGenerationProgress(0.86, 'cpu-tiled: 211/216 tiles processed, 0/216 skipped (1478ms worker time)');
    expect(view).toEqual({ phase: 'surface', label: 'Building surface', percent: 86, text: 'Building surface · 86%' });
    expect(view.text).not.toMatch(/tiles|ms|cpu/);
  });

  it('names the merge after the last tile as clean-up instead of sitting silently at 88%', () => {
    expect(describeGenerationProgress(0.88, 'cpu-tiled: 216/216 tiles processed, 3/216 skipped (2100ms worker time)'))
      .toMatchObject({ phase: 'cleanup', text: 'Cleaning up mesh · 88%' });
  });

  it('follows the single-threaded path through sampling, surface and clean-up', () => {
    expect(describeGenerationProgress(0.12, 'Estimated generation time: ~4s').phase).toBe('sampling');
    expect(describeGenerationProgress(0.27, 'Sampling field: 50%')).toMatchObject({ phase: 'sampling', text: 'Sampling field · 27%' });
    expect(describeGenerationProgress(0.44, 'Removing features under 0.8mm').label).toBe('Removing thin features');
    expect(describeGenerationProgress(0.6, 'Marching cubes: 40% (~3s remaining)').phase).toBe('surface');
    expect(describeGenerationProgress(0.84, 'Marching cubes: 100% (~0s remaining)').phase).toBe('cleanup');
    expect(describeGenerationProgress(0.95, 'Geometry ready').label).toBe('Preparing preview');
  });

  it('treats set-up diagnostics as preparing the model', () => {
    for (const message of ['Building BVH...', 'BVH built, computing SDF...', 'Mesh buffers: ArrayBuffer transfer path active', 'Selected backend cpu-single', 'sphere SDF ready']) {
      expect(describeGenerationProgress(0.05, message).phase).toBe('preparing');
    }
  });

  it('starts, finishes and stops in plain words', () => {
    expect(describeGenerationProgress(0, 'Starting...').text).toBe('Starting…');
    expect(describeGenerationProgress(0, '').text).toBe('Starting…');
    expect(describeGenerationProgress(1, 'Complete').text).toBe('Done');
    expect(describeGenerationProgress(0, 'Cancelled')).toMatchObject({ phase: 'stopped', text: 'Cancelled' });
    expect(describeGenerationProgress(0, 'Generation failed').phase).toBe('stopped');
  });

  it('falls back to the progress fraction for unknown messages and clamps the percent', () => {
    expect(describeGenerationProgress(0.5, 'something new').phase).toBe('surface');
    expect(describeGenerationProgress(1.7, 'x').percent).toBe(100);
    expect(describeGenerationProgress(Number.NaN, 'x').percent).toBe(0);
  });

  it('reports validation as checking printability', () => {
    expect(describeGenerationProgress(1, 'Complete', 0.42)).toEqual({
      phase: 'checking', label: 'Checking printability', percent: 42, text: 'Checking printability · 42%',
    });
  });
});
