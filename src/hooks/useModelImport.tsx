// Model intake shared by the Model step and the empty-viewer start card:
// STL/3MF/OBJ import with orientation and unit checks, project/parameter JSON, samples.
import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { assertFileSizeWithinBudget, DEFAULT_IMPORT_LIMITS, MESH_FORMAT_LABEL, meshFileByteBudget, type MeshFileFormat } from '../geometry/mesh-limits';
import type { SampleShape } from '../types/project';
import { modelIntake } from './model-intake-client';
import { SAMPLE_SHAPE_INFO } from '../store/useStore';
import { formatGenerationSeed } from '../geometry/deterministic-random';
import { formatDimensions, modelExtents } from '../utils/model-summary';
import { describeWorkAtRisk, workLostByReplacingModel } from '../utils/model-replacement';
import { classifyModelFile, isMeshFileKind, MESH_FILE_ACCEPT } from '../utils/dropped-files';
import { confirmHint, REPLACE_MODEL_ACTION } from '../components/confirm';
import type { MeshIntake } from '../workers/model-intake';
import type { RestoredProjectFile } from '../utils/project-file';
import { isPendingCurrent, pendingReplacementLabel, usePendingReplacement, type PendingModelReplacement } from './pending-model-replacement';

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/^Error:\s*/, '');
  return String(err);
}

