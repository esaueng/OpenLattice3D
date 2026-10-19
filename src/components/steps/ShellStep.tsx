import { useStore } from '../../store/useStore';
import { NumericInput } from '../NumericInput';
import { Collapsible, PanelSection, Segmented, StepPanel } from '../PanelChrome';
import type { WorkflowInputs } from '../workflow';

type ShellMode = 'shell' | 'open' | 'band';

const SHELL_MODES = [
  { value: 'shell', label: 'Solid skin', title: 'Keep an outer shell around the lattice core.' },
  { value: 'open', label: 'Open lattice', title: 'Removes the outer shell so only lattice remains.' },
  { value: 'band', label: 'Surface band', title: 'Constrain lattice generation to a surface band, leaving inside hollow.' },
] as const;

const SHELL_COPY: Record<ShellMode, string> = {
  shell: 'A solid skin wraps the lattice core. The part keeps its outer surface.',
  open: 'No skin: the lattice is exposed everywhere, out to the part outline.',
  band: 'Lattice fills only a band under the surface; the inside is left hollow.',
};

export function ShellStep({ inputs }: { inputs: WorkflowInputs }) {
  const store = useStore();
  const { params } = store;
  const mode: ShellMode = params.surfaceOnly ? 'band' : params.noShell ? 'open' : 'shell';

  const setMode = (next: ShellMode) => store.updateParams({
    noShell: next === 'open',
    surfaceOnly: next === 'band',
  });

  return (
    <StepPanel step="shell" inputs={inputs}>
      <PanelSection title="Outer surface">
        <Segmented label="Outer surface" value={mode} options={SHELL_MODES} onChange={setMode} />
        <p className="panel-copy">{SHELL_COPY[mode]}</p>
        {mode === 'band' && (
          <div className="row">
            <label htmlFor="lattice-depth">Band depth (mm)</label>
            <NumericInput
              captureUndoCheckpoint={store.captureUndoCheckpoint}
              id="lattice-depth"
              title="Depth of the generated lattice band from the outer surface."
              value={params.surfaceDepth}
              min={1} max={50} step={0.5}
              onCommit={(surfaceDepth) => store.updateParams({ surfaceDepth })}
            />
          </div>
        )}
        {mode === 'shell' && (
          <div className="row">
            <label htmlFor="shell-thickness">Shell thickness (mm)</label>
            <NumericInput
              captureUndoCheckpoint={store.captureUndoCheckpoint}
              id="shell-thickness"
              title="Thickness of the outer shell retained around the lattice."
              value={params.shellThickness}
              min={0.3} max={10} step={0.1}
              onCommit={(shellThickness) => store.updateParams({ shellThickness })}
            />
          </div>
        )}
      </PanelSection>

      {mode === 'shell' && params.variant === 'shell_core' && (
        <Collapsible title="Escape holes" subtitle={params.escapeHoles ? 'On' : 'Off'} defaultOpen={params.escapeHoles}>
          <label className="check-label">
            <input
              id="escape-holes"
              type="checkbox"
              title="Subtract through-holes along the selected build axis to release trapped powder or resin."
              checked={params.escapeHoles}
              onChange={(e) => store.updateParams({ escapeHoles: e.target.checked })}
            />
            Drain trapped powder or resin
          </label>
          {params.escapeHoles && (
            <>
              <div className="row">
                <label htmlFor="escape-hole-axis">Build axis</label>
                <select
                  id="escape-hole-axis"
                  title="Axis followed by the escape-hole cylinders."
                  value={params.escapeHoleAxis}
                  onChange={(e) => store.updateParams({ escapeHoleAxis: e.target.value as 'x' | 'y' | 'z' })}
                >
                  <option value="x">X</option>
                  <option value="y">Y</option>
                  <option value="z">Z</option>
                </select>
              </div>
              <div className="row">
                <label htmlFor="escape-hole-diameter">Hole diameter (mm)</label>
                <NumericInput
                  captureUndoCheckpoint={store.captureUndoCheckpoint}
                  id="escape-hole-diameter"
                  title="Diameter of the powder-escape holes."
                  value={params.escapeHoleDiameter}
                  min={0.5} max={50} step={0.5}
                  onCommit={(escapeHoleDiameter) => store.updateParams({ escapeHoleDiameter })}
                />
              </div>
              <div className="row">
                <label htmlFor="escape-hole-placement">Placement</label>
                <select
                  id="escape-hole-placement"
                  title="Spread holes automatically, or click the model where each hole should pass through."
                  value={params.escapeHolePlacement}
                  onChange={(e) => {
                    const placement = e.target.value as 'auto' | 'manual';
                    store.updateParams({ escapeHolePlacement: placement });
                    if (placement !== 'manual' && store.selectionMode === 'place_hole') store.setSelectionMode('none');
                  }}
                >
                  <option value="auto">Automatic</option>
                  <option value="manual">Click on the model</option>
                </select>
              </div>
              {params.escapeHolePlacement === 'auto' ? (
                <div className="row">
                  <label htmlFor="escape-hole-count">Hole count</label>
                  <NumericInput
                    captureUndoCheckpoint={store.captureUndoCheckpoint}
                    id="escape-hole-count"
                    title="Number of powder-escape holes."
                    value={params.escapeHoleCount}
                    min={1} max={100} step={1}
                    onCommit={(next) => store.updateParams({ escapeHoleCount: Math.trunc(next) })}
                  />
                </div>
              ) : (
                <>
                  <div className="button-row">
                    <button
                      type="button"
                      className={`btn btn-small ${store.selectionMode === 'place_hole' ? 'btn-primary' : ''}`}
                      aria-pressed={store.selectionMode === 'place_hole'}
                      title="Then click the model in the Original view; a hole runs along the build axis through each click."
                      onClick={() => {
                        const placing = store.selectionMode === 'place_hole';
                        store.setSelectionMode(placing ? 'none' : 'place_hole');
                        if (!placing) store.setViewMode('original');
                      }}
                    >
                      {store.selectionMode === 'place_hole' ? 'Placing… (click model)' : 'Place holes'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={params.escapeHoleManualCenters.length === 0}
                      onClick={() => store.updateParams({ escapeHoleManualCenters: [] })}
                    >
                      Clear holes
                    </button>
                  </div>
                  <div className="info-block hole-list">
                    {params.escapeHoleManualCenters.length === 0
                      ? 'No holes placed yet. Each click adds one hole; the cylinder runs along the build axis through that point.'
                      : Array.from({ length: params.escapeHoleManualCenters.length / 3 }, (_, index) => {
                        const c = params.escapeHoleManualCenters;
                        const [x, y, z] = [c[index * 3], c[index * 3 + 1], c[index * 3 + 2]];
                        return (
                          <div key={index} className="hole-list-row">
                            <span className="mono">Hole {index + 1}: {x.toFixed(1)}, {y.toFixed(1)}, {z.toFixed(1)} mm</span>
                            <button
                              type="button"
                              className="import-notice-dismiss"
                              aria-label={`Remove hole ${index + 1}`}
                              title="Remove this hole"
                              onClick={() => store.updateParams({
                                escapeHoleManualCenters: c.filter((_, i) => Math.floor(i / 3) !== index),
                              })}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                  </div>
                </>
              )}
            </>
          )}
        </Collapsible>
      )}
    </StepPanel>
  );
}
