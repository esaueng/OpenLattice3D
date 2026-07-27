// Left Panel: Import, Constraints, Lattice Type, Parameters
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { parseSTL } from '../geometry/stl-parser';
import {
  analyzeMesh,
  repairMesh,
  computeSignedVolume,
  flipMeshOrientation,
  countNormalWindingAgreement,
  alignNormalsToWinding,
} from '../geometry/mesh-analysis';
import type { LatticeType, SampleShape, LatticeParams, SelectionMode } from '../types/project';
import { DEFAULT_PARAMS } from '../types/project';
import { isSheetType } from '../geometry/lattice';
import { SAMPLE_SHAPE_INFO } from '../store/useStore';
import type { LatticeGenerationControls } from '../hooks/useLatticeGeneration';
import { RightPanel } from './RightPanel';

type LeftPanelProps = {
  generationControls: LatticeGenerationControls;
};

const SELECTION_MODES: Array<{ mode: SelectionMode; label: string; title: string }> = [
  { mode: 'none', label: 'Off', title: 'Disable painting and return to normal camera control.' },
  { mode: 'keep_out', label: 'Keep-Out', title: 'Paint faces where the original surface is preserved and the lattice cannot break through.' },
  { mode: 'keep_in', label: 'Keep-In', title: 'Paint faces that stay solid, with no lattice under them.' },
];

