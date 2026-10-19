import { useStore } from '../../store/useStore';
import type { LatticeType } from '../../types/project';
import { isSheetType } from '../../geometry/lattice';
import { cellsAcrossShortestSide, modelExtents } from '../../utils/model-summary';
import { useModelImport } from '../../hooks/useModelImport';
import { NumericInput } from '../NumericInput';
import { PanelSection, StepPanel } from '../PanelChrome';
import { GridIcon } from '../icons';
import type { WorkflowInputs } from '../workflow';

const LATTICE_FAMILIES: readonly { family: string; types: readonly { id: LatticeType; label: string }[] }[] = [
  {
    family: 'TPMS sheet',
    types: [
      { id: 'gyroid', label: 'Gyroid' },
      { id: 'schwarzP', label: 'Schwarz P' },
      { id: 'schwarzD', label: 'Schwarz D' },
      { id: 'neovius', label: 'Neovius' },
      { id: 'iwp', label: 'IWP' },
    ],
  },
  {
    family: 'Strut',
    types: [
      { id: 'bcc', label: 'BCC' },
      { id: 'octet', label: 'Octet' },
      { id: 'diamond', label: 'Diamond' },
      { id: 'hexagon', label: 'Hexagon' },
      { id: 'triangle', label: 'Triangle' },
    ],
  },
  {
    family: 'Stochastic',
    types: [
      { id: 'voronoi', label: 'Voronoi' },
      { id: 'spinodal', label: 'Spinodal' },
    ],
  },
];

const LATTICE_TITLES: Partial<Record<LatticeType, string>> = {
  schwarzP: 'Schwarz P (Primitive)',
  schwarzD: 'Schwarz D (Diamond)',
  iwp: 'IWP (Schoen)',
  octet: 'Octet Truss (FCC)',
  hexagon: 'Hexagon surface lattice',
  triangle: 'Triangle surface lattice',
  voronoi: 'Voronoi Foam',
};

export function LatticeStep({ inputs }: { inputs: WorkflowInputs }) {
  const store = useStore();
  const intake = useModelImport();
  const extents = modelExtents(store.meshInfo, store.sampleShape, store.sphereRadius);
  const cellsAcross = extents ? cellsAcrossShortestSide(extents.size, store.params.cellSize) : 0;
  const sheet = isSheetType(store.params.latticeType);

  return (
    <StepPanel step="lattice" inputs={inputs}>
      <PanelSection title="Cell type">
        <div className="lattice-picker" role="radiogroup" aria-label="Lattice type">
          {LATTICE_FAMILIES.map((group) => (
            <div key={group.family} className="lattice-family">
              <div className="lattice-family-label">{group.family}</div>
              <div className="lattice-family-options">
                {group.types.map((type) => {
                  const selected = store.params.latticeType === type.id;
                  return (
                    <button
                      key={type.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`lattice-option${selected ? ' active' : ''}`}
                      title={LATTICE_TITLES[type.id] ?? type.label}
                      onClick={() => store.setLatticeType(type.id)}
                    >
                      {type.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={`btn btn-block compare-toggle${store.demoModeActive ? ' btn-active' : ''}`}
          aria-pressed={store.demoModeActive}
          title="Show all 12 lattice types side by side for the current model. Click a tile to pick it."
          disabled={store.generating}
          onClick={() => intake.toggleDemoGrid(!store.demoModeActive)}
        >
          <GridIcon size={15} />
          {store.demoModeActive ? 'Close the comparison' : 'Compare all 12 on this part'}
        </button>
      </PanelSection>

      <PanelSection title="Size">
        <div className="row">
          <label htmlFor="cell-size">Cell size (mm)</label>
          <NumericInput
            captureUndoCheckpoint={store.captureUndoCheckpoint}
            id="cell-size"
            title="Controls overall lattice spacing. Larger values create bigger cells."
            value={store.params.cellSize}
            min={2} max={50} step={0.5}
            onCommit={(cellSize) => store.updateParams({ cellSize })}
          />
        </div>
        {/* Keyed: both branches render a .row at the same child slot, so without a
            key React reuses the instance and carries an in-progress edit from one
            parameter to the other. */}
        {sheet ? (
          <div className="row" key="wall-thickness">
            <label htmlFor="wall-thickness">Wall thickness (mm)</label>
            <NumericInput
              captureUndoCheckpoint={store.captureUndoCheckpoint}
              id="wall-thickness"
              title="Thickness of sheet-style TPMS surfaces."
              value={store.params.wallThickness}
              min={0.3} max={5} step={0.1}
              onCommit={(wallThickness) => store.updateParams({ wallThickness })}
            />
          </div>
        ) : (
          <div className="row" key="strut-diameter">
            <label htmlFor="strut-diameter">Strut diameter (mm)</label>
            <NumericInput
              captureUndoCheckpoint={store.captureUndoCheckpoint}
              id="strut-diameter"
              title="Diameter of strut members for strut-based lattices."
              value={store.params.strutDiameter}
              min={0.3} max={5} step={0.1}
              onCommit={(strutDiameter) => store.updateParams({ strutDiameter })}
            />
          </div>
        )}
        {inputs.hasModel && extents && (
          <p className="panel-copy">
            <span className="mono">{cellsAcross.toFixed(1)}</span> cells across the shortest side at {store.params.cellSize} mm.
          </p>
        )}
      </PanelSection>
    </StepPanel>
  );
}
