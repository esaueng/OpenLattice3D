import { useStore, SAMPLE_SHAPE_INFO } from '../../store/useStore';
import type { SampleShape } from '../../types/project';
import { useModelImport } from '../../hooks/useModelImport';
import { describeMeshCondition, formatDimensions, formatVolume, modelExtents } from '../../utils/model-summary';
import { PanelSection, StepPanel } from '../PanelChrome';
import { FolderOpenIcon, UploadIcon } from '../icons';
import type { WorkflowInputs } from '../workflow';

export function ModelStep({ inputs }: { inputs: WorkflowInputs }) {
  const store = useStore();
  const intake = useModelImport();
  const hasModel = Boolean(store.originalMesh || store.sphereMode);
  const extents = modelExtents(store.meshInfo, store.sampleShape, store.sphereRadius);
  const meshCondition = store.meshInfo ? describeMeshCondition(store.meshInfo) : null;
  const notice = store.importNotice;

  return (
    <StepPanel step="model" inputs={inputs}>
      {intake.fileInputs}
      <PanelSection>
        <div className="action-pair">
          <button
            type="button"
            className={`btn ${hasModel ? '' : 'btn-primary'}`}
            title="Upload an STL mesh to generate a lattice from."
            onClick={intake.pickStl}
          >
            <UploadIcon size={15} />
            Import STL
          </button>
          <button
            type="button"
            className="btn"
            title="Open a saved project, or apply a parameter-only JSON file."
            onClick={intake.pickProject}
          >
            <FolderOpenIcon size={15} />
            Open project
          </button>
        </div>

        {notice && (
          <div className={`import-notice level-${notice.level}`} role={notice.level === 'error' ? 'alert' : 'status'}>
            <div className="import-notice-body">
              <div>{notice.message}</div>
              {notice.detail && <div className="import-notice-detail">{notice.detail}</div>}
              {notice.scalePrompt && store.originalMesh && (
                <div className="import-notice-actions">
                  <button type="button" className="btn btn-tiny" onClick={() => store.setImportNotice(null)}>It is millimetres</button>
                  <button type="button" className="btn btn-tiny" onClick={() => intake.applyScale(25.4, 'from inches (×25.4)')}>Convert from inches</button>
                  <button type="button" className="btn btn-tiny" onClick={() => intake.applyScale(10, '×10')}>×10</button>
                  <button type="button" className="btn btn-tiny" onClick={() => intake.applyScale(0.1, '×0.1')}>×0.1</button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="import-notice-dismiss"
              aria-label="Dismiss import message"
              title="Dismiss"
              onClick={() => store.setImportNotice(null)}
            >
              ×
            </button>
          </div>
        )}
      </PanelSection>

      <PanelSection title="Or start from a sample">
        <div className="sample-list" role="group" aria-label="Sample parts">
          {(Object.keys(SAMPLE_SHAPE_INFO) as SampleShape[]).map((shape) => (
            <button
              key={shape}
              type="button"
              className={`sample-chip${store.sampleShape === shape ? ' active' : ''}`}
              aria-pressed={store.sampleShape === shape}
              title={`Load the ${SAMPLE_SHAPE_INFO[shape].label} sample.`}
              onClick={() => intake.loadSample(shape)}
            >
              <SampleGlyph shape={shape} />
              <span>{SAMPLE_SHAPE_INFO[shape].label}</span>
            </button>
          ))}
        </div>
      </PanelSection>

      {hasModel && extents && (
        <PanelSection
          title="This part"
          aside={(
            <button
              type="button"
              className={`text-button text-button-danger${intake.clearAllArmed ? ' armed' : ''}`}
              title={intake.clearAllArmed
                ? 'Confirm reset of the project, parameters, and generated results.'
                : 'Reset the project, parameters, and generated results.'}
              aria-live="polite"
              onClick={intake.reset}
            >
              {intake.clearAllArmed ? 'Confirm start over' : 'Start over'}
            </button>
          )}
        >
          <dl className="facts">
            <dt>{store.originalMesh ? 'File' : 'Model'}</dt><dd>{store.meshFileName}</dd>
            <dt>Size</dt><dd className="mono">{formatDimensions(extents.size)}</dd>
            <dt>Volume</dt><dd className="mono">{formatVolume(extents.volumeMm3)}</dd>
            {store.meshInfo ? (
              <>
                <dt>Triangles</dt><dd className="mono">{store.meshInfo.triangleCount.toLocaleString()}</dd>
                <dt>Vertices</dt><dd className="mono">{store.meshInfo.vertexCount.toLocaleString()}</dd>
                <dt>Watertight</dt><dd>{store.meshInfo.isWatertight ? 'Yes' : 'No'}</dd>
                <dt>Manifold</dt><dd>{store.meshInfo.isManifold ? 'Yes' : 'No'}</dd>
              </>
            ) : (
              <><dt>Mode</dt><dd>Procedural (analytic SDF)</dd></>
            )}
          </dl>
          {meshCondition?.level === 'warn' && store.meshInfo && (
            <div className="warning">
              {meshCondition.message}
              {!store.meshInfo.isWatertight && (
                <div style={{ marginTop: '6px' }}>
                  <button type="button" className="btn btn-tiny" onClick={intake.closeHoles} title="Fill each open boundary loop with triangles.">
                    Close holes
                  </button>
                </div>
              )}
            </div>
          )}
        </PanelSection>
      )}
    </StepPanel>
  );
}

/** A small outline of each sample, so the list reads at a glance. */
export function SampleGlyph({ shape }: { shape: SampleShape }) {
  return (
    <svg className="sample-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {shape === 'sphere' && (<><circle cx="12" cy="12" r="8.5" /><ellipse cx="12" cy="12" rx="8.5" ry="3" /></>)}
      {shape === 'cube' && (<><path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9z" /><path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9" /></>)}
      {shape === 'cylinder' && (<><ellipse cx="12" cy="6" rx="6.5" ry="2.5" /><path d="M5.5 6v12c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V6" /></>)}
      {shape === 'torus' && (<><ellipse cx="12" cy="12" rx="9" ry="5.5" /><ellipse cx="12" cy="11.5" rx="3.5" ry="1.6" /></>)}
      {shape === 'capsule' && (<><rect x="7" y="2.5" width="10" height="19" rx="5" /><path d="M7 9.5c1.5 1 8.5 1 10 0" /></>)}
    </svg>
  );
}
