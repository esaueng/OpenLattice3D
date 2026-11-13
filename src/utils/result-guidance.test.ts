import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, type LatticeParams, type ValidationResult } from '../types/project';
import { modelExtents } from './model-summary';
import {
  actionableWarningCount,
  checkSuggestion,
  codedWarnings,
  inferWarningCode,
  ESCAPE_HOLES_ACTION,
  resultNotes,
  suggestedResolution,
  type GuidanceContext,
} from './result-guidance';

function validation(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    passed: true,
    outerDeviation: { passed: true, maxDeviation: 0.05, tolerance: 0.2, sampled: 2000 },
    minThickness: { passed: true, minMeasured: 0.95, required: 0.8, absoluteMin: 0.9, sampled: 200 },
    manifold: { passed: true, details: 'Mesh is manifold and watertight' },
    disconnected: { passed: true, fragmentCount: 1, voidCount: 0, sliverCount: 0 },
    warnings: [],
    ...overrides,
  };
}

const sphere = modelExtents(null, 'sphere', 25);

function context(run: Partial<LatticeParams> = {}, current: Partial<LatticeParams> = run): GuidanceContext {
  return {
    runParams: { ...DEFAULT_PARAMS, ...run },
    currentParams: { ...DEFAULT_PARAMS, ...current },
    extents: sphere,
  };
}

const TRAPPED = '1 enclosed void network and no escape holes: trapped powder/resin likely';

describe('result notes', () => {
  it('counts trapped powder as an actionable warning with a route to escape holes', () => {
    const v = validation({ disconnected: { passed: true, fragmentCount: 1, voidCount: 1, sliverCount: 0 }, warnings: [TRAPPED] });
    expect(actionableWarningCount(v)).toBe(1);
    expect(resultNotes(v, context())).toEqual([
      { kind: 'trapped-voids', code: 'trapped-voids', message: TRAPPED, actionable: true, action: ESCAPE_HOLES_ACTION },
    ]);
    expect(ESCAPE_HOLES_ACTION).toMatchObject({ step: 'shell', controlId: 'escape-holes' });
    expect(ESCAPE_HOLES_ACTION.params).toBeUndefined();
  });

  it('keeps negligible slivers and restated failures informational', () => {
    const v = validation({
      warnings: [
        '2 zero-volume slivers (negligible, but present in the export)',
        '3 separate solid bodies detected',
        'Minimum thickness could not be measured',
        'No reference mesh for deviation check',
      ],
    });
    expect(actionableWarningCount(v)).toBe(0);
    expect(resultNotes(v).every((note) => !note.actionable && !note.action)).toBe(true);
  });

  it('offers a resolution that can apply a skipped thin-feature filter', () => {
    const message = 'Cannot remove features under 0.8mm at this grid: samples are 0.60mm apart. Raise export resolution to about 145 or increase the threshold.';
    const [note] = resultNotes(validation({ warnings: [message] }), context({ exportResolution: 3, thinSectionFilter: 0.8 }));
    expect(note).toMatchObject({ kind: 'thin-filter-skipped', actionable: true });
    expect(note.action).toMatchObject({ step: 'generate', params: { exportResolution: 4 } });
  });

  it('treats unknown warnings as worth a look', () => {
    expect(actionableWarningCount(validation({ warnings: ['FDM with open lattice exterior can be difficult to print', 'Something new'] }))).toBe(2);
  });
});

describe('warning classification by code', () => {
  it('classifies by the validator code, not the wording', () => {
    // Reworded text that the old matcher would misread either way.
    const v = validation({
      warnings: ['Powder cannot drain from 2 sealed pockets', 'Tiny trapped slivers, negligible'],
      warningDetails: [
        { code: 'trapped-voids', message: 'Powder cannot drain from 2 sealed pockets' },
        { code: 'zero-volume-slivers', message: 'Tiny trapped slivers, negligible' },
      ],
    });
    expect(actionableWarningCount(v)).toBe(1);
    expect(resultNotes(v, context())).toEqual([
      { kind: 'trapped-voids', code: 'trapped-voids', message: 'Powder cannot drain from 2 sealed pockets', actionable: true, action: ESCAPE_HOLES_ACTION },
      { kind: 'sliver', code: 'zero-volume-slivers', message: 'Tiny trapped slivers, negligible', actionable: false, action: undefined },
    ]);
  });

  it.each([
    ['trapped-voids', 'trapped-voids', true],
    ['thin-filter-skipped', 'thin-filter-skipped', true],
    ['fdm-open-lattice', 'fdm-open-lattice', true],
    ['zero-volume-slivers', 'sliver', false],
    ['multiple-bodies', 'repeats-check', false],
    ['deviation-unmeasured', 'repeats-check', false],
    ['thickness-unmeasured', 'repeats-check', false],
    ['no-deviation-reference', 'repeats-check', false],
  ] as const)('maps %s to %s (actionable: %s)', (code, kind, actionable) => {
    const v = validation({ warnings: ['text'], warningDetails: [{ code, message: 'text' }] });
    expect(resultNotes(v)[0]).toMatchObject({ kind, code, actionable });
    expect(actionableWarningCount(v)).toBe(actionable ? 1 : 0);
  });

  it('infers codes from the text of older results without warning details', () => {
    const legacy = [
      ['1 enclosed void network and no escape holes: trapped powder/resin likely', 'trapped-voids'],
      ['Cannot remove features under 0.8mm at this grid: samples are 0.60mm apart.', 'thin-filter-skipped'],
      ['FDM with open lattice exterior can be difficult to print', 'fdm-open-lattice'],
      ['2 zero-volume slivers (negligible, but present in the export)', 'zero-volume-slivers'],
      ['3 separate solid bodies detected', 'multiple-bodies'],
      ['Outer deviation could not be measured', 'deviation-unmeasured'],
      ['Minimum thickness could not be measured', 'thickness-unmeasured'],
      ['No reference mesh for deviation check', 'no-deviation-reference'],
    ] as const;
    for (const [message, code] of legacy) expect(inferWarningCode(message)).toBe(code);
    expect(inferWarningCode('Something new')).toBeUndefined();
    const v = validation({ warnings: legacy.map(([message]) => message) });
    expect(codedWarnings(v).map((warning) => warning.code)).toEqual(legacy.map(([, code]) => code));
    expect(actionableWarningCount(v)).toBe(3);
  });

  it('falls back to the text when the details do not line up with the warnings', () => {
    const v = validation({
      warnings: [TRAPPED, 'Minimum thickness could not be measured'],
      warningDetails: [{ code: 'zero-volume-slivers', message: TRAPPED }],
    });
    expect(codedWarnings(v).map((warning) => warning.code)).toEqual(['trapped-voids', 'thickness-unmeasured']);
    expect(actionableWarningCount(v)).toBe(1);
  });

  it('keeps an unknown warning in an older result actionable with no code', () => {
    const [note] = resultNotes(validation({ warnings: ['Something new'] }));
    expect(note).toEqual({ kind: 'other', message: 'Something new', actionable: true, action: undefined });
    expect(note).not.toHaveProperty('code');
  });
});

