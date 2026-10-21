// Model intake shared by the Model step and the empty-viewer start card:
// STL import with orientation and unit checks, project/parameter JSON, samples.
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
import type { SampleShape } from '../types/project';
import { parseProjectFile } from '../utils/project-file';
import { SAMPLE_SHAPE_INFO } from '../store/useStore';
import { formatGenerationSeed } from '../geometry/deterministic-random';
import { describeMeshCondition, formatDimensions, modelExtents } from '../utils/model-summary';

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
      const buffer = await file.arrayBuffer();
      if (useStore.getState().modelIntakeEpoch !== epoch) return;
      let mesh = parseSTL(buffer);
      let info = analyzeMesh(mesh);
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

      const extents = modelExtents(info, null, 25)!;
      const dims = formatDimensions(extents.size);
      const largest = Math.max(...extents.size);
      // STL carries no units: a 1-unit part is almost always inches read as mm.
      const scalePrompt = largest > 0 && (largest < 5 || largest > 1000);
      if (!info.isManifold || !info.isWatertight) {
        // "Repair" here only recomputes face normals; the surface stays open.
        const { mesh: repairedMesh, repaired } = repairMesh(mesh);
        info = { ...info, repaired };
        const condition = describeMeshCondition(info);
        store.setOriginalMesh(repairedMesh, info, file.name);
        store.setMeshRepaired(repaired);
        store.addLog(condition.message, 'warn');
        store.setImportNotice({
          level: 'warn',
          message: `Imported ${file.name} (${dims}), but it is not closed.`,
          detail: condition.message,
          scalePrompt,
        });
      } else {
        store.addLog('Mesh is closed and manifold', 'info');
        store.setOriginalMesh(mesh, info, file.name);
        store.setImportNotice({
          level: scalePrompt ? 'warn' : 'info',
          message: scalePrompt
            ? `Imported ${file.name} at ${dims}. STL files carry no units; is that right?`
            : `Imported ${file.name}: ${info.triangleCount.toLocaleString()} triangles, ${dims}.`,
          scalePrompt,
        });
      }
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
      const text = await file.text();
      if (useStore.getState().modelIntakeEpoch !== epoch) return;
      const data: unknown = JSON.parse(text);
      const parsed = parseProjectFile(data);
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
