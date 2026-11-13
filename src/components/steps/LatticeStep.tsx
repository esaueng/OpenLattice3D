import { useStore } from '../../store/useStore';
import {
  CELL_SCALE_MAX,
  CELL_SCALE_MIN,
  DEFAULT_PARAMS,
  LATTICE_ROTATION_LIMIT_DEG,
  type LatticeType,
} from '../../types/project';
import { isIdentityLatticeOrientation } from '../../geometry/lattice-transform';
import { isSheetType } from '../../geometry/lattice';
import { cellsAcrossShortestSide, effectiveCellSizes, modelExtents } from '../../utils/model-summary';
import { useModelImport } from '../../hooks/useModelImport';
import { NumericInput } from '../NumericInput';
import { Collapsible, PanelSection, StepPanel } from '../PanelChrome';
import { GridIcon } from '../icons';
import { LatticeThumbnail } from '../LatticeThumbnail';
import { useRadioGroup } from '../../hooks/useRadioGroup';
import type { WorkflowInputs } from '../workflow';

type LatticeOption = { id: LatticeType; label: string; description: string };

const LATTICE_FAMILIES: readonly { family: string; note: string; types: readonly LatticeOption[] }[] = [
  {
    family: 'TPMS sheet',
    note: 'Triply periodic minimal surfaces: smooth, continuous walls with no sharp nodes.',
    types: [
      { id: 'gyroid', label: 'Gyroid', description: 'Nearly isotropic and self-supporting at any angle. The all-round default.' },
      { id: 'schwarzP', label: 'Schwarz P', description: 'Primitive: round pores on a cubic grid. Large openings drain easily.' },
      { id: 'schwarzD', label: 'Schwarz D', description: 'Diamond: dense interwoven walls with high stiffness and surface area.' },
      { id: 'neovius', label: 'Neovius', description: 'Thick nodes and small pores. Stiff, but slower to drain.' },
      { id: 'iwp', label: 'IWP', description: 'Schoen I-WP: large and small cavities. Good for energy absorption.' },
    ],
  },
  {
    family: 'Strut',
    note: 'Beams joined at nodes, like a truss. Size them with the strut diameter.',
    types: [
      { id: 'bcc', label: 'BCC', description: 'Body-centred cubic: diagonal struts. Light and compliant, for cushioning.' },
      { id: 'octet', label: 'Octet', description: 'Octet truss (FCC): the stiffest strut lattice for its weight.' },
      { id: 'diamond', label: 'Diamond', description: 'Tetrahedral struts like a diamond crystal. Open and self-supporting.' },
    ],
  },
  {
    family: 'Perforated skin',
    note: 'Holes cut through a band under the surface; selecting one switches to a surface band.',
    types: [
      { id: 'hexagon', label: 'Hexagon', description: 'Honeycomb holes through the skin. A light, perforated shell.' },
      { id: 'triangle', label: 'Triangle', description: 'Triangular holes through the skin. A finer perforation pattern.' },
    ],
  },
  {
    family: 'Stochastic',
    note: 'Irregular, foam-like cells. The pattern is fixed by the generation seed.',
    types: [
      { id: 'voronoi', label: 'Voronoi', description: 'Random foam cells, bone-like. Open cell, so it drains well.' },
      { id: 'spinodal', label: 'Spinodal', description: 'A smooth random sheet. Isotropic, open, no repeating cell.' },
    ],
  },
];

const AXES = ['X', 'Y', 'Z'] as const;

function withAxis(values: readonly [number, number, number], axis: number, value: number): [number, number, number] {
  const next: [number, number, number] = [values[0], values[1], values[2]];
  next[axis] = value;
  return next;
}

const LATTICE_ORDER: readonly LatticeType[] = LATTICE_FAMILIES.flatMap((group) => group.types.map((type) => type.id));

