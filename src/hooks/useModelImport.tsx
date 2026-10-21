// Model intake shared by the Model step and the empty-viewer start card:
// STL import with orientation and unit checks, project/parameter JSON, samples.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { assertFileSizeWithinBudget, DEFAULT_IMPORT_LIMITS } from '../geometry/mesh-limits';
import type { SampleShape } from '../types/project';
import { modelIntake } from './model-intake-client';
import { SAMPLE_SHAPE_INFO } from '../store/useStore';
import { formatGenerationSeed } from '../geometry/deterministic-random';
import { formatDimensions, modelExtents } from '../utils/model-summary';

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/^Error:\s*/, '');
  return String(err);
}

export function useModelImport() {
  const store = useStore();
  const [clearAllArmed, setClearAllArmed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  const activeIntake = useRef<number | null>(null);

  useEffect(() => () => {
    // Unmounting one intake surface must not cancel a newer request owned by
    // another mounted instance of this hook.
    if (activeIntake.current !== null) useStore.getState().cancelModelIntake(activeIntake.current);
  }, []);

  useEffect(() => {
    if (!clearAllArmed) return;
    const timeout = window.setTimeout(() => setClearAllArmed(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [clearAllArmed]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so the same file can be re-imported after a fix.
    e.target.value = '';
    if (!file) return;
    const epoch = store.beginModelIntake();
    activeIntake.current = epoch;
    store.addLog(`Importing ${file.name}...`);
    try {
      // Check the declared size before reading: arrayBuffer() would otherwise
      // pull the whole file into tab memory before any limit could apply.
      assertFileSizeWithinBudget(file.size, DEFAULT_IMPORT_LIMITS.maxStlBytes, `STL file ${file.name}`);
      const result = await modelIntake.run(epoch, { kind: 'stl', file });
      if (!result || useStore.getState().modelIntakeEpoch !== epoch) return;
      if (result.kind !== 'stl') throw new Error('Import worker returned the wrong file kind');
      for (const log of result.logs) store.addLog(log.message, log.level);
      store.setOriginalMesh(result.mesh, result.info, file.name);
      if (!result.info.isManifold || !result.info.isWatertight) store.setMeshRepaired(result.info.repaired);
      store.setImportNotice(result.notice);
    } catch (err) {
      if (useStore.getState().modelIntakeEpoch !== epoch) return;
      const message = errorMessage(err);
      const current = useStore.getState();
      store.addLog(`Import failed: ${message}`, 'error');
      store.setImportNotice({
        level: 'error',
        message: `Could not import ${file.name}: ${message}`,
        detail: current.originalMesh || current.sphereMode ? 'The previous model is still loaded.' : undefined,
      });
    } finally {
      if (activeIntake.current === epoch) activeIntake.current = null;
    }
  }, [store]);

  const handleSampleShape = useCallback((shape: SampleShape) => {
    store.setSampleShape(shape);
    store.setImportNotice(null);
    store.addLog(`Sample loaded: ${SAMPLE_SHAPE_INFO[shape].fileName}`);
  }, [store]);

  const handleJsonImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so the same file can be re-imported
    e.target.value = '';
    if (!file) return;
    const epoch = store.beginModelIntake();
    activeIntake.current = epoch;
    try {
      assertFileSizeWithinBudget(file.size, DEFAULT_IMPORT_LIMITS.maxProjectBytes, `Project file ${file.name}`);
      const result = await modelIntake.run(epoch, { kind: 'json', file });
      if (!result || useStore.getState().modelIntakeEpoch !== epoch) return;
      if (result.kind !== 'json') throw new Error('Import worker returned the wrong file kind');
      const parsed = result.parsed;
      for (const warning of parsed.warnings) store.addLog(`JSON import: ${warning}`, 'warn');
      const detail = parsed.warnings.length > 0 ? parsed.warnings.join(' ') : undefined;
      if (parsed.kind === 'project') {
        store.restoreProject(parsed);
        store.addLog(`Restored project from ${file.name}; regenerate to refresh geometry and validation`);
        store.setImportNotice({
          level: parsed.warnings.length > 0 ? 'warn' : 'info',
          message: `Opened project ${file.name}. Generate to rebuild the lattice.`,
          detail,
        });
      } else {
        if (parsed.accepted.length === 0) {
          store.addLog('JSON import: no valid parameters found', 'error');
          store.setImportNotice({
            level: 'error',
            message: `${file.name} contains no usable lattice parameters.`,
            detail,
          });
          return;
        }
        store.importParams(parsed.params);
        store.addLog(`Imported ${parsed.accepted.length} parameter(s) from ${file.name}`);
        store.setImportNotice({
          level: parsed.warnings.length > 0 ? 'warn' : 'info',
          message: `Applied ${parsed.accepted.length} parameter(s) from ${file.name}: ${parsed.accepted.join(', ')}.`,
          detail,
        });
      }
    } catch (err) {
      if (useStore.getState().modelIntakeEpoch !== epoch) return;
      const message = errorMessage(err);
      store.addLog(`JSON import failed: ${message}`, 'error');
      store.setImportNotice({ level: 'error', message: `Could not read ${file.name}: ${message}` });
    } finally {
      if (activeIntake.current === epoch) activeIntake.current = null;
    }
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

  const applyScale = useCallback((factor: number, label: string) => {
    store.scaleOriginalMesh(factor);
    const info = useStore.getState().meshInfo;
    const dims = info ? formatDimensions(modelExtents(info, null, 25)!.size) : '';
    store.addLog(`Model rescaled ${label}: now ${dims}`);
    store.setImportNotice({ level: 'info', message: `Rescaled ${label}. The model is now ${dims}.` });
  }, [store]);

  const handleCloseHoles = useCallback(() => {
    const report = store.closeMeshHoles();
    if (!report) return;
    const closed = report.after === 0;
    store.addLog(`Closed boundary loops: ${report.before} → ${report.after} boundary edges`, closed ? 'info' : 'warn');
    store.setImportNotice({
      level: closed ? 'info' : 'warn',
      message: closed
        ? 'Holes closed; the mesh is now watertight.'
        : `Filled what could be matched; ${report.after} boundary edges remain.`,
    });
  }, [store]);

  const handleReseed = useCallback(() => {
    store.reseedGeneration();
    store.addLog(`Generation reseeded to ${formatGenerationSeed(useStore.getState().generationSeed)}; regenerate to apply`);
  }, [store]);

  const fileInputs = (
    <>
      <input ref={fileRef} type="file" accept=".stl" onChange={handleFileUpload} hidden />
      <input ref={jsonRef} type="file" accept=".json" onChange={handleJsonImport} hidden />
    </>
  );

  return {
    fileInputs,
    pickStl: () => fileRef.current?.click(),
    pickProject: () => jsonRef.current?.click(),
    loadSample: handleSampleShape,
    reset: handleReset,
    clearAllArmed,
    applyScale,
    closeHoles: handleCloseHoles,
    reseed: handleReseed,
    toggleDemoGrid,
  };
}
