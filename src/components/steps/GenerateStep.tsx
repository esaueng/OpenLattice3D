import { useStore } from '../../store/useStore';
import { formatGenerationSeed } from '../../geometry/deterministic-random';
import { modelExtents } from '../../utils/model-summary';
import { buildPreflight, formatPreflight, gridForResolution } from '../../utils/preflight';
import {
  expectedGenerationPath,
  fullFieldRequirement,
  MAX_EXPORT_RESOLUTION_LEVEL,
  maxResolutionLevel,
} from '../../geometry/generation-limits';
import { describeGenerationProgress } from '../../utils/generation-progress';
import { useResultStaleness } from '../../store/useResultStaleness';
import { useModelImport } from '../../hooks/useModelImport';
import type { LatticeGenerationControls } from '../../hooks/useLatticeGeneration';
import { NumericInput } from '../NumericInput';
import { Collapsible, PanelSection, StepPanel } from '../PanelChrome';
import { PlayIcon } from '../icons';
import type { WorkflowInputs } from '../workflow';

const RESOLUTION_LABELS = ['Min', 'Low', 'Med', 'Good', 'High', 'Fine', 'Ultra', 'Extreme', 'Hyper', 'Max'] as const;

/** Level 1-10 keep their names; levels above run tiled only and show their grid. */
function resolutionOptionLabel(level: number): string {
  return level <= RESOLUTION_LABELS.length
    ? `${level} - ${RESOLUTION_LABELS[level - 1]}`
    : `${level} - Large ${gridForResolution(level)}³ (tiled)`;
}

function generateButtonLabel(demoModeActive: boolean, blocked: boolean, stale: boolean): string {
  if (demoModeActive) return 'Generate (close compare first)';
  if (blocked) return 'Generate anyway';
  return stale ? 'Regenerate lattice' : 'Generate lattice';
}

