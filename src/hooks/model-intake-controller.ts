import type { ModelIntake, IntakeRequest } from '../workers/model-intake';
import { DEFAULT_IMPORT_LIMITS } from '../geometry/mesh-limits';
import type { GenerationWorkerLike } from './generation-worker-controller';
import { DEFAULT_PARAMS, sanitizeLatticeParams } from '../types/project';

type Session = {
  epoch: number;
  kind: IntakeRequest['kind'];
  worker: GenerationWorkerLike;
  resolve: (result: ModelIntake | null) => void;
  reject: (error: Error) => void;
};
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === 'string');
const level = (v: unknown) => v === 'info' || v === 'warn' || v === 'error';
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const vector = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
function mesh(v: unknown): boolean {
  return record(v) && count(v.triCount) && (v.triCount as number) > 0 && (v.triCount as number) <= DEFAULT_IMPORT_LIMITS.maxTriangles
    && v.positions instanceof Float32Array && v.positions.length === (v.triCount as number) * 9
    && v.normals instanceof Float32Array && v.normals.length === (v.triCount as number) * 3;
}
function info(v: unknown): boolean {
  return record(v) && count(v.triangleCount) && count(v.vertexCount) && count(v.boundaryEdges) && count(v.nonManifoldEdges)
    && typeof v.isWatertight === 'boolean' && typeof v.isManifold === 'boolean' && typeof v.repaired === 'boolean'
    && (v.volumeMm3 === null || (typeof v.volumeMm3 === 'number' && Number.isFinite(v.volumeMm3)))
    && record(v.boundingBox) && vector(v.boundingBox.min) && vector(v.boundingBox.max);
}
/** Validate protocol shape without repeating O(mesh-size) geometry analysis on the UI thread. */
export function isModelIntake(v: unknown, kind: IntakeRequest['kind']): v is ModelIntake {
  if (!record(v) || v.kind !== kind) return false;
  if (v.kind === 'stl') {
    return mesh(v.mesh) && info(v.info) && record(v.mesh) && record(v.info) && v.mesh.triCount === v.info.triangleCount
      && record(v.notice) && level(v.notice.level) && typeof v.notice.message === 'string'
      && (v.notice.detail === undefined || typeof v.notice.detail === 'string')
      && typeof v.notice.scalePrompt === 'boolean'
      && Array.isArray(v.logs) && v.logs.every(log => record(log) && level(log.level) && typeof log.message === 'string');
  }
  const p = v.parsed;
  if (!record(p) || !record(p.params) || !strings(p.warnings)) return false;
  const sanitized = sanitizeLatticeParams(p.params);
  if (sanitized.rejected.length || sanitized.accepted.length !== Object.keys(p.params).length) return false;
  if (p.kind === 'parameters') return strings(p.accepted) && p.accepted.length === sanitized.accepted.length
    && p.accepted.every(key => sanitized.accepted.includes(key as keyof typeof DEFAULT_PARAMS));
  if (sanitized.accepted.length !== Object.keys(DEFAULT_PARAMS).length) return false;
  return p.kind === 'project' && typeof p.meshFileName === 'string' && typeof p.generationSeed === 'number'
    && Number.isInteger(p.generationSeed) && p.generationSeed >= 0 && p.generationSeed <= 0xffff_ffff
    && typeof p.sphereRadius === 'number' && Number.isFinite(p.sphereRadius)
    && Array.isArray(p.keepOutTris) && Array.isArray(p.keepInTris)
    && (p.originalMesh === null ? p.meshInfo === null && ['sphere', 'cube', 'cylinder', 'torus', 'capsule'].includes(p.sampleShape as string)
      : mesh(p.originalMesh) && info(p.meshInfo) && p.sampleShape === null);
}

/** A single active worker with explicit ownership and cancellation of pending CPU work. */
export class ModelIntakeController {
  private active: Session | null = null;
  private readonly createWorker: () => GenerationWorkerLike;
  constructor(createWorker: () => GenerationWorkerLike) { this.createWorker = createWorker; }

  cancelUnless(epoch: number): void {
    if (this.active && this.active.epoch !== epoch) this.finish(this.active, null);
  }

  dispose(): void { if (this.active) this.finish(this.active, null); }

  run(epoch: number, request: IntakeRequest): Promise<ModelIntake | null> {
    this.dispose();
    return new Promise((resolve, reject) => {
      let worker: GenerationWorkerLike;
      try { worker = this.createWorker(); }
      catch (error) { reject(new Error(`Could not start import worker: ${error instanceof Error ? error.message : String(error)}`)); return; }
      const session: Session = { epoch, kind: request.kind, worker, resolve, reject };
      this.active = session;
      worker.onmessage = ({ data }) => {
        if (this.active !== session) return;
        if (record(data) && data.type === 'result' && isModelIntake(data.result, session.kind)) this.finish(session, data.result);
        else if (record(data) && data.type === 'error' && typeof data.message === 'string' && data.message.trim()) this.fail(session, data.message);
        else this.fail(session, 'Import worker returned a malformed response');
      };
      worker.onerror = event => { event.preventDefault?.(); this.fail(session, `Import worker crashed${event.message ? `: ${event.message}` : ''}`); };
      worker.onmessageerror = () => this.fail(session, 'Import worker returned an unreadable response');
      // File is structured-cloned. Existing store buffers are never sent or detached.
      try { worker.postMessage(request); }
      catch (error) { this.fail(session, `Could not start import worker: ${error instanceof Error ? error.message : String(error)}`); }
    });
  }

  private release(session: Session): void {
    this.active = null;
    session.worker.onmessage = session.worker.onerror = session.worker.onmessageerror = null;
    session.worker.terminate();
  }
  private finish(session: Session, result: ModelIntake | null): void {
    if (this.active !== session) return;
    this.release(session);
    session.resolve(result);
  }
  private fail(session: Session, message: string): void {
    if (this.active !== session) return;
    this.release(session);
    session.reject(new Error(message));
  }
}
