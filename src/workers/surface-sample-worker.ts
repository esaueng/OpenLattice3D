import type { SampleShape } from '../types/project';
import {
  generateShapeSurfaceSamples,
  type ShapeSampleParams,
} from './surface-sampling';

export type ShapeSampleWorkerMessage = {
  mode: 'shape';
  shape: SampleShape;
  params: ShapeSampleParams;
  targetCount: number;
  minDistance: number;
  streamSeed: number;
  streamId: number;
};

type WorkerResponse = {
  streamId: number;
  positions: Float32Array;
  normals: Float32Array;
};

type WorkerPostMessage = (message: unknown, transfer: Transferable[]) => void;
const postWorkerMessage = self.postMessage.bind(self) as WorkerPostMessage;

self.onmessage = (event: MessageEvent<ShapeSampleWorkerMessage>) => {
  const message = event.data;
  const samples = generateShapeSurfaceSamples(
    message.shape,
    message.params,
    message.targetCount,
    message.minDistance,
    message.streamSeed,
  );
  const positions = new Float32Array(samples.length * 3);
  const normals = new Float32Array(samples.length * 3);
  for (let i = 0; i < samples.length; i++) {
    positions.set(samples[i].pos, i * 3);
    normals.set(samples[i].normal, i * 3);
  }
  const response: WorkerResponse = {
    streamId: message.streamId,
    positions,
    normals,
  };
  postWorkerMessage(response, [positions.buffer, normals.buffer]);
};
