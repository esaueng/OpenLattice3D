import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { runValidation } from '../../geometry/validation';
import { DEFAULT_PARAMS, type ValidationResult } from '../../types/project';
import { OuterDeviationDetail } from './ResultsStep';

function render(outerDeviation: ValidationResult['outerDeviation']): string {
  return renderToStaticMarkup(createElement(OuterDeviationDetail, { outerDeviation }));
}

describe('ResultsStep outer deviation detail', () => {
  it('shows the measured maximum and limit', () => {
    const html = render({ passed: true, maxDeviation: 0.0123, tolerance: 0.2, sampled: 2000 });
    expect(html).toContain('0.012 mm');
    expect(html).toContain('limit 0.2 mm');
    expect(html).not.toContain('Not measured');
  });

  it('shows an unmeasured deviation as not measured, never as Max 0.000 mm', () => {
    const html = render({ passed: false, maxDeviation: 0, tolerance: 0.2, sampled: 0 });
    expect(html).toContain('Not measured');
    expect(html).toContain('limit 0.2 mm');
    expect(html).not.toContain('0.000 mm');
  });

  it('keeps showing the maximum for older results without a sample count', () => {
    expect(render({ passed: true, maxDeviation: 0.05, tolerance: 0.2 })).toContain('0.050 mm');
  });

  it('shows validation without a deviation reference as not measured', () => {
    const triangle = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1]),
      triCount: 1,
    };
    const validation = runValidation(triangle, () => 1, DEFAULT_PARAMS, null, null);
    const html = render(validation.outerDeviation);
    expect(html).toContain('Not measured');
    expect(html).not.toContain('0.000 mm');
  });
});
