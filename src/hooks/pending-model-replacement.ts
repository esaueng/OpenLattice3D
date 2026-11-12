// A model load that would discard work waits here until the user confirms it.
// One slot, shared by every intake surface (Model step, project menu, drops), so
// the single prompt can show it whichever step is open.
import { create } from 'zustand';
import { SAMPLE_SHAPE_INFO, useStore } from '../store/useStore';
import type { SampleShape } from '../types/project';
import type { StlIntake } from '../workers/model-intake';
import type { RestoredProjectFile } from '../utils/project-file';

export type PendingModelReplacement =
  | { kind: 'sample'; shape: SampleShape; epoch: number }
  | { kind: 'stl'; result: StlIntake; fileName: string; epoch: number }
  | { kind: 'project'; parsed: RestoredProjectFile; fileName: string; epoch: number };

type PendingReplacementState = {
  pending: PendingModelReplacement | null;
  request: (pending: PendingModelReplacement) => void;
  clear: () => void;
};

export const usePendingReplacement = create<PendingReplacementState>((set) => ({
  pending: null,
  request: (pending) => set({ pending }),
  clear: () => set({ pending: null }),
}));

// Drop a superseded request (and the parsed mesh it may hold) as soon as the
// model changes some other way.
useStore.subscribe((state) => {
  const { pending, clear } = usePendingReplacement.getState();
  if (pending && pending.epoch !== state.modelIntakeEpoch) clear();
});

/**
 * A request is only valid for the model intake epoch it was made in: any newer
 * import, sample, project or reset supersedes it, as it would an in-flight import.
 */
export function isPendingCurrent(pending: PendingModelReplacement | null, modelIntakeEpoch: number): boolean {
  return pending !== null && pending.epoch === modelIntakeEpoch;
}

/** How the waiting model is named in the prompt and the log. */
export function pendingReplacementLabel(pending: PendingModelReplacement): string {
  if (pending.kind === 'sample') return `the ${SAMPLE_SHAPE_INFO[pending.shape].fileName} sample`;
  if (pending.kind === 'project') return `project ${pending.fileName}`;
  return pending.fileName;
}
