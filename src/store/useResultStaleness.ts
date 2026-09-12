import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './useStore';
import { buildGenerationSnapshot, describeSnapshotChanges, type GenerationInputs, type GenerationSnapshot } from './generation-snapshot';

export interface ResultStaleness {
  /** A result exists and its inputs no longer match the form. */
  stale: boolean;
  /** What changed, in form order; empty when not stale. */
  changes: string[];
}

export function selectGenerationInputs(state: {
  params: GenerationInputs['params'];
  generationSeed: number;
  originalMesh: GenerationInputs['originalMesh'];
  meshFileName: string;
  sampleShape: GenerationInputs['sampleShape'];
  sphereMode: boolean;
  sphereRadius: number;
  keepOutTris: Set<number>;
  keepInTris: Set<number>;
}): GenerationInputs {
  return {
    params: state.params,
    generationSeed: state.generationSeed,
    originalMesh: state.originalMesh,
    meshFileName: state.meshFileName,
    sampleShape: state.sampleShape,
    sphereMode: state.sphereMode,
    sphereRadius: state.sphereRadius,
    keepOutTris: state.keepOutTris,
    keepInTris: state.keepInTris,
  };
}

export function computeStaleness(snapshot: GenerationSnapshot | null, inputs: GenerationInputs): ResultStaleness {
  if (!snapshot) return { stale: false, changes: [] };
  if (buildGenerationSnapshot(inputs).signature === snapshot.signature) return { stale: false, changes: [] };
  return { stale: true, changes: describeSnapshotChanges(snapshot, inputs) };
}

/** Whether the result on screen still belongs to the settings in the form. */
export function useResultStaleness(): ResultStaleness {
  const slice = useStore(useShallow((s) => ({
    resultSnapshot: s.resultSnapshot,
    params: s.params,
    generationSeed: s.generationSeed,
    originalMesh: s.originalMesh,
    meshFileName: s.meshFileName,
    sampleShape: s.sampleShape,
    sphereMode: s.sphereMode,
    sphereRadius: s.sphereRadius,
    keepOutTris: s.keepOutTris,
    keepInTris: s.keepInTris,
  })));
  return useMemo(
    () => computeStaleness(slice.resultSnapshot, selectGenerationInputs(slice)),
    [slice],
  );
}
