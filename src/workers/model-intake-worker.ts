import { intakeTransfers, readModelFile, type IntakeRequest } from './model-intake';
import { failureCause } from '../utils/failure-cause';

const post = self.postMessage.bind(self) as (message: unknown, transfer: Transferable[]) => void;
self.onmessage = async (event: MessageEvent<IntakeRequest>) => {
  try {
    const result = await readModelFile(event.data);
    post({ type: 'result', result }, intakeTransfers(result));
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error), diagnostic: failureCause(error) }, []);
  }
};
