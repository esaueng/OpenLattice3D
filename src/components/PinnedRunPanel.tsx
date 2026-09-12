// Keep one result aside and flip between it and the current one in the viewer.
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/useStore';
import { describeSnapshotChanges, type GenerationSnapshot } from '../store/generation-snapshot';
import { selectGenerationInputs } from '../store/useResultStaleness';
import { summarizeValidation } from '../utils/validation-summary';
import type { LatticeParams } from '../types/project';

const DIFF_LABELS: Partial<Record<keyof LatticeParams, string>> = {
  latticeType: 'type', cellSize: 'cell', wallThickness: 'wall', strutDiameter: 'strut',
  shellThickness: 'shell', exportResolution: 'resolution', minFeatureSize: 'min feature',
  toleranceMm: 'tolerance', escapeHoles: 'holes', surfaceOnly: 'surface-only', noShell: 'no shell',
  thinSectionFilter: 'remove features', surfaceDepth: 'depth', escapeHoleCount: 'hole count',
  escapeHoleDiameter: 'hole Ø',
};

function diffParams(a: GenerationSnapshot | null, b: GenerationSnapshot | null): string[] {
  if (!a || !b) return [];
  const out: string[] = [];
  for (const key of Object.keys(DIFF_LABELS) as (keyof LatticeParams)[]) {
    if (a.params[key] !== b.params[key]) out.push(`${DIFF_LABELS[key]} ${String(a.params[key])} → ${String(b.params[key])}`);
  }
  if (a.generationSeed !== b.generationSeed) out.push('seed');
  if (a.keepOutCount !== b.keepOutCount || a.keepInCount !== b.keepInCount) out.push('painted faces');
  return out;
}

export function PinnedRunPanel() {
  const resultMesh = useStore((s) => s.resultMesh);
  const resultSnapshot = useStore((s) => s.resultSnapshot);
  const pinnedRun = useStore((s) => s.pinnedRun);
  const showPinnedRun = useStore((s) => s.showPinnedRun);
  const pinCurrentResult = useStore((s) => s.pinCurrentResult);
  const unpinResult = useStore((s) => s.unpinResult);
  const setShowPinnedRun = useStore((s) => s.setShowPinnedRun);
  // Select the raw fields (stable references) and build the inputs object once per change.
  const inputSlice = useStore(useShallow((s) => ({
    params: s.params,
    generationSeed: s.generationSeed,
    originalMesh: s.originalMesh,
    meshFileName: s.meshFileName,
    sampleShape: s.sampleShape,
    sphereMode: s.sphereMode,
    sphereRadius: s.sphereRadius,
    keepOutTris: s.keepOutTris,
    keepInTris: s.keepInTris,
  })));
  const inputs = useMemo(() => selectGenerationInputs(inputSlice), [inputSlice]);

  const diff = useMemo(() => diffParams(pinnedRun?.snapshot ?? null, resultSnapshot), [pinnedRun, resultSnapshot]);
  const pinnedVsForm = useMemo(
    () => (pinnedRun?.snapshot ? describeSnapshotChanges(pinnedRun.snapshot, inputs) : []),
    [inputs, pinnedRun],
  );
  if (!resultMesh && !pinnedRun) return null;

  const pinnedChecks = pinnedRun ? summarizeValidation(pinnedRun.validation, true, false) : null;
  const isSameAsCurrent = pinnedRun !== null && pinnedRun.resultMesh === resultMesh;

  return (
    <section className="panel-section pinned-run" aria-label="Pinned run">
      <h3>Compare runs</h3>
      {!pinnedRun ? (
        <>
          <p className="info-text">Pin this result, change settings, generate again, then flip between the two.</p>
          <button type="button" className="btn btn-small" style={{ marginTop: '8px' }} onClick={pinCurrentResult} disabled={!resultMesh}>
            Pin this result
          </button>
        </>
      ) : (
        <>
          <div className="info-block">
            <div><strong>Pinned:</strong> {pinnedRun.resultMesh.triCount.toLocaleString()} tris · {pinnedChecks?.label.replace('Checks: ', '')}</div>
            <div>
              <strong>Versus current result:</strong>{' '}
              {isSameAsCurrent ? 'same run' : diff.length === 0 ? 'no parameter differences' : diff.join(' · ')}
            </div>
            {pinnedVsForm.length > 0 && (
              <div><strong>Form differs by:</strong> {pinnedVsForm.join(', ')}</div>
            )}
          </div>
          <div className="row" style={{ gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
            <button
              type="button"
              className={`btn btn-small ${showPinnedRun ? 'btn-active' : ''}`}
              aria-pressed={showPinnedRun}
              title="Show the pinned run in the result views instead of the current one."
              onClick={() => setShowPinnedRun(!showPinnedRun)}
              disabled={isSameAsCurrent}
            >
              {showPinnedRun ? 'Showing pinned' : 'Show pinned'}
            </button>
            <button type="button" className="btn btn-small" onClick={pinCurrentResult} disabled={!resultMesh || isSameAsCurrent} title="Replace the pinned run with the current result.">
              Pin current instead
            </button>
            <button type="button" className="btn btn-small" onClick={unpinResult}>Unpin</button>
          </div>
        </>
      )}
    </section>
  );
}
