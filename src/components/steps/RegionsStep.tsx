import { useState } from 'react';
import { useStore } from '../../store/useStore';
import { DEFAULT_FACING_TOLERANCE_DEG, FACE_DIRECTIONS, facesFacingDirection, type FaceDirection } from '../../geometry/face-selection';
import type { SelectionMode } from '../../types/project';
import { NumericInput } from '../NumericInput';
import { Collapsible, PanelSection, Segmented, StepPanel } from '../PanelChrome';
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
              describedBy="brush-radius-hint"
              min={0} max={100} step={0.5}
              value={store.brushRadius}
              onCommit={(next) => store.setBrushRadius(next)}
            />
          </div>
        )}
        {painting && (
          <p className="field-hint" id="brush-radius-hint">Faces within this distance of the pointer are painted. 0 paints one triangle.</p>
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
              describedBy="keep-in-depth-hint"
              min={0.1} max={100} step={0.5}
              value={store.params.keepInDepth}
              onCommit={(keepInDepth) => store.updateParams({ keepInDepth })}
            />
          </div>
        )}
        {store.keepInTris.size > 0 && (
          <p className="field-hint" id="keep-in-depth-hint">How deep the solid material reaches below keep-in faces.</p>
        )}
      </PanelSection>

      <Collapsible title="Select without painting">
        <DirectionSelection />
        <div className="button-row">
          <button type="button" className="btn btn-small" aria-describedby="select-all-hint" onClick={store.selectAllKeepOut}>Select all keep-out</button>
        </div>
        <p className="field-hint" id="select-all-hint">Marks every source face as keep-out.</p>
      </Collapsible>
    </StepPanel>
  );
}

type MarkRegion = 'keep_out' | 'keep_in';

const MARK_REGIONS = [
  { value: 'keep_out', label: 'Keep-out' },
  { value: 'keep_in', label: 'Keep-in' },
] as const;

/** A keyboard alternative to the brush: mark every face that points one way. */
function DirectionSelection() {
  const originalMesh = useStore((s) => s.originalMesh);
  const markFaces = useStore((s) => s.markFaces);
  const addLog = useStore((s) => s.addLog);
  const [region, setRegion] = useState<MarkRegion>('keep_out');
  const [direction, setDirection] = useState<FaceDirection>('+z');
  const [tolerance, setTolerance] = useState(DEFAULT_FACING_TOLERANCE_DEG);
  const [status, setStatus] = useState('');

  const mark = () => {
    if (!originalMesh) return;
    const faces = facesFacingDirection(originalMesh, FACE_DIRECTIONS[direction].vector, tolerance);
    markFaces(faces, region);
    const regionLabel = region === 'keep_out' ? 'keep-out' : 'keep-in';
    const message = faces.length > 0
      ? `Marked ${faces.length.toLocaleString()} face${faces.length === 1 ? '' : 's'} facing ${FACE_DIRECTIONS[direction].label} as ${regionLabel}.`
      : `No faces face ${FACE_DIRECTIONS[direction].label} within ${tolerance}°.`;
    setStatus(message);
    addLog(message);
  };

  return (
    <div className="direction-select">
      <div className="row">
        <label htmlFor="mark-direction">Faces pointing</label>
        <select id="mark-direction" value={direction} onChange={(e) => setDirection(e.target.value as FaceDirection)}>
          {(Object.keys(FACE_DIRECTIONS) as FaceDirection[]).map((key) => (
            <option key={key} value={key}>{FACE_DIRECTIONS[key].label}</option>
          ))}
        </select>
      </div>
      <div className="row">
        <label htmlFor="mark-tolerance">Within angle (°)</label>
        <NumericInput
          id="mark-tolerance"
          title="How far a face may tilt from the direction and still be marked."
          describedBy="mark-tolerance-hint"
          value={tolerance}
          min={0} max={90} step={5}
          onCommit={setTolerance}
        />
      </div>
      <p className="field-hint" id="mark-tolerance-hint">How far a face may tilt from that direction and still count. 0° takes only flat faces.</p>
      <div className="row">
        <span className="row-text" aria-hidden="true">Mark as</span>
        <div className="row-control">
          <Segmented label="Mark as" value={region} options={MARK_REGIONS} onChange={setRegion} />
        </div>
      </div>
      <div className="button-row">
        <button type="button" className="btn btn-small" disabled={!originalMesh} onClick={mark}>
          Mark faces
        </button>
      </div>
      <p className="field-hint" role="status" aria-live="polite">{status}</p>
    </div>
  );
}