export function LeftPanel({ generationControls }: LeftPanelProps) {
  const { startGeneration, cancelGeneration } = generationControls;
  const store = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  const [clearAllArmed, setClearAllArmed] = useState(false);

  useEffect(() => {
    if (!clearAllArmed) return;
    const timeout = window.setTimeout(() => setClearAllArmed(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [clearAllArmed]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    store.addLog(`Importing ${file.name}...`);
    try {
      const buffer = await file.arrayBuffer();
      let mesh = parseSTL(buffer);
      const info = analyzeMesh(mesh);
      store.addLog(`Loaded: ${info.triangleCount} triangles, ${info.vertexCount} vertices`);
      store.addLog(`Bounding box: [${info.boundingBox.min.map(v => v.toFixed(1))}] to [${info.boundingBox.max.map(v => v.toFixed(1))}]`);

      // Orientation guard. An inside-out closed mesh yields a sign-inverted SDF,
      // which silently lattices the exterior instead of the interior — the result
      // looks plausible and nothing downstream flags it. Signed volume is only
      // meaningful on a closed mesh, so this is gated on watertightness.
      if (info.isWatertight) {
        const volume = computeSignedVolume(mesh);
        if (volume < 0) {
          mesh = flipMeshOrientation(mesh);
          store.addLog(
            `Inverted winding detected (signed volume ${volume.toFixed(1)}mm3). Flipped mesh orientation.`,
            'warn'
          );
        }
        store.addLog(`Volume: ${Math.abs(volume).toFixed(1)}mm3`);

        // Winding direction is trustworthy at this point, so it wins any
        // disagreement with the stored normals. Catches STLs that ship zero or
        // inverted facet normals alongside correct winding — the SDF reads the
        // stored normals, so those would otherwise invert the whole solve.
        const agreement = countNormalWindingAgreement(mesh);
        const compared = agreement.agree + agreement.disagree;
        if (compared > 0 && agreement.disagree > agreement.agree) {
          mesh = alignNormalsToWinding(mesh);
          store.addLog(
            `Stored normals disagree with winding on ${agreement.disagree}/${compared} faces. Recomputed normals from winding.`,
            'warn'
          );
        }
      } else {
        store.addLog('Mesh is not closed - skipped orientation check', 'warn');
      }

      if (!info.isManifold || !info.isWatertight) {
        store.addLog('Mesh is not watertight/manifold. Attempting repair...', 'warn');
        const { mesh: repairedMesh, repaired } = repairMesh(mesh);
        store.setOriginalMesh(repairedMesh, { ...info, repaired }, file.name);
        store.setMeshRepaired(repaired);
        store.addLog('Basic repair applied (normals recalculated)', 'warn');
      } else {
        store.addLog('Mesh is watertight and manifold', 'info');
        store.setOriginalMesh(mesh, info, file.name);
      }
    } catch (err) {
      store.addLog(`Import failed: ${err}`, 'error');
    }
  }, [store]);

  const handleSampleShape = useCallback((shape: SampleShape) => {
    store.setSampleShape(shape);
    store.addLog(`Sample loaded: ${SAMPLE_SHAPE_INFO[shape].fileName}`);
    store.addLog('Pre-configured: tolerance 0.2mm, shell 1.5mm, cell 8mm, SLS/MJF');
  }, [store]);

  const handleJsonImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      // Support both { parameters: {...} } (project JSON) and plain { latticeType: ... } formats
      const params: Partial<LatticeParams> = data.parameters || data;
      // Validate: only apply known keys from LatticeParams
      const validKeys = Object.keys(DEFAULT_PARAMS) as (keyof LatticeParams)[];
      const filtered: Partial<LatticeParams> = {};
      let count = 0;
      for (const key of validKeys) {
        if (key in params) {
          (filtered as Record<string, unknown>)[key] = params[key];
          count++;
        }
      }
      if (count === 0) {
        store.addLog('JSON import: no valid parameters found', 'error');
        return;
      }
      store.importParams(filtered);
      store.addLog(`Imported ${count} parameter(s) from ${file.name}`);
    } catch (err) {
      store.addLog(`JSON import failed: ${err}`, 'error');
    }
    // Reset the input so the same file can be re-imported
    e.target.value = '';
  }, [store]);

  const handleReset = useCallback(() => {
    if (!clearAllArmed) {
      setClearAllArmed(true);
      store.addLog('Click Confirm to reset.', 'warn');
      return;
    }
    setClearAllArmed(false);
    store.resetProject();
    store.addLog('Project reset to defaults');
  }, [clearAllArmed, store]);

  const handleSelectAllKeepOut = useCallback(() => {
    store.selectAllKeepOut();
    store.addLog(`Marked all ${store.originalMesh?.triCount.toLocaleString() ?? 0} faces as keep-out`);
  }, [store]);

  const handleClearSelection = useCallback(() => {
    store.clearSelection();
    store.addLog('Cleared painted constraints');
  }, [store]);

  const toggleDemoGrid = useCallback((enabled: boolean) => {
    if (store.generating) return;
    if (enabled) {
      store.startDemoRun();
      store.addLog('Started multiview: 12 separate lattice viewers');
    } else {
      store.setDemoModeActive(false);
      store.addLog('Multiview hidden');
    }
  }, [store]);

  const hasModel = store.originalMesh || store.sphereMode;
  const hasModelOrDemo = hasModel || store.demoModeActive;
  const generateDisabledByMultiview = store.demoModeActive;

  return (
    <div className="panel-content">
      <div className="panel-intro">
        <span className="panel-eyebrow">setup</span>
        <h2>Model and lattice</h2>
        <p>Import a mesh, select a sample part, tune parameters, and generate.</p>
      </div>

      {/* Import Section */}
      <section className="panel-section">
        <h3>Model</h3>
        <input
          ref={fileRef}
          type="file"
          accept=".stl"
          onChange={handleFileUpload}
          style={{ display: 'none' }}
        />
        <input
          ref={jsonRef}
          type="file"
          accept=".json"
          onChange={handleJsonImport}
          style={{ display: 'none' }}
        />
        <div className="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" title="Upload an STL mesh to generate a lattice from." onClick={() => fileRef.current?.click()}>
            Import STL
          </button>
          <button className="btn btn-small" title="Import saved lattice parameters from a JSON file." onClick={() => jsonRef.current?.click()}>
            Import JSON
          </button>
          <button
            className={`btn btn-small btn-danger ${clearAllArmed ? 'btn-danger-confirm' : ''}`}
            title={clearAllArmed
              ? 'Confirm reset of the project, parameters, and generated results.'
              : 'Reset the project, parameters, and generated results.'}
            onClick={handleReset}
            aria-live="polite"
          >
            {clearAllArmed ? 'Confirm' : 'Clear All'}
          </button>
        </div>
        <div className="row" style={{ marginTop: '8px' }}>
          <label>Sample Part:</label>
          <select
            title="Load a built-in sample shape for quick testing."
            value={store.sampleShape || ''}
            onChange={(e) => { if (e.target.value) handleSampleShape(e.target.value as SampleShape); }}
          >
            <option value="">-- Choose --</option>
            {(Object.keys(SAMPLE_SHAPE_INFO) as SampleShape[]).map((k) => (
              <option key={k} value={k}>{SAMPLE_SHAPE_INFO[k].label}</option>
            ))}
          </select>
        </div>


        {store.meshInfo && (
          <div className="info-block">
            <div><strong>File:</strong> {store.meshFileName}</div>
            <div><strong>Triangles:</strong> {store.meshInfo.triangleCount.toLocaleString()}</div>
            <div><strong>Vertices:</strong> {store.meshInfo.vertexCount.toLocaleString()}</div>
            <div><strong>Watertight:</strong> {store.meshInfo.isWatertight ? 'Yes' : 'No'}</div>
            <div><strong>Manifold:</strong> {store.meshInfo.isManifold ? 'Yes' : 'No'}</div>
            {store.meshInfo.repaired && (
              <div className="warning">Mesh was auto-repaired</div>
            )}
          </div>
        )}
        {store.sphereMode && store.sampleShape && (
          <div className="info-block">
            <div><strong>Model:</strong> {store.meshFileName}</div>
            <div><strong>Mode:</strong> Procedural (analytic SDF)</div>
          </div>
        )}
      </section>

      {/* Constraints */}
      {hasModel && (
        <section className="panel-section">
          <h3>Constraints</h3>
          {!store.originalMesh ? (
            <div className="constraint-hint">
              Painting needs an imported STL. Sample parts are generated from an analytic
              formula, so their display triangles do not map onto the solver geometry.
            </div>
          ) : (
            <>
              <div className="row">
                <label>Paint Mode:</label>
                <div className="constraint-mode-buttons">
                  {SELECTION_MODES.map(({ mode, label, title }) => (
                    <button
                      key={mode}
                      type="button"
                      className={`btn btn-small ${store.selectionMode === mode ? 'btn-active' : ''}`}
                      title={title}
                      aria-pressed={store.selectionMode === mode}
                      onClick={() => store.setSelectionMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {store.selectionMode !== 'none' && (
                <>
                  <div className="row">
                    <label>Brush Radius (mm):</label>
                    <input
                      type="number"
                      title="Radius of the paint brush. 0 paints one triangle per click. Hold Alt to erase."
                      value={store.brushRadius}
                      min={0} max={100} step={0.5}
                      onChange={(e) => store.setBrushRadius(parseFloat(e.target.value) || 0)}
                    />
                  </div>
                  <div className="constraint-hint">
                    Drag on the model in Original view to paint. Hold Alt to erase.
                  </div>
                </>
              )}

              {store.keepInTris.size > 0 && (
                <div className="row">
                  <label>Keep-In Depth (mm):</label>
                  <input
                    type="number"
                    title="How far solid material extends inward from painted keep-in faces."
                    value={store.params.keepInDepth}
                    min={0.1} max={50} step={0.1}
                    onChange={(e) => store.updateParams({ keepInDepth: parseFloat(e.target.value) || 3.0 })}
                  />
                </div>
              )}

              <div className="constraint-legend">
                <span className="constraint-swatch constraint-swatch-out" />
                Keep-Out
                <span className="count-pill">{store.keepOutTris.size.toLocaleString()}</span>
                <span className="constraint-swatch constraint-swatch-in" />
                Keep-In
                <span className="count-pill">{store.keepInTris.size.toLocaleString()}</span>
              </div>

              <div className="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
                <button
                  className="btn btn-small"
                  title="Mark every exterior face as keep-out, preserving the whole original surface."
                  onClick={handleSelectAllKeepOut}
                >
                  Select All Keep-Out
                </button>
                <button
                  className="btn btn-small"
                  title="Clear all painted keep-out and keep-in regions."
                  disabled={store.keepOutTris.size === 0 && store.keepInTris.size === 0}
                  onClick={handleClearSelection}
                >
                  Clear
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="panel-section">
        <h3>Multiview</h3>
        <div className="row checkbox-row multiview-toggle-row">
          <label className="multiview-toggle-label">
            <input
              type="checkbox"
              title="Show all 12 lattice viewers in a tiled multiview layout for the current model."
              checked={store.demoModeActive}
              onChange={(e) => toggleDemoGrid(e.target.checked)}
              disabled={store.generating}
            />
            Show all 12 windows
          </label>
        </div>
      </section>

      {/* Lattice Parameters */}
      {hasModelOrDemo && (
        <section className="panel-section">
          <h3>Lattice</h3>

          <div className="row">
            <label>Lattice Type:</label>
            <select
              title="Choose the lattice algorithm used to generate internal geometry."
              value={store.params.latticeType}
              onChange={(e) => store.setLatticeType(e.target.value as LatticeType)}
            >
              <optgroup label="TPMS (sheet)">
                <option value="gyroid">Gyroid</option>
                <option value="schwarzP">Schwarz P (Primitive)</option>
                <option value="schwarzD">Schwarz D (Diamond)</option>
                <option value="neovius">Neovius</option>
                <option value="iwp">IWP (Schoen)</option>
              </optgroup>
              <optgroup label="Strut">
                <option value="bcc">BCC</option>
                <option value="octet">Octet Truss (FCC)</option>
                <option value="diamond">Diamond</option>
                <option value="hexagon">Hexagon</option>
                <option value="triangle">Triangle</option>
              </optgroup>
              <optgroup label="Stochastic">
                <option value="voronoi">Voronoi Foam</option>
                <option value="spinodal">Spinodal</option>
              </optgroup>
            </select>
          </div>

          <div className="row">
            <label>Cell Size (mm):</label>
            <input
              type="number"
              title="Controls overall lattice spacing. Larger values create bigger cells."
              value={store.params.cellSize}
              min={2} max={50} step={0.5}
              onChange={(e) => store.updateParams({ cellSize: parseFloat(e.target.value) || 8 })}
            />
          </div>

          <div className="row checkbox-row param-toggle-row">
            <label className="param-toggle-label">
              <input
                type="checkbox"
                title="Removes the outer shell so only lattice remains."
                checked={store.params.noShell}
                onChange={(e) => store.updateParams({ noShell: e.target.checked, surfaceOnly: false })}
              />
              No outer shell (pure lattice)
            </label>
          </div>

          <div className="row checkbox-row param-toggle-row">
            <label className="param-toggle-label">
              <input
                type="checkbox"
                title="Constrain lattice generation to a surface band, leaving inside hollow."
                checked={store.params.surfaceOnly}
                onChange={(e) => store.updateParams({ surfaceOnly: e.target.checked, noShell: false })}
              />
              Surface lattice only (hollow inside)
            </label>
          </div>

          {store.params.surfaceOnly && (
            <div className="row">
              <label>Lattice Depth (mm):</label>
              <input
                type="number"
                title="Depth of the generated lattice band from the outer surface."
                value={store.params.surfaceDepth}
                min={1} max={50} step={0.5}
                onChange={(e) => store.updateParams({ surfaceDepth: parseFloat(e.target.value) || 8 })}
              />
            </div>
          )}

          {!store.params.noShell && !store.params.surfaceOnly && (
            <div className="row">
              <label>Shell Thickness (mm):</label>
              <input
                type="number"
                title="Thickness of the outer shell retained around the lattice."
                value={store.params.shellThickness}
                min={0.3} max={10} step={0.1}
                onChange={(e) => store.updateParams({ shellThickness: parseFloat(e.target.value) || 1.5 })}
              />
            </div>
          )}

          {isSheetType(store.params.latticeType) ? (
            <div className="row">
              <label>Wall Thickness (mm):</label>
              <input
                type="number"
                title="Thickness of sheet-style TPMS surfaces."
                value={store.params.wallThickness}
                min={0.3} max={5} step={0.1}
                onChange={(e) => store.updateParams({ wallThickness: parseFloat(e.target.value) || 1.0 })}
              />
            </div>
          ) : (
            <div className="row">
              <label>Strut Diameter (mm):</label>
              <input
                type="number"
                title="Diameter of strut members for strut-based lattices."
                value={store.params.strutDiameter}
                min={0.3} max={5} step={0.1}
                onChange={(e) => store.updateParams({ strutDiameter: parseFloat(e.target.value) || 1.0 })}
              />
            </div>
          )}

          <div className="row">
            <label>Min Feature Size (mm):</label>
            <input
              type="number"
              title="Minimum manufacturable feature size target used in validation."
              value={store.params.minFeatureSize}
              min={0.3} max={5} step={0.1}
              onChange={(e) => store.updateParams({ minFeatureSize: parseFloat(e.target.value) || 0.8 })}
            />
          </div>

          <div className="row">
            <label>Tolerance (mm):</label>
            <input
              type="number"
              title="Maximum allowed outer-surface deviation versus the source mesh."
              value={store.params.toleranceMm}
              min={0.05} max={2} step={0.05}
              onChange={(e) => store.updateParams({ toleranceMm: parseFloat(e.target.value) || 0.2 })}
            />
          </div>

          <div className="row">
            <label>Export Resolution:</label>
            <select
              title="Sampling resolution for marching cubes. Higher values increase detail and compute time."
              value={store.params.exportResolution}
              onChange={(e) => store.updateParams({ exportResolution: parseInt(e.target.value) || 3 })}
            >
              {['Min', 'Low', 'Med', 'Good', 'High', 'Fine', 'Ultra', 'Extreme', 'Hyper', 'Max'].map(
                (label, index) => {
                  const value = index + 1;
                  return (
                    <option key={label} value={value}>
                      {value} - {label}
                    </option>
                  );
                }
              )}
            </select>
          </div>


          <div className="row">
            <label>Thin Artifact Filter:</label>
            <select
              title="Removes very thin/jagged sections. Higher levels remove more material."
              value={store.params.thinSectionFilter}
              onChange={(e) => store.updateParams({ thinSectionFilter: parseFloat(e.target.value) || 0 })}
            >
              <option value={0}>Off</option>
              <option value={0.05}>Low</option>
              <option value={0.1}>Medium</option>
              <option value={0.2}>High</option>
              <option value={0.35}>Very High</option>
            </select>
          </div>


        </section>
      )}

      {/* Escape holes */}
      {hasModelOrDemo && (
        <section className="panel-section">
          <h3>Escape Holes</h3>
          {store.params.noShell || store.params.surfaceOnly ? (
            <div className="constraint-hint">
              Not needed here — {store.params.noShell ? 'a pure lattice has' : 'a hollow surface lattice has'} no
              enclosed cavity to drain.
            </div>
          ) : (
            <>
              <div className="row checkbox-row param-toggle-row">
                <label className="param-toggle-label">
                  <input
                    type="checkbox"
                    title="Cut drainage channels through the shell so trapped powder or resin can escape."
                    checked={store.params.escapeHoles}
                    onChange={(e) => store.updateParams({ escapeHoles: e.target.checked })}
                  />
                  Cut escape holes
                </label>
              </div>

              {store.params.escapeHoles ? (
                <>
                  <div className="row">
                    <label>Hole Count:</label>
                    <input
                      type="number"
                      title="Number of drainage channels, spread evenly over the surface."
                      value={store.params.escapeHoleCount}
                      min={1} max={12} step={1}
                      onChange={(e) => store.updateParams({ escapeHoleCount: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                  <div className="row">
                    <label>Hole Diameter (mm):</label>
                    <input
                      type="number"
                      title="Channel diameter. The process preset sets a sensible default."
                      value={store.params.escapeHoleDiameter}
                      min={0.5} max={30} step={0.5}
                      onChange={(e) => store.updateParams({ escapeHoleDiameter: parseFloat(e.target.value) || 5.0 })}
                    />
                  </div>
                </>
              ) : (
                <div className="warning">
                  A sealed shell traps powder or resin in the lattice core.
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* Generate */}
      {hasModel && (
        <section className="panel-section">
          <h3>Generate</h3>
          {!store.generating ? (
            <button
              className={`btn btn-primary btn-large ${generateDisabledByMultiview ? 'btn-generate-muted' : ''}`}
              title={generateDisabledByMultiview
                ? 'Disabled while 12-window multiview is enabled.'
                : 'Start generating the lattice with the current settings (G).'}
              onClick={startGeneration}
              disabled={generateDisabledByMultiview}
              aria-disabled={generateDisabledByMultiview}
            >
              Generate Lattice
            </button>
          ) : (
            <div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${store.progress * 100}%` }} />
              </div>
              <div className="progress-text">{store.progressMessage}</div>
              <button className="btn btn-small" title="Stop the current generation job." onClick={cancelGeneration}>Cancel</button>
            </div>
          )}
        </section>
      )}

      <div className="left-inspection-panel">
        <RightPanel />
      </div>

    </div>
  );
}
