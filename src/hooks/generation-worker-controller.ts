export type GenerationProgressResponse = {
  type: 'progress';
  progress: number;
  message: string;
  transient?: boolean;
};

export type GenerationResultResponse = {
  type: 'result';
  positions: Float32Array;
  normals: Float32Array;
  triCount: number;
  backend?: 'cpu-single' | 'cpu-tiled';
  surfaceSamplePositions?: Float32Array;
  surfaceSampleNormals?: Float32Array;
  surfaceSampleHoleScales?: Float32Array;
  thinFilterSkipped?: string;
};

export type GenerationResponse = GenerationProgressResponse | GenerationResultResponse | {
  type: 'error';
  message: string;
};

export type WorkerErrorLike = {
  message?: string;
  preventDefault?: () => void;
};

export interface GenerationWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: WorkerErrorLike) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface GenerationWorkerCallbacks {
  onProgress(response: GenerationProgressResponse): void;
  onResult(response: GenerationResultResponse): void;
  onFailure(message: string): void;
}

type ActiveSession = {
  id: number;
  worker: GenerationWorkerLike;
  callbacks: GenerationWorkerCallbacks;
};

function optionalFloat32Array(value: unknown): boolean {
  return value === undefined || value instanceof Float32Array;
}

export function parseGenerationResponse(value: unknown): GenerationResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const response = value as Record<string, unknown>;
  if (response.type === 'progress') {
    if (
      typeof response.progress !== 'number'
      || !Number.isFinite(response.progress)
      || response.progress < 0
      || response.progress > 1
      || typeof response.message !== 'string'
      || (response.transient !== undefined && typeof response.transient !== 'boolean')
    ) return null;
    return response as GenerationProgressResponse;
  }
  if (response.type === 'error') {
    if (typeof response.message !== 'string' || response.message.trim().length === 0) return null;
    return { type: 'error', message: response.message };
  }
  if (response.type !== 'result') return null;
  if (
    !(response.positions instanceof Float32Array)
    || !(response.normals instanceof Float32Array)
    || !Number.isInteger(response.triCount)
    || (response.triCount as number) < 0
    || response.positions.length < (response.triCount as number) * 9
    || response.normals.length < (response.triCount as number) * 3
    || !optionalFloat32Array(response.surfaceSamplePositions)
    || !optionalFloat32Array(response.surfaceSampleNormals)
    || !optionalFloat32Array(response.surfaceSampleHoleScales)
    || (response.thinFilterSkipped !== undefined && typeof response.thinFilterSkipped !== 'string')
    || (response.backend !== undefined && response.backend !== 'cpu-single' && response.backend !== 'cpu-tiled')
  ) return null;
  return response as unknown as GenerationResultResponse;
}

export class GenerationWorkerController {
  private nextId = 0;
  private active: ActiveSession | null = null;
  private readonly schedule: (task: () => void, delayMs: number) => unknown;

  constructor(
    schedule: (task: () => void, delayMs: number) => unknown = (task, delayMs) => setTimeout(task, delayMs),
  ) {
    this.schedule = schedule;
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  start(worker: GenerationWorkerLike, callbacks: GenerationWorkerCallbacks): number {
    this.terminateActive();
    const session: ActiveSession = { id: ++this.nextId, worker, callbacks };
    this.active = session;
    worker.onmessage = (event) => this.handleMessage(session, event.data);
    worker.onerror = (event) => {
      event.preventDefault?.();
      const detail = typeof event.message === 'string' && event.message.trim()
        ? `: ${event.message.trim()}`
        : '';
      this.fail(session, `Generation worker crashed${detail}`);
    };
    worker.onmessageerror = () => {
      this.fail(session, 'Generation worker returned an unreadable response');
    };
    return session.id;
  }

  post(message: unknown, transfer: Transferable[] = []): void {
    const session = this.active;
    if (!session) throw new Error('No active generation worker');
    try {
      session.worker.postMessage(message, transfer);
    } catch (error) {
      const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
      this.fail(session, `Could not start generation worker${detail}`);
    }
  }

  cancel(cancelMessage: unknown, terminateDelayMs = 50): boolean {
    const session = this.active;
    if (!session) return false;
    this.active = null;
    this.nextId++;
    try {
      session.worker.postMessage(cancelMessage);
    } catch {
      // The session is already invalidated; termination below is the fail-safe.
    } finally {
      this.schedule(() => session.worker.terminate(), terminateDelayMs);
    }
    return true;
  }

  dispose(): void {
    this.terminateActive();
    this.nextId++;
  }

  private handleMessage(session: ActiveSession, value: unknown): void {
    if (!this.isCurrent(session)) return;
    const response = parseGenerationResponse(value);
    if (!response) {
      this.fail(session, 'Generation worker returned a malformed response');
      return;
    }
    if (response.type === 'progress') {
      session.callbacks.onProgress(response);
      return;
    }
    if (response.type === 'error') {
      this.fail(session, `Generation failed: ${response.message}`);
      return;
    }
    this.active = null;
    session.worker.terminate();
    session.callbacks.onResult(response);
  }

  private fail(session: ActiveSession, message: string): void {
    if (!this.isCurrent(session)) return;
    this.active = null;
    session.worker.terminate();
    session.callbacks.onFailure(message);
  }

  private isCurrent(session: ActiveSession): boolean {
    return this.active?.id === session.id && this.active.worker === session.worker;
  }

  private terminateActive(): void {
    const session = this.active;
    this.active = null;
    if (session) session.worker.terminate();
  }
}