export function useModelImport() {
  const store = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  const activeIntake = useRef<number | null>(null);

  useEffect(() => () => {
    // Unmounting one intake surface must not cancel a newer request owned by
    // another mounted instance of this hook.
    if (activeIntake.current !== null) useStore.getState().cancelModelIntake(activeIntake.current);
  }, []);

  /**
   * Loading another model clears the result, painted faces, pinned run and undo
   * history. When any of that exists, park the load for the replace prompt.
   */
  const deferIfWorkAtRisk = useCallback((pending: PendingModelReplacement): boolean => {
    const risk = workLostByReplacingModel(useStore.getState());
    if (!risk) return false;
    usePendingReplacement.getState().request(pending);
    const label = pendingReplacementLabel(pending);
    store.addLog(`Loading ${label} would discard ${describeWorkAtRisk(risk)}. ${confirmHint(REPLACE_MODEL_ACTION, null)}`, 'warn');
    return true;
  }, [store]);

  const commitMesh = useCallback((result: MeshIntake, fileName: string) => {
    for (const log of result.logs) store.addLog(log.message, log.level);
    store.setOriginalMesh(result.mesh, result.info, fileName);
    if (!result.info.isManifold || !result.info.isWatertight) store.setMeshRepaired(result.info.repaired);
    store.setImportNotice(result.notice);
  }, [store]);

  const importMesh = useCallback(async (file: File, format: MeshFileFormat) => {
    const epoch = store.beginModelIntake();
    activeIntake.current = epoch;
    store.addLog(`Importing ${file.name}...`);
    try {
      // Check the declared size before reading: arrayBuffer() would otherwise
      // pull the whole file into tab memory before any limit could apply.
      assertFileSizeWithinBudget(file.size, meshFileByteBudget(format), `${MESH_FORMAT_LABEL[format]} file ${file.name}`);
      const result = await modelIntake.run(epoch, { kind: format, file });
      if (!result || useStore.getState().modelIntakeEpoch !== epoch) return;
      if (result.kind !== 'mesh') throw new Error('Import worker returned the wrong file kind');
      if (deferIfWorkAtRisk({ kind: 'mesh', result, fileName: file.name, epoch })) return;
      commitMesh(result, file.name);
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
  }, [commitMesh, deferIfWorkAtRisk, store]);

  const commitSample = useCallback((shape: SampleShape) => {
    store.setSampleShape(shape);
    store.setImportNotice(null);
    store.addLog(`Sample loaded: ${SAMPLE_SHAPE_INFO[shape].fileName}`);
  }, [store]);

  const handleSampleShape = useCallback((shape: SampleShape) => {
    if (deferIfWorkAtRisk({ kind: 'sample', shape, epoch: useStore.getState().modelIntakeEpoch })) return;
    commitSample(shape);
  }, [commitSample, deferIfWorkAtRisk]);

  const commitProject = useCallback((parsed: RestoredProjectFile, fileName: string) => {
    const detail = parsed.warnings.length > 0 ? parsed.warnings.join(' ') : undefined;
    store.restoreProject(parsed);
    store.addLog(`Restored project from ${fileName}; regenerate to refresh geometry and validation`);
    store.setImportNotice({
      level: parsed.warnings.length > 0 ? 'warn' : 'info',
      message: `Opened project ${fileName}. Generate to rebuild the lattice.`,
      detail,
    });
  }, [store]);

  const importProject = useCallback(async (file: File) => {
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
        if (deferIfWorkAtRisk({ kind: 'project', parsed, fileName: file.name, epoch })) return;
        commitProject(parsed, file.name);
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
  }, [commitProject, deferIfWorkAtRisk, store]);

  const handleJsonImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so the same file can be re-imported
    e.target.value = '';
    if (!file) return;
    await importProject(file);
  }, [importProject]);

  const rejectUnsupported = useCallback((file: File) => {
    store.addLog(`Import skipped: ${file.name} is not an STL, 3MF, OBJ or project file`, 'warn');
    store.setImportNotice({
      level: 'error',
      message: `Could not import ${file.name}: use an .stl, .3mf or .obj mesh, or a .json project file.`,
      detail: useStore.getState().originalMesh || useStore.getState().sphereMode ? 'The previous model is still loaded.' : undefined,
    });
  }, [store]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so the same file can be re-imported after a fix.
    e.target.value = '';
    if (!file) return;
    // The accept list is only a hint. Route by extension; a file the picker
    // let through without one is read as STL (as before 3MF/OBJ support),
    // and the worker still recognizes a 3MF by its ZIP signature.
    const kind = classifyModelFile(file.name);
    if (kind === 'project') await importProject(file);
    else await importMesh(file, isMeshFileKind(kind) ? kind : 'stl');
  }, [importMesh, importProject]);

  /** Import a file chosen any other way (drag and drop), routed by its extension. */
  const importFile = useCallback(async (file: File) => {
    const kind = classifyModelFile(file.name);
    if (isMeshFileKind(kind)) return importMesh(file, kind);
    if (kind === 'project') return importProject(file);
    rejectUnsupported(file);
  }, [importMesh, importProject, rejectUnsupported]);

  const confirmReplacement = useCallback(() => {
    const { pending, clear } = usePendingReplacement.getState();
    clear();
    if (!pending || !isPendingCurrent(pending, useStore.getState().modelIntakeEpoch)) return;
    if (pending.kind === 'sample') commitSample(pending.shape);
    else if (pending.kind === 'mesh') commitMesh(pending.result, pending.fileName);
    else commitProject(pending.parsed, pending.fileName);
  }, [commitMesh, commitProject, commitSample]);

  const cancelReplacement = useCallback(() => {
    const { pending, clear } = usePendingReplacement.getState();
    if (!pending) return;
    clear();
    store.addLog(`Kept the current model; ${pendingReplacementLabel(pending)} was not loaded`);
  }, [store]);


  // Callers confirm first (ConfirmButton); this resets immediately.
  const handleStartOver = useCallback(() => {
    usePendingReplacement.getState().clear();
    store.resetProject();
    store.addLog('Project reset to defaults');
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
      <input ref={fileRef} type="file" accept={MESH_FILE_ACCEPT} onChange={handleFileUpload} hidden />
      <input ref={jsonRef} type="file" accept=".json" onChange={handleJsonImport} hidden />
    </>
  );

  return {
    fileInputs,
    pickModel: () => fileRef.current?.click(),
    pickProject: () => jsonRef.current?.click(),
    loadSample: handleSampleShape,
    importFile,
    confirmReplacement,
    cancelReplacement,
    startOver: handleStartOver,
    applyScale,
    closeHoles: handleCloseHoles,
    reseed: handleReseed,
    toggleDemoGrid,
  };
}