export function GenerateStep({ inputs, generationControls }: { inputs: WorkflowInputs; generationControls: LatticeGenerationControls }) {
  const { startGeneration, cancelGeneration } = generationControls;
  const store = useStore();
  const staleness = useResultStaleness();
  const intake = useModelImport();
  const extents = modelExtents(store.meshInfo, store.sampleShape, store.sphereRadius);
  const preflight = inputs.hasModel ? buildPreflight(store.params, extents, store.meshInfo) : null;
  const blocked = preflight?.warnings.some((w) => w.level === 'block') ?? false;
  const generationPath = expectedGenerationPath(store.params);
  const allowedResolutionLevel = maxResolutionLevel(generationPath);
  const singleFieldReason = fullFieldRequirement(store.params);
  // The raw worker message (tiles, backend, timings) stays in the run log.
  const progressView = describeGenerationProgress(store.progress, store.progressMessage);

  const primaryAction = store.generating ? (
    <div className="generate-progress-track" role="status" aria-live="polite">
      <div className="progress-line">
        <span className="progress-text">{progressView.text}</span>
        <button type="button" className="btn btn-small" title="Stop the current generation job. The previous result stays." onClick={cancelGeneration}>Cancel</button>
      </div>
      <div className="progress-bar" role="progressbar" aria-label={progressView.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressView.percent}>
        <div className="progress-fill" style={{ width: `${progressView.percent}%` }} />
      </div>
    </div>
  ) : (
    <button
      type="button"
      className={`btn ${blocked ? 'btn-caution' : 'btn-primary'} workflow-nav-next`}
      title={store.demoModeActive
        ? 'Close the comparison grid to generate a full-resolution lattice.'
        : staleness.stale
          ? `Settings changed (${staleness.changes.join(', ') || 'settings'}). Regenerate with the current settings (G).`
          : 'Start generating the lattice with the current settings (G).'}
      onClick={startGeneration}
      disabled={store.demoModeActive}
    >
      <span className="workflow-nav-label"><PlayIcon size={13} />{generateButtonLabel(store.demoModeActive, blocked, staleness.stale)}</span>
      <kbd>G</kbd>
    </button>
  );

  return (
    <StepPanel step="generate" inputs={inputs} primaryAction={primaryAction}>
      {preflight && (
        <PanelSection title="Estimate" className="preflight-section">
          <p className="preflight-summary mono" title="Estimated from the grid size; actual counts vary with the lattice.">
            {formatPreflight(preflight)}
          </p>
          {preflight.warnings.map((warning, index) => (
            <div key={index} className={`warning preflight-${warning.level}${warning.fix ? ' has-fix' : ''}`} role={warning.level === 'block' ? 'alert' : undefined}>
              <span>{warning.message}</span>
              {warning.fix && (
                <button
                  type="button"
                  className="btn btn-tiny guidance-action"
                  title="Apply this change; the estimate above updates before you generate."
                  disabled={store.generating}
                  onClick={() => store.updateParams(warning.fix!.params)}
                >
                  {warning.fix.label}
                </button>
              )}
            </div>
          ))}
        </PanelSection>
      )}

      {store.generationError && <div className="warning" role="alert">{store.generationError}</div>}

      <PanelSection title="Quality">
        <div className="row">
          <label htmlFor="export-resolution">Resolution</label>
          <select
            id="export-resolution"
            title={`Sampling resolution for marching cubes. Higher values increase detail, compute time and memory. Levels above ${RESOLUTION_LABELS.length} run in tiles and can need about 1 GB of memory.`}
            value={store.params.exportResolution}
            onChange={(e) => store.updateParams({ exportResolution: Number(e.target.value) })}
          >
            {Array.from({ length: MAX_EXPORT_RESOLUTION_LEVEL }, (_, index) => index + 1).map((level) => (
              <option key={level} value={level} disabled={level > allowedResolutionLevel}>
                {resolutionOptionLabel(level)}
              </option>
            ))}
          </select>
        </div>
        {singleFieldReason && (
          <p className="panel-copy">
            Levels above {allowedResolutionLevel} are unavailable: {singleFieldReason}.
          </p>
        )}
        <div className="row">
        </div>
        <div className="row">
          <label htmlFor="thin-filter">Remove thin features</label>
          <select
            id="thin-filter"
            title="Erase walls and struts thinner than this (morphological opening) so nothing too fragile to print survives. The run log explains when the grid is too coarse to apply it."
            value={store.params.thinSectionFilter}
            onChange={(e) => store.updateParams({ thinSectionFilter: Number(e.target.value) })}
          >
            <option value={0}>Off</option>
            <option value={0.5}>Thinner than 0.5 mm</option>
            <option value={0.8}>Thinner than 0.8 mm</option>
            <option value={1.2}>Thinner than 1.2 mm</option>
            <option value={2}>Thinner than 2.0 mm</option>
          </select>
        </div>
      </PanelSection>

      <Collapsible title="More options" subtitle="Checks and seed">
        <div className="row">
          <label htmlFor="min-feature-size">Min feature size (mm)</label>
          <NumericInput
            captureUndoCheckpoint={store.captureUndoCheckpoint}
            id="min-feature-size"
            title="Minimum manufacturable feature size target used in validation."
            value={store.params.minFeatureSize}
            min={0.3} max={5} step={0.1}
            onCommit={(minFeatureSize) => store.updateParams({ minFeatureSize })}
          />
        </div>
        <div className="row">
          <label htmlFor="tolerance">Tolerance (mm)</label>
          <NumericInput
            captureUndoCheckpoint={store.captureUndoCheckpoint}
            id="tolerance"
            title="Maximum allowed outer-surface deviation versus the source mesh."
            value={store.params.toleranceMm}
            min={0.05} max={2} step={0.05}
            onCommit={(toleranceMm) => store.updateParams({ toleranceMm })}
          />
        </div>
        <div className="row">
          <span className="seed-readout mono" title="Persisted deterministic generation seed">
            Seed {formatGenerationSeed(store.generationSeed)}
          </span>
          <button
            type="button"
            className="btn btn-small"
            title="Choose a new seed for stochastic lattices. The current result stays until you regenerate."
            onClick={intake.reseed}
            disabled={store.generating}
          >
            Reseed
          </button>
        </div>
        <p className="panel-copy">
          Runs with the same seed and settings are byte-identical. Reseeding only changes Voronoi and Spinodal results.
        </p>
      </Collapsible>
    </StepPanel>
  );
}
