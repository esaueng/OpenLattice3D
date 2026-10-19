import { useStore } from '../../store/useStore';
import type { SelectionMode } from '../../types/project';
import { NumericInput } from '../NumericInput';
import { Collapsible, PanelSection, StepPanel } from '../PanelChrome';
import type { WorkflowInputs } from '../workflow';

const BRUSHES: readonly { mode: SelectionMode; label: string; hint: string; title: string; swatch?: string }[] = [
  { mode: 'keep_out', label: 'Keep-out', hint: 'Surface preserved', title: 'Mark source faces that must remain outside the generated lattice.', swatch: '#3399ff' },
  { mode: 'keep_in', label: 'Keep-in', hint: 'Stays solid', title: 'Mark source faces that should stay solid.', swatch: '#ff6633' },
  { mode: 'erase', label: 'Erase', hint: 'Remove marks', title: 'Remove keep-out and keep-in marks under the brush.' },
];

export function RegionsStep({ inputs }: { inputs: WorkflowInputs }) {
  const store = useStore();
  const painting = store.selectionMode !== 'none' && store.selectionMode !== 'place_hole';

  return (
    <StepPanel step="regions" inputs={inputs}>
      <PanelSection title="Brush">
        <div className="brush-grid" role="group" aria-label="Paint brush">
          {BRUSHES.map((brush) => (
            <button
              key={brush.mode}
              type="button"
              className={`brush-option${store.selectionMode === brush.mode ? ' active' : ''}`}
              aria-pressed={store.selectionMode === brush.mode}
              title={brush.title}
              onClick={() => store.setSelectionMode(store.selectionMode === brush.mode ? 'none' : brush.mode)}
            >
              {brush.swatch
                ? <span className="brush-swatch" style={{ background: brush.swatch }} aria-hidden="true" />
                : <span className="brush-swatch brush-swatch-erase" aria-hidden="true" />}
              <span className="brush-text">
                <strong>{brush.label}</strong>
                <small>{brush.hint}</small>
              </span>
            </button>
          ))}
        </div>
        <p className="panel-copy">
          {!painting
            ? 'Pick a brush, then drag on the model. Orbiting works again when no brush is active.'
            : store.selectionMode === 'erase'
              ? 'Drag on the model to remove marks.'
              : 'Drag on the model to paint. Hold Alt while dragging to erase.'}
        </p>
        {painting && (
          <div className="row">
            <label htmlFor="constraint-brush-radius">Brush radius (mm)</label>
            <NumericInput
              captureUndoCheckpoint={store.captureUndoCheckpoint}
              id="constraint-brush-radius"
              title="Radius around the pointer hit. Zero paints one triangle. Hold Alt while dragging to erase."
              min={0} max={100} step={0.5}
              value={store.brushRadius}
              onCommit={(next) => store.setBrushRadius(next)}
            />
          </div>
        )}
      </PanelSection>

      <PanelSection title="Painted faces">
        <dl className="facts">
          <dt><span className="legend-dot" style={{ background: '#3399ff' }} aria-hidden="true" />Keep-out</dt>
          <dd className="mono">{store.keepOutTris.size.toLocaleString()}</dd>
          <dt><span className="legend-dot" style={{ background: '#ff6633' }} aria-hidden="true" />Keep-in</dt>
          <dd className="mono">{store.keepInTris.size.toLocaleString()}</dd>
        </dl>
        <div className="button-row">
          <button type="button" className="btn btn-small" title="Undo the last edit: painting, a parameter, or the seed (Ctrl/Cmd+Z)." onClick={store.undoSelection} disabled={store.selectionUndo.length === 0}>Undo</button>
          <button type="button" className="btn btn-small" title="Redo (Ctrl/Cmd+Shift+Z)." onClick={store.redoSelection} disabled={store.selectionRedo.length === 0}>Redo</button>
          <button type="button" className="btn btn-small" onClick={store.clearSelection}>Clear</button>
        </div>
        {store.keepInTris.size > 0 && (
          <div className="row">
            <label htmlFor="keep-in-depth">Keep-in depth (mm)</label>
            <NumericInput
              captureUndoCheckpoint={store.captureUndoCheckpoint}
              id="keep-in-depth"
              title="Depth of solid material preserved below painted keep-in faces."
              min={0.1} max={100} step={0.5}
              value={store.params.keepInDepth}
              onCommit={(keepInDepth) => store.updateParams({ keepInDepth })}
            />
          </div>
        )}
      </PanelSection>

      <Collapsible title="More options">
        <div className="button-row">
          <button type="button" className="btn btn-small" title="Mark every source face as keep-out." onClick={store.selectAllKeepOut}>Select all keep-out</button>
        </div>
      </Collapsible>
    </StepPanel>
  );
}