export function LatticeStep({ inputs }: { inputs: WorkflowInputs }) {
  const store = useStore();
  const intake = useModelImport();
  const extents = modelExtents(store.meshInfo, store.sampleShape, store.sphereRadius);
  const fitCellSize = effectiveCellSizes(store.params.cellSize, store.params.cellScale).largest;
  const cellsAcross = extents ? cellsAcrossShortestSide(extents.size, fitCellSize) : 0;
  const sheet = isSheetType(store.params.latticeType);
  // Hexagon/triangle in conformal mode generate a perforated surface band that
  // ignores the lattice field, so grading has nothing to thicken.
  const perforatedBand = store.params.variant === 'implicit_conformal'
    && (store.params.latticeType === 'hexagon' || store.params.latticeType === 'triangle');
  // One decimal keeps 0.07 from showing as 7.000000000000001.
  const gradientPercent = Math.round(store.params.gradientStrength * 1000) / 10;
  const nominalThickness = sheet ? store.params.wallThickness : store.params.strutDiameter;
  const gradientSkinThickness = (nominalThickness * (1 + store.params.gradientStrength)).toFixed(2);
  const rotation = store.params.latticeRotationDeg ?? DEFAULT_PARAMS.latticeRotationDeg;
  const cellScale = store.params.cellScale ?? DEFAULT_PARAMS.cellScale;
  const orientationIsDefault = isIdentityLatticeOrientation(store.params);
  const orientationSummary = orientationIsDefault
    ? 'Axis-aligned'
    : `${rotation.map((angle) => `${angle}°`).join(' / ')} · ×${cellScale.join(' / ')}`;
  const radio = useRadioGroup({
    values: LATTICE_ORDER,
    selected: store.params.latticeType,
    onSelect: store.setLatticeType,
  });

  return (
    <StepPanel step="lattice" inputs={inputs}>
      <PanelSection title="Cell type">
        <div className="lattice-picker" role="radiogroup" aria-label="Lattice type">
          {LATTICE_FAMILIES.map((group, groupIndex) => (
            <div key={group.family} className="lattice-family" role="group" aria-labelledby={`lattice-family-${groupIndex}`}>
              <div className="lattice-family-label" id={`lattice-family-${groupIndex}`}>{group.family}</div>
              <p className="lattice-family-note">{group.note}</p>
              <div className="lattice-family-options">
                {group.types.map((type) => {
                  const selected = store.params.latticeType === type.id;
                  return (
                    <button
                      key={type.id}
                      type="button"
                      className={`lattice-option${selected ? ' active' : ''}`}
                      aria-labelledby={`lattice-name-${type.id}`}
                      aria-describedby={`lattice-desc-${type.id}`}
                      {...radio(type.id, LATTICE_ORDER.indexOf(type.id))}
                    >
                      <LatticeThumbnail type={type.id} active={selected} />
                      <span className="lattice-option-text">
                        <span className="lattice-option-name" id={`lattice-name-${type.id}`}>{type.label}</span>
                        <span className="lattice-option-desc" id={`lattice-desc-${type.id}`}>{type.description}</span>
                      </span>
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
            describedBy="cell-size-hint"
            value={store.params.cellSize}
            min={2} max={50} step={0.5}
            onCommit={(cellSize) => store.updateParams({ cellSize })}
          />
        </div>
        <p className="field-hint" id="cell-size-hint">Length of one repeating cell. Bigger cells give larger openings and use less material.</p>
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
              describedBy="lattice-thickness-hint"
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
              describedBy="lattice-thickness-hint"
              value={store.params.strutDiameter}
              min={0.3} max={5} step={0.1}
              onCommit={(strutDiameter) => store.updateParams({ strutDiameter })}
            />
          </div>
        )}
        <p className="field-hint" id="lattice-thickness-hint">
          {sheet
            ? 'Thickness of each sheet wall. Keep it above your printer\'s minimum feature size.'
            : 'Diameter of each strut, or the wall between holes. Keep it above your printer\'s minimum feature size.'}
        </p>
        {inputs.hasModel && extents && (
          <p className="panel-copy">
            <span className="mono">{cellsAcross.toFixed(1)}</span> cells across the shortest side at {Number(fitCellSize.toFixed(2))} mm{fitCellSize !== store.params.cellSize ? ' (longest stretched cell edge)' : ''}.
          </p>
        )}
      </PanelSection>

      <Collapsible title="Orientation" subtitle={orientationSummary}>
        <p className="field-hint" id="lattice-orientation-hint">
          Rotate the lattice to align struts with load paths or print direction. Angles turn the lattice about the
          part's X, then Y, then Z axes.
        </p>
        {AXES.map((axis, index) => (
          <div className="row" key={`rotation-${axis}`}>
            <label htmlFor={`lattice-rotation-${axis.toLowerCase()}`}>Rotation {axis} (°)</label>
            <NumericInput
              captureUndoCheckpoint={store.captureUndoCheckpoint}
              id={`lattice-rotation-${axis.toLowerCase()}`}
              title={`Lattice rotation about the ${axis} axis, in degrees.`}
              describedBy="lattice-orientation-hint"
              value={rotation[index]}
              min={-LATTICE_ROTATION_LIMIT_DEG} max={LATTICE_ROTATION_LIMIT_DEG} step={5}
              onCommit={(angle) => store.updateParams({ latticeRotationDeg: withAxis(rotation, index, angle) })}
            />
          </div>
        ))}
        <p className="field-hint" id="lattice-stretch-hint">
          Stretch cells: multiplies the cell size along each lattice axis. Wall and strut thickness stay in millimetres.
        </p>
        {AXES.map((axis, index) => (
          <div className="row" key={`stretch-${axis}`}>
            <label htmlFor={`lattice-stretch-${axis.toLowerCase()}`}>Stretch {axis} (×)</label>
            <NumericInput
              captureUndoCheckpoint={store.captureUndoCheckpoint}
              id={`lattice-stretch-${axis.toLowerCase()}`}
              title={`Cell size multiplier along the lattice ${axis} axis.`}
              describedBy="lattice-stretch-hint"
              value={cellScale[index]}
              min={CELL_SCALE_MIN} max={CELL_SCALE_MAX} step={0.25}
              onCommit={(factor) => store.updateParams({ cellScale: withAxis(cellScale, index, factor) })}
            />
          </div>
        ))}
        {perforatedBand && (
          <p className="field-hint" id="lattice-orientation-perforated-hint">
            Perforated skins place each hole along the local surface normal, so orientation and stretch do not change them.
          </p>
        )}
        <button
          type="button"
          className="btn btn-small"
          title="Return to an axis-aligned lattice with cubic cells."
          disabled={orientationIsDefault}
          onClick={() => store.updateParams({
            latticeRotationDeg: [...DEFAULT_PARAMS.latticeRotationDeg],
            cellScale: [...DEFAULT_PARAMS.cellScale],
          })}
        >
          Reset orientation
        </button>
      </Collapsible>

      <PanelSection title="Density">
        <label className="check-label">
          <input
            id="gradient-enabled"
            type="checkbox"
            aria-describedby={perforatedBand ? 'gradient-hint gradient-perforated-hint' : 'gradient-hint'}
            checked={store.params.gradientEnabled}
            onChange={(e) => store.updateParams({ gradientEnabled: e.target.checked })}
          />
          Graded density
        </label>
        <p className="field-hint" id="gradient-hint">
          Thicker walls near the outer skin, fading toward the core over ~3 cells.
        </p>
        {store.params.gradientEnabled && (
          <>
            <div className="row">
              <label htmlFor="gradient-strength">Strength (%)</label>
              <NumericInput
                captureUndoCheckpoint={store.captureUndoCheckpoint}
                id="gradient-strength"
                title="How much thicker the lattice gets at the skin. 100% doubles it."
                describedBy="gradient-strength-hint"
                value={gradientPercent}
                min={0} max={100} step={5}
                onCommit={(percent) => store.updateParams({ gradientStrength: percent / 100 })}
              />
            </div>
            <p className="field-hint" id="gradient-strength-hint">
              {`${gradientSkinThickness} mm ${sheet ? 'walls' : 'struts'} at the skin, fading toward ${nominalThickness} mm with depth. 100% doubles the thickness.`}
            </p>
          </>
        )}
        {perforatedBand && (
          <p className="field-hint" id="gradient-perforated-hint">
            Perforated skins are a single surface band, so grading does not change them.
          </p>
        )}
      </PanelSection>
    </StepPanel>
  );
}