describe('suggestedResolution', () => {
  it('raises at least one level and far enough to resolve the wall', () => {
    expect(suggestedResolution({ ...DEFAULT_PARAMS, exportResolution: 1 }, sphere)).toBe(4);
    expect(suggestedResolution({ ...DEFAULT_PARAMS, exportResolution: 4 }, sphere)).toBe(5);
    expect(suggestedResolution({ ...DEFAULT_PARAMS, exportResolution: 10 }, sphere)).toBeNull();
  });
});

describe('check suggestions', () => {
  it('gives no suggestion for passing checks', () => {
    for (const check of ['outerDeviation', 'minThickness', 'manifold', 'connectivity'] as const) {
      expect(checkSuggestion(check, validation(), context())).toBeNull();
    }
  });

  it('sends loose bodies at low resolution to Generate with a raised resolution', () => {
    const v = validation({ passed: false, disconnected: { passed: false, fragmentCount: 468, voidCount: 0, sliverCount: 0 } });
    const suggestion = checkSuggestion('connectivity', v, context({ exportResolution: 1 }));
    expect(suggestion?.text).toMatch(/Raise the resolution/);
    expect(suggestion?.action).toEqual({
      label: 'Raise resolution to 4', step: 'generate', controlId: 'export-resolution', params: { exportResolution: 4 },
    });
  });

  it('only navigates when the current settings already have the higher resolution', () => {
    const v = validation({ passed: false, manifold: { passed: false, details: '12 non-manifold edges' } });
    const suggestion = checkSuggestion('manifold', v, context({ exportResolution: 1 }, { exportResolution: 6 }));
    expect(suggestion?.action).toEqual({ label: 'Go to Generate', step: 'generate', controlId: 'export-resolution' });
  });

  it('suggests thickening at the finest resolution', () => {
    const v = validation({ passed: false, disconnected: { passed: false, fragmentCount: 3, voidCount: 0, sliverCount: 0 } });
    expect(checkSuggestion('connectivity', v, context({ exportResolution: 10 }))?.action)
      .toMatchObject({ step: 'lattice', controlId: 'wall-thickness' });
    expect(checkSuggestion('connectivity', v, context({ exportResolution: 10, latticeType: 'bcc' }))?.action)
      .toMatchObject({ step: 'lattice', controlId: 'strut-diameter' });
    const deviation = validation({ passed: false, outerDeviation: { passed: false, maxDeviation: 0.5, tolerance: 0.2, sampled: 900 } });
    expect(checkSuggestion('outerDeviation', deviation, context({ exportResolution: 10 }))?.action)
      .toMatchObject({ step: 'generate', controlId: 'tolerance' });
  });

  it('points thin walls at the wall control and a thin shell at the shell control', () => {
    const thin = validation({ passed: false, minThickness: { passed: false, minMeasured: 0.5, required: 0.8, absoluteMin: 0.4, sampled: 200 } });
    const walls = checkSuggestion('minThickness', thin, context({ wallThickness: 0.6 }));
    expect(walls?.text).toMatch(/Wall thickness is 0.6 mm, under the 0.8 mm minimum/);
    expect(walls?.action).toMatchObject({ label: 'Thicken walls', step: 'lattice', controlId: 'wall-thickness' });
    const shell = checkSuggestion('minThickness', thin, context({ shellThickness: 0.5 }));
    expect(shell?.action).toMatchObject({ step: 'shell', controlId: 'shell-thickness' });
  });

  it('asks for a finer run when a check could not be measured', () => {
    const unmeasured = validation({ passed: false, outerDeviation: { passed: false, maxDeviation: 0, tolerance: 0.2, sampled: 0 } });
    expect(checkSuggestion('outerDeviation', unmeasured, context())?.text).toMatch(/could not be measured/);
  });
});
