// What the empty viewer offers instead of a black canvas: three ways in, samples inline.
import { SAMPLE_SHAPE_INFO } from '../store/useStore';
import type { SampleShape } from '../types/project';
import { useModelImport } from '../hooks/useModelImport';
import { SampleGlyph } from './steps/ModelStep';
import { FolderOpenIcon, UploadIcon } from './icons';

export function StartOverlay() {
  const intake = useModelImport();
  return (
    <div className="start-overlay">
      {intake.fileInputs}
      <div className="start-card" role="region" aria-labelledby="start-title">
        <div className="start-brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span className="start-kicker">OpenLattice3D</span>
        </div>
        <h2 id="start-title">Fill a part with a printable lattice</h2>
        <p className="start-lede">
          Gyroids, struts and foams, generated and checked in your browser. Your model never leaves this device.
        </p>

        <div className="start-actions">
          <button type="button" className="start-action primary" onClick={() => intake.loadSample('sphere')}>
            <strong>Try a sample</strong>
            <small>Loads a 50 mm sphere</small>
          </button>
          <button type="button" className="start-action" onClick={intake.pickStl}>
            <UploadIcon size={16} />
            <strong>Import STL</strong>
            <small>Millimetres, closed mesh</small>
          </button>
          <button type="button" className="start-action" onClick={intake.pickProject}>
            <FolderOpenIcon size={16} />
            <strong>Open project</strong>
            <small>A saved .json file</small>
          </button>
        </div>

        <div className="start-samples">
          <span className="start-samples-label" id="start-samples-label">Or pick a sample shape</span>
          <div className="start-sample-row" role="group" aria-labelledby="start-samples-label">
            {(Object.keys(SAMPLE_SHAPE_INFO) as SampleShape[]).map((shape) => (
              <button key={shape} type="button" className="start-sample" title={SAMPLE_SHAPE_INFO[shape].label} onClick={() => intake.loadSample(shape)}>
                <SampleGlyph shape={shape} />
                <span>{SAMPLE_SHAPE_INFO[shape].fileName.split(' ')[0]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
