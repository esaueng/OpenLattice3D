// Results lead with the verdict, then four numbers, then the checks behind them.
import { useMemo, type ReactNode } from 'react';
import { useStore } from '../../store/useStore';
import { massGrams, meshVolumeMm3, proceduralSolidVolumeMm3 } from '../../geometry/mesh-stats';
import { boundedNumberInput } from '../../utils/numeric-input';
import { useResultStaleness } from '../../store/useResultStaleness';
import { summarizeValidation, VALIDATION_CHECK_COUNT } from '../../utils/validation-summary';
import { ExportControls } from '../ExportControls';
import { PinnedRunPanel } from '../PinnedRunPanel';
import { Collapsible, PanelSection, StepPanel } from '../PanelChrome';
import { AlertIcon, CircleCheckIcon, CircleXIcon, ClockIcon } from '../icons';
import type { WorkflowInputs } from '../workflow';

function formatChangeList(changes: string[]): string {
  if (changes.length === 0) return 'settings';
  if (changes.length <= 3) return changes.join(', ');
  return `${changes.slice(0, 3).join(', ')} and ${changes.length - 3} more`;
}

export function ResultsStep({ inputs }: { inputs: WorkflowInputs }) {
  const validation = useStore((s) => s.validation);
  const resultMesh = useStore((s) => s.resultMesh);
  const originalMesh = useStore((s) => s.originalMesh);
  const meshInfo = useStore((s) => s.meshInfo);
  const sampleShape = useStore((s) => s.sampleShape);
  const sphereRadius = useStore((s) => s.sphereRadius);
  const generating = useStore((s) => s.generating);
  const validationProgress = useStore((s) => s.validationProgress);
  const density = useStore((s) => s.params.materialDensityGPerCm3);
  const updateParams = useStore((s) => s.updateParams);
  const showThinFeatures = useStore((s) => s.showThinFeatures);
  const setShowThinFeatures = useStore((s) => s.setShowThinFeatures);
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const showPinnedRun = useStore((s) => s.showPinnedRun);
  const staleness = useResultStaleness();
  const thinPointCount = (validation?.minThickness.thinPoints?.length ?? 0) / 3;
  const checks = summarizeValidation(validation, Boolean(resultMesh), generating, staleness.stale, validationProgress);

  const statistics = useMemo(() => {
    if (!resultMesh || !validation?.manifold.passed) return null;
    const resultVolume = meshVolumeMm3(resultMesh);
    const sourceVolume = sampleShape
      ? proceduralSolidVolumeMm3(sampleShape, sphereRadius)
      : originalMesh && meshInfo?.isWatertight
        ? meshVolumeMm3(originalMesh)
        : null;
    return {
      resultVolume,
      sourceVolume,
      relativeDensity: sourceVolume && sourceVolume > 0 ? resultVolume / sourceVolume : null,
    };
  }, [meshInfo?.isWatertight, originalMesh, resultMesh, sampleShape, sphereRadius, validation?.manifold.passed]);

  const verdict = resultVerdict(checks.tone, checks.failedLabels, validationProgress);
  const thinnest = validation && validation.minThickness.sampled > 0
    ? (validation.minThickness.absoluteMin ?? validation.minThickness.minMeasured)
    : null;

  const heading = (
    <div className={`result-verdict is-${verdict.tone}`}>
      <span className="result-verdict-icon">{verdict.icon}</span>
      <div>
        <h2>{verdict.title}</h2>
        <p>{verdict.message}</p>
      </div>
    </div>
  );

  return (
    <StepPanel step="results" inputs={inputs} heading={heading} primaryAction={<span />}>
      {staleness.stale && (
        <div className="warning stale-banner" role="status">
          Out of date: {formatChangeList(staleness.changes)} changed since this run. Regenerate to refresh.
        </div>
      )}
      {showPinnedRun && <p className="panel-copy">The viewer shows the pinned run; these numbers are the current run.</p>}

      {resultMesh && (
        <div className="kpi-grid">
          <Kpi
            label="Relative density"
            value={statistics?.relativeDensity != null ? (statistics.relativeDensity * 100).toFixed(1) : '—'}
            unit={statistics?.relativeDensity != null ? '%' : undefined}
          />
          {density > 0 && statistics ? (
            <Kpi label="Estimated mass" value={massGrams(statistics.resultVolume, density).toFixed(2)} unit="g" />
          ) : (
            <Kpi label="Lattice volume" value={statistics ? statistics.resultVolume.toFixed(1) : '—'} unit={statistics ? 'mm³' : undefined} />
          )}
          <Kpi label="Thinnest feature" value={thinnest !== null ? thinnest.toFixed(2) : '—'} unit={thinnest !== null ? 'mm' : undefined} />
          <Kpi label="Triangles" value={resultMesh.triCount.toLocaleString()} />
        </div>
      )}
      {resultMesh && validation && !validation.manifold.passed && (
        <p className="panel-copy">Volume unavailable: the result mesh is not closed and manifold.</p>
      )}

      {validation && (
        <PanelSection
          id="validation-panel"
          title={`Checks${showPinnedRun ? ' (current run, not the pinned one)' : ''}`}
          aside={<span className="panel-block-meta">{VALIDATION_CHECK_COUNT - checks.failedCount} of {VALIDATION_CHECK_COUNT} pass</span>}
        >
          <ul className="check-list">
            <CheckRow passed={validation.outerDeviation.passed} name="Outer deviation">
              Max <span className="mono">{validation.outerDeviation.maxDeviation.toFixed(3)} mm</span> · limit {validation.outerDeviation.tolerance} mm
            </CheckRow>
            <CheckRow passed={validation.minThickness.passed} name="Min thickness">
              {validation.minThickness.sampled > 0 ? (
                <>
                  {/* The verdict is decided by the thinnest ray, so that number leads. */}
                  <div>
                    Thinnest <span className="mono">{(validation.minThickness.absoluteMin ?? validation.minThickness.minMeasured).toFixed(3)} mm</span>
                    {' '}· needs ≥ {validation.minThickness.required} mm
                  </div>
                  <div className="check-detail-muted">
                    1% of samples are under {validation.minThickness.minMeasured.toFixed(3)} mm
                    {' '}({validation.minThickness.sampled.toLocaleString()} rays)
                  </div>
                  {thinPointCount > 0 && (
                    <button
                      type="button"
                      className={`btn btn-tiny ${showThinFeatures ? 'btn-active' : ''}`}
                      aria-pressed={showThinFeatures}
                      title="Mark the sampled spots that measured thinner than the target on the model."
                      onClick={() => {
                        const next = !showThinFeatures;
                        setShowThinFeatures(next);
                        if (next && viewMode === 'original') setViewMode('xray');
                      }}
                    >
                      {showThinFeatures ? 'Hide thin spots' : `Show ${thinPointCount} thin spot${thinPointCount === 1 ? '' : 's'} on model`}
                    </button>
                  )}
                </>
              ) : (
                <>Not measured: no usable thickness samples · needs ≥ {validation.minThickness.required} mm</>
              )}
            </CheckRow>
            <CheckRow passed={validation.manifold.passed} name="Manifold / watertight">
              {validation.manifold.details}
            </CheckRow>
            <CheckRow passed={validation.disconnected.passed} name="Connectivity">
              {validation.disconnected.fragmentCount} solid {validation.disconnected.fragmentCount === 1 ? 'body' : 'bodies'} · needs 1
              {(validation.disconnected.voidCount ?? 0) > 0 && ` · ${validation.disconnected.voidCount} enclosed void${validation.disconnected.voidCount === 1 ? '' : 's'}`}
              {(validation.disconnected.sliverCount ?? 0) > 0 && ` · ${validation.disconnected.sliverCount} negligible sliver${validation.disconnected.sliverCount === 1 ? '' : 's'}`}
            </CheckRow>
          </ul>
          {validation.warnings.length > 0 && (
            <div className="warnings">
              {validation.warnings.map((w, i) => (
                <div key={i} className="warning">{w}</div>
              ))}
            </div>
          )}
        </PanelSection>
      )}

      <ExportControls />

      {resultMesh && (
        <Collapsible title="Material density" subtitle={density > 0 ? `${density} g/cm³` : 'Off'}>
          <div className="row">
            <label htmlFor="material-density">Density (g/cm³)</label>
            <input
              id="material-density"
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={density}
              title="Enter a material density to enable mass estimation; zero disables it."
              onChange={(event) => updateParams({
                materialDensityGPerCm3: boundedNumberInput(event.target.value, density, 0, 100),
              })}
            />
          </div>
          {statistics && (
            <dl className="facts">
              <dt>Lattice volume</dt><dd className="mono">{statistics.resultVolume.toFixed(1)} mm³</dd>
              {statistics.sourceVolume !== null && statistics.relativeDensity !== null && (
                <>
                  <dt>Solid volume</dt><dd className="mono">{statistics.sourceVolume.toFixed(1)} mm³</dd>
                  <dt>Volume reduction</dt><dd className="mono">{((1 - statistics.relativeDensity) * 100).toFixed(1)}%</dd>
                </>
              )}
            </dl>
          )}
        </Collapsible>
      )}

      <PinnedRunPanel />
    </StepPanel>
  );
}

