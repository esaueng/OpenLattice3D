// Left Panel: Import, Constraints, Lattice Type, Parameters
import { useCallback, useRef } from 'react';
import { useStore } from '../store/useStore';
import { parseSTL } from '../geometry/stl-parser';
import { analyzeMesh, repairMesh } from '../geometry/mesh-analysis';
import type { LatticeType, SampleShape, LatticeParams } from '../types/project';
import { DEFAULT_PARAMS } from '../types/project';
import { isSheetType } from '../geometry/lattice';
import { SAMPLE_SHAPE_INFO } from '../store/useStore';
import type { WorkerMessage, WorkerResponse } from '../workers/lattice-worker';

export function LeftPanel() {
  const store = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);

  const requestNotificationPermission = useCallback(async (): Promise<NotificationPermission | null> => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      return Notification.requestPermission();
    }
    return Notification.permission;
  }, []);

  const notifyGenerationComplete = useCallback(async (triCount: number) => {
    if (!('Notification' in window)) return;
    const permission = await requestNotificationPermission();
    if (permission === 'granted') {
      new Notification('Lattice generation complete', {
        body: `${triCount.toLocaleString()} triangles generated.`,
      });
    }
  }, [requestNotificationPermission]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    store.addLog(`Importing ${file.name}...`);
    try {
      const buffer = await file.arrayBuffer();
      const mesh = parseSTL(buffer);
      const info = analyzeMesh(mesh);
      store.addLog(`Loaded: ${info.triangleCount} triangles, ${info.vertexCount} vertices`);
      store.addLog(`Bounding box: [${info.boundingBox.min.map(v => v.toFixed(1))}] to [${info.boundingBox.max.map(v => v.toFixed(1))}]`);

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
    store.resetProject();
    store.addLog('Project reset to defaults');
  }, [store]);

  const startGeneration = useCallback(() => {
    if (store.generating) return;
    void requestNotificationPermission();
    store.setGenerating(true);
    store.setProgress(0, 'Starting...');
    store.addLog('Starting lattice generation...');
    // Clear previous result without changing viewMode — view is preserved for regeneration
    store.setValidation(null);

    // Create worker
    if (workerRef.current) {
      workerRef.current.terminate();
    }
    const worker = new Worker(
      new URL('../workers/lattice-worker.ts', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;

    const resolution = Math.round(24 + store.params.exportResolution * 24); // 48..264

    const msg: WorkerMessage = {
      type: 'generate',
      params: store.params,
      sphereMode: store.sphereMode,
      sphereRadius: store.sphereRadius,
      sampleShape: store.sampleShape,
      resolution,
      keepOutTris: Array.from(store.keepOutTris),
    };

    if (store.originalMesh) {
      msg.meshPositions = store.originalMesh.positions;
      msg.meshNormals = store.originalMesh.normals;
      msg.meshTriCount = store.originalMesh.triCount;
    }

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const resp = e.data;
      if (resp.type === 'progress') {
        store.setProgress(resp.progress || 0, resp.message || '');
        if (resp.message) store.addLog(resp.message);
      } else if (resp.type === 'result') {
        store.setResultMesh({
          positions: resp.positions!,
          normals: resp.normals!,
          triCount: resp.triCount!,
        });
        store.setValidation(resp.validation || null);
        store.setGenerating(false);
        store.setProgress(1, 'Complete');
        store.addLog(`Generation complete: ${resp.triCount} triangles`);
        void notifyGenerationComplete(resp.triCount || 0);
        worker.terminate();
      } else if (resp.type === 'error') {
        store.addLog(`Error: ${resp.message}`, 'error');
        store.setGenerating(false);
        worker.terminate();
      }
    };

    worker.postMessage(msg);
  }, [notifyGenerationComplete, requestNotificationPermission, store]);

  const cancelGeneration = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    store.setGenerating(false);
    store.setProgress(0, 'Cancelled');
    store.addLog('Generation cancelled', 'warn');
  }, [store]);

  const hasModel = store.originalMesh || store.sphereMode;

  return (
    <div className="panel left-panel">
      <h2 className="app-title">Open Lattice 3D</h2>

      {/* Import Section */}
      <section>
        <h3>Import</h3>
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
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
            Upload STL
          </button>
          <button className="btn btn-small" onClick={() => jsonRef.current?.click()}>
            Import JSON
          </button>
          <button className="btn btn-small btn-danger" onClick={handleReset}>
            Clear All
          </button>
        </div>
        <div className="row" style={{ marginTop: '8px' }}>
          <label>Sample Part:</label>
          <select
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

      {/* Lattice Parameters */}
      {hasModel && (
        <section>
          <h3>Lattice Parameters</h3>

          <div className="row">
            <label>Lattice Type:</label>
            <select
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
              value={store.params.cellSize}
              min={2} max={50} step={0.5}
              onChange={(e) => store.updateParams({ cellSize: parseFloat(e.target.value) || 8 })}
            />
          </div>

          <div className="row checkbox-row">
            <label>
              <input
                type="checkbox"
                checked={store.params.noShell}
                onChange={(e) => store.updateParams({ noShell: e.target.checked, surfaceOnly: false })}
              />
              No outer shell (pure lattice)
            </label>
          </div>

          <div className="row checkbox-row">
            <label>
              <input
                type="checkbox"
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
              value={store.params.minFeatureSize}
              min={0.3} max={5} step={0.1}
              onChange={(e) => store.updateParams({ minFeatureSize: parseFloat(e.target.value) || 0.8 })}
            />
          </div>

          <div className="row">
            <label>Tolerance (mm):</label>
            <input
              type="number"
              value={store.params.toleranceMm}
              min={0.05} max={2} step={0.05}
              onChange={(e) => store.updateParams({ toleranceMm: parseFloat(e.target.value) || 0.2 })}
            />
          </div>

          <div className="row">
            <label>Export Resolution:</label>
            <select
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

          <div className="row checkbox-row">
            <label>
              <input
                type="checkbox"
                checked={store.params.gradientEnabled}
                onChange={(e) => store.updateParams({ gradientEnabled: e.target.checked })}
              />
              Near-surface densification
            </label>
          </div>

          {store.params.gradientEnabled && (
            <div className="row">
              <label>Gradient Strength:</label>
              <input
                type="range"
                value={store.params.gradientStrength}
                min={0} max={1} step={0.1}
                onChange={(e) => store.updateParams({ gradientStrength: parseFloat(e.target.value) })}
              />
              <span>{store.params.gradientStrength.toFixed(1)}</span>
            </div>
          )}

        </section>
      )}

      {/* Generate */}
      {hasModel && (
        <section>
          <h3>Generate</h3>
          {!store.generating ? (
            <button className="btn btn-primary btn-large" onClick={startGeneration}>
              Generate Lattice
            </button>
          ) : (
            <div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${store.progress * 100}%` }} />
              </div>
              <div className="progress-text">{store.progressMessage}</div>
              <button className="btn btn-small" onClick={cancelGeneration}>Cancel</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
