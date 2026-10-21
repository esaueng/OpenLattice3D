import { useStore } from '../store/useStore';
import { ModelIntakeController } from './model-intake-controller';
import type { GenerationWorkerLike } from './generation-worker-controller';

// Every intake surface shares this controller, matching the store-owned epoch.
export const modelIntake = new ModelIntakeController(() => new Worker(
  new URL('../workers/model-intake-worker.ts', import.meta.url), { type: 'module' },
) as unknown as GenerationWorkerLike);
const unsubscribe = useStore.subscribe((state) => modelIntake.cancelUnless(state.modelIntakeEpoch));
if (import.meta.hot) import.meta.hot.dispose(() => { unsubscribe(); modelIntake.dispose(); });
