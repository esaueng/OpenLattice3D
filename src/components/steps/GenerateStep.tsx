import { useStore } from '../../store/useStore';
import { formatGenerationSeed } from '../../geometry/deterministic-random';
import { modelExtents } from '../../utils/model-summary';
import { buildPreflight, formatPreflight } from '../../utils/preflight';
import { useResultStaleness } from '../../store/useResultStaleness';
import { useModelImport } from '../../hooks/useModelImport';
import type { LatticeGenerationControls } from '../../hooks/useLatticeGeneration';
import { NumericInput } from '../NumericInput';
import { Collapsible, PanelSection, StepPanel } from '../PanelChrome';
import { PlayIcon } from '../icons';
import type { WorkflowInputs } from '../workflow';

const RESOLUTION_LABELS = ['Min', 'Low', 'Med', 'Good', 'High', 'Fine', 'Ultra', 'Extreme', 'Hyper', 'Max'] as const;

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

  const primaryAction = store.generating ? (
    <div className="generate-progress-track" role="status" aria-live="polite">
      <div className="progress-line">
        <span className="progress-text" title={store.progressMessage}>{store.progressMessage || 'Starting…'}</span>
        <button type="button" className="btn btn-small" title="Stop the current generation job. The previous result stays." onClick={cancelGeneration}>Cancel</button>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${store.progress * 100}%` }} />
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
            <div key={index} className={`warning preflight-${warning.level}`} role={warning.level === 'block' ? 'alert' : undefined}>
              {warning.message}
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
            title="Sampling resolution for marching cubes. Higher values increase detail and compute time."
            value={store.params.exportResolution}
            onChange={(e) => store.updateParams({ exportResolution: Number(e.target.value) })}
          >
            {RESOLUTION_LABELS.map((label, index) => (
              <option key={label} value={index + 1}>{index + 1} - {label}</option>
            ))}
          </select>
        </div>
        <div className="row">
          <label htmlFor="thin-filter">Remove features</label>
          <select
            id="thin-filter"
            title="Remove features thinner than this by morphological opening. The run log explains when the export grid cannot resolve the requested size."
            value={store.params.thinSectionFilter}
            onChange={(e) => store.updateParams({ thinSectionFilter: Number(e.target.value) })}
          >
            <option value={0}>Off</option>
            <option value={0.5}>Under 0.5mm</option>
            <option value={0.8}>Under 0.8mm</option>
            <option value={1.2}>Under 1.2mm</option>
            <option value={2}>Under 2.0mm</option>
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