function Kpi({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="kpi">
      <span>{label}</span>
      <strong className="mono" aria-label={unit ? `${value} ${unit}` : value}>
        {value}{unit && <small>{unit}</small>}
      </strong>
    </div>
  );
}

function CheckRow({ passed, name, children }: { passed: boolean; name: string; children: ReactNode }) {
  return (
    <li className={`check ${passed ? 'pass' : 'fail'}`}>
      <span className="check-icon" aria-hidden="true">{passed ? <CircleCheckIcon size={16} /> : <CircleXIcon size={16} />}</span>
      <div>
        <strong>{name}<span className="visually-hidden">: {passed ? 'passed' : 'failed'}</span></strong>
        <div className="check-detail">{children}</div>
      </div>
    </li>
  );
}

type VerdictTone = 'pass' | 'fail' | 'warn' | 'running';

function resultVerdict(
  tone: ReturnType<typeof summarizeValidation>['tone'],
  failedLabels: string[],
  validationProgress: number | null,
): { tone: VerdictTone; title: string; message: string; icon: ReactNode } {
  switch (tone) {
    case 'pass':
      return { tone: 'pass', title: 'All checks passed', message: 'Deviation, wall thickness, manifoldness and connectivity are within the limits you set.', icon: <CircleCheckIcon size={26} strokeWidth={1.8} /> };
    case 'fail':
      return {
        tone: 'fail',
        title: `${failedLabels.length} of ${VALIDATION_CHECK_COUNT} checks failed`,
        message: `Failing: ${failedLabels.join(', ')}. The exported mesh may not be printable.`,
        icon: <CircleXIcon size={26} strokeWidth={1.8} />,
      };
    case 'stale':
      return {
        tone: 'warn',
        title: 'Result is out of date',
        message: failedLabels.length > 0
          ? `The previous run failed ${failedLabels.length} of ${VALIDATION_CHECK_COUNT} checks. Regenerate to check the current settings.`
          : 'The checks below describe the previous settings. Regenerate to check the current ones.',
        icon: <AlertIcon size={26} strokeWidth={1.8} />,
      };
    case 'unvalidated':
      return { tone: 'warn', title: 'Not validated', message: 'The last run was cancelled or failed before the checks completed.', icon: <AlertIcon size={26} strokeWidth={1.8} /> };
    case 'running':
      return {
        tone: 'running',
        title: validationProgress !== null ? `Checking… ${Math.round(validationProgress * 100)}%` : 'Generating…',
        message: 'Measuring thickness, deviation and topology. Anything exported now is the previous result.',
        icon: <ClockIcon size={26} strokeWidth={1.8} />,
      };
    default:
      return { tone: 'running', title: 'No result yet', message: 'Generate a lattice to run the manufacturability checks.', icon: <ClockIcon size={26} strokeWidth={1.8} /> };
  }
}
