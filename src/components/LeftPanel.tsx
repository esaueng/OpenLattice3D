// Left Panel: Import, Constraints, Lattice Type, Parameters
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { parseSTL } from '../geometry/stl-parser';
import { assertFileSizeWithinBudget, DEFAULT_IMPORT_LIMITS } from '../geometry/mesh-limits';
import {
  alignNormalsToWinding,
  analyzeMesh,
  computeSignedVolume,
  countNormalWindingAgreement,
  flipMeshOrientation,
  repairMesh,
} from '../geometry/mesh-analysis';
import type { LatticeType, SampleShape } from '../types/project';
import { parseProjectFile } from '../utils/project-file';
import { isSheetType } from '../geometry/lattice';
import { SAMPLE_SHAPE_INFO } from '../store/useStore';
import type { LatticeGenerationControls } from '../hooks/useLatticeGeneration';
import { NumericInput } from './NumericInput';
import { RightPanel } from './RightPanel';
import { formatGenerationSeed } from '../geometry/deterministic-random';

type LeftPanelProps = {
  generationControls: LatticeGenerationControls;
};

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
      // Check the declared size before reading: arrayBuffer() would otherwise
      // pull the whole file into tab memory before any limit could apply.
      assertFileSizeWithinBudget(file.size, DEFAULT_IMPORT_LIMITS.maxStlBytes, `STL file ${file.name}`);
      const buffer = await file.arrayBuffer();
      let mesh = parseSTL(buffer);
      const info = analyzeMesh(mesh);
      store.addLog(`Loaded: ${info.triangleCount} triangles, ${info.vertexCount} vertices`);
      store.addLog(`Bounding box: [${info.boundingBox.min.map(v => v.toFixed(1))}] to [${info.boundingBox.max.map(v => v.toFixed(1))}]`);

      if (info.isWatertight) {
        const signedVolume = computeSignedVolume(mesh);
        if (signedVolume < 0) {
          mesh = flipMeshOrientation(mesh);
          store.addLog(
            `Inverted winding detected (signed volume ${signedVolume.toFixed(1)}mm3). Flipped mesh orientation.`,
            'warn',
          );
        }
        const agreement = countNormalWindingAgreement(mesh);
        const compared = agreement.agree + agreement.disagree;
        if (compared > 0 && agreement.disagree > agreement.agree) {
          mesh = alignNormalsToWinding(mesh);
          store.addLog(
            `Stored normals disagreed with winding on ${agreement.disagree}/${compared} faces. Recomputed normals.`,
            'warn',
          );
        }
        store.addLog(`Volume: ${Math.abs(signedVolume).toFixed(1)}mm3`);
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
      assertFileSizeWithinBudget(file.size, DEFAULT_IMPORT_LIMITS.maxProjectBytes, `Project file ${file.name}`);
      const text = await file.text();
      const data: unknown = JSON.parse(text);
      const parsed = parseProjectFile(data);
      for (const warning of parsed.warnings) store.addLog(`JSON import: ${warning}`, 'warn');
      if (parsed.kind === 'project') {
        store.restoreProject(parsed);
        store.addLog(`Restored project from ${file.name}; regenerate to refresh geometry and validation`);
      } else {
        if (parsed.accepted.length === 0) {
          store.addLog('JSON import: no valid parameters found', 'error');
          return;
        }
        store.importParams(parsed.params);
        store.addLog(`Imported ${parsed.accepted.length} parameter(s) from ${file.name}`);
      }
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

  const handleReseed = useCallback(() => {
    store.reseedGeneration();
    store.addLog(`Generation reseeded to ${formatGenerationSeed(useStore.getState().generationSeed)}`);
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
          <label htmlFor="sample-part">Sample Part:</label>
          <select
            id="sample-part"
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

      {store.originalMesh && (
        <section className="panel-section">
          <h3>Constraint Painting</h3>
          <div className="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
            <button
              className={`btn btn-small ${store.selectionMode === 'keep_out' ? 'btn-primary' : ''}`}
              onClick={() => store.setSelectionMode('keep_out')}
              title="Mark source faces that must remain outside the generated lattice."
            >
              Keep-out
            </button>
            <button
              className={`btn btn-small ${store.selectionMode === 'keep_in' ? 'btn-primary' : ''}`}
              onClick={() => store.setSelectionMode('keep_in')}
              title="Mark source faces that should stay solid."
            >
              Keep-in
            </button>
            <button className="btn btn-small" onClick={() => store.setSelectionMode('none')}>Stop</button>
          </div>
          <div className="row" style={{ gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
            <button className="btn btn-small" onClick={store.selectAllKeepOut}>Select all keep-out</button>
            <button className="btn btn-small" onClick={store.undoSelection} disabled={store.selectionUndo.length === 0}>Undo</button>
            <button className="btn btn-small" onClick={store.redoSelection} disabled={store.selectionRedo.length === 0}>Redo</button>
            <button className="btn btn-small" onClick={store.clearSelection}>Clear</button>
          </div>
          {store.selectionMode !== 'none' && (
            <>
              <div className="row" style={{ marginTop: '6px' }}>
                <label htmlFor="constraint-brush-radius">Brush Radius (mm):</label>
                <NumericInput
                  id="constraint-brush-radius"
                  title="Radius around the pointer hit. Zero paints one triangle. Hold Alt while dragging to erase."
                  min={0} max={100} step={0.5}
                  value={store.brushRadius}
                  onCommit={(next) => store.setBrushRadius(next)}
                />
              </div>
              <div className="info-block">Drag on the imported model to paint. Hold Alt to erase.</div>
            </>
          )}
          {store.keepInTris.size > 0 && (
            <div className="row" style={{ marginTop: '6px' }}>
              <label htmlFor="keep-in-depth">Keep-in Depth (mm):</label>
              <NumericInput
                id="keep-in-depth"
                title="Depth of solid material preserved below painted keep-in faces."
                min={0.1} max={100} step={0.5}
                value={store.params.keepInDepth}
                onCommit={(keepInDepth) => store.updateParams({ keepInDepth })}
              />
            </div>
          )}
          <div className="info-block">
            Keep-out: {store.keepOutTris.size.toLocaleString()} faces · Keep-in: {store.keepInTris.size.toLocaleString()} faces
          </div>
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
            <label htmlFor="lattice-type">Lattice Type:</label>
            <select
              id="lattice-type"
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
            <label htmlFor="cell-size">Cell Size (mm):</label>
            <NumericInput
              id="cell-size"
              title="Controls overall lattice spacing. Larger values create bigger cells."
              value={store.params.cellSize}
              min={2} max={50} step={0.5}
              onCommit={(next) => store.updateParams({
                cellSize: next,
              })}
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
              <label htmlFor="lattice-depth">Lattice Depth (mm):</label>
              <NumericInput
                id="lattice-depth"
                title="Depth of the generated lattice band from the outer surface."
                value={store.params.surfaceDepth}
                min={1} max={50} step={0.5}
                onCommit={(next) => store.updateParams({
                  surfaceDepth: next,
                })}
              />
            </div>
          )}

          {!store.params.noShell && !store.params.surfaceOnly && (
            <div className="row">
              <label htmlFor="shell-thickness">Shell Thickness (mm):</label>
              <NumericInput
                id="shell-thickness"
                title="Thickness of the outer shell retained around the lattice."
                value={store.params.shellThickness}
                min={0.3} max={10} step={0.1}
                onCommit={(next) => store.updateParams({
                  shellThickness: next,
                })}
              />
            </div>
          )}

          {!store.params.noShell && !store.params.surfaceOnly && store.params.variant === 'shell_core' && (
            <>
              <div className="row">
                <label htmlFor="escape-holes">Escape Holes:</label>
                <input
                  id="escape-holes"
                  type="checkbox"
                  title="Subtract through-holes along the selected build axis to release trapped powder or resin."
                  checked={store.params.escapeHoles}
                  onChange={(e) => store.updateParams({ escapeHoles: e.target.checked })}
                />
              </div>
              {store.params.escapeHoles && (
                <>
                  <div className="row">
                    <label htmlFor="escape-hole-axis">Build Axis:</label>
                    <select
                      id="escape-hole-axis"
                      title="Axis followed by the escape-hole cylinders."
                      value={store.params.escapeHoleAxis}
                      onChange={(e) => store.updateParams({ escapeHoleAxis: e.target.value as 'x' | 'y' | 'z' })}
                    >
                      <option value="x">X</option>
                      <option value="y">Y</option>
                      <option value="z">Z</option>
                    </select>
                  </div>
                  <div className="row">
                    <label htmlFor="escape-hole-diameter">Hole Diameter (mm):</label>
                    <NumericInput
                      id="escape-hole-diameter"
                      title="Diameter of the powder-escape holes."
                      value={store.params.escapeHoleDiameter}
                      min={0.5} max={50} step={0.5}
                      onCommit={(escapeHoleDiameter) => store.updateParams({ escapeHoleDiameter })}
                    />
                  </div>
                  <div className="row">
                    <label htmlFor="escape-hole-count">Hole Count:</label>
                    <NumericInput
                      id="escape-hole-count"
                      title="Number of powder-escape holes."
                      value={store.params.escapeHoleCount}
                      min={1} max={100} step={1}
                      onCommit={(next) => store.updateParams({ escapeHoleCount: Math.trunc(next) })}
                    />
                  </div>
                </>
              )}
            </>
          )}

          {/* Keyed: both branches render a .row at the same child slot, so without a
              key React reuses the instance and carries an in-progress edit from one
              parameter to the other. */}
          {isSheetType(store.params.latticeType) ? (
            <div className="row" key="wall-thickness">
              <label htmlFor="wall-thickness">Wall Thickness (mm):</label>
              <NumericInput
                id="wall-thickness"
                title="Thickness of sheet-style TPMS surfaces."
                value={store.params.wallThickness}
                min={0.3} max={5} step={0.1}
                onCommit={(next) => store.updateParams({
                  wallThickness: next,
                })}
              />
            </div>
          ) : (
            <div className="row" key="strut-diameter">
              <label htmlFor="strut-diameter">Strut Diameter (mm):</label>
              <NumericInput
                id="strut-diameter"
                title="Diameter of strut members for strut-based lattices."
                value={store.params.strutDiameter}
                min={0.3} max={5} step={0.1}
                onCommit={(next) => store.updateParams({
                  strutDiameter: next,
                })}
              />
            </div>
          )}

          <div className="row">
            <label htmlFor="min-feature-size">Min Feature Size (mm):</label>
            <NumericInput
              id="min-feature-size"
              title="Minimum manufacturable feature size target used in validation."
              value={store.params.minFeatureSize}
              min={0.3} max={5} step={0.1}
              onCommit={(next) => store.updateParams({
                minFeatureSize: next,
              })}
            />
          </div>

          <div className="row">
            <label htmlFor="tolerance">Tolerance (mm):</label>
            <NumericInput
              id="tolerance"
              title="Maximum allowed outer-surface deviation versus the source mesh."
              value={store.params.toleranceMm}
              min={0.05} max={2} step={0.05}
              onCommit={(next) => store.updateParams({
                toleranceMm: next,
              })}
            />
          </div>

          <div className="row">
            <label htmlFor="export-resolution">Export Resolution:</label>
            <select
              id="export-resolution"
              title="Sampling resolution for marching cubes. Higher values increase detail and compute time."
              value={store.params.exportResolution}
              onChange={(e) => store.updateParams({ exportResolution: Number(e.target.value) })}
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
            <label htmlFor="thin-filter">Remove Features:</label>
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


        </section>
      )}

      <div className="left-inspection-panel">
        <RightPanel />
      </div>

      {/* Generate: last child so the pinned bar un-sticks at max scroll instead
          of permanently covering the validation panel above it. */}
      {hasModel && (
        <section
          className="panel-section panel-section-sticky"
          id="generate-action"
          aria-label="Generate lattice"
          tabIndex={-1}
        >
          <div className="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
            <span title="Persisted deterministic generation seed">
              Seed {formatGenerationSeed(store.generationSeed)}
            </span>
            <button
              className="btn btn-small"
              title="Choose a new explicit seed and invalidate the current generated result."
              onClick={handleReseed}
              disabled={store.generating}
            >
              Reseed
            </button>
          </div>
          {store.generationError && (
            <div className="warning" role="alert">{store.generationError}</div>
          )}
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
            <div className="generate-progress-track">
              <div className="progress-text">{store.progressMessage}</div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${store.progress * 100}%` }} />
              </div>
              <button className="btn btn-small" title="Stop the current generation job." onClick={cancelGeneration}>Cancel</button>
            </div>
          )}
        </section>
      )}

    </div>
  );
}
