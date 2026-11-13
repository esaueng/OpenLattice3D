import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { countApi, handleGlimpseUsage, parseUsage, type GlimpseEnv } from './glimpse';
const record = vi.fn().mockResolvedValue(undefined);
const limit = vi.fn().mockResolvedValue({ success: true });
const enabled: GlimpseEnv = { GLIMPSE: { record }, GLIMPSE_BASIC_ENABLED: 'true', GLIMPSE_USAGE_ENABLED: 'true', GLIMPSE_USAGE_LIMITER: { limit } };
const value = { event: 'generation_completed', bucket: 'none' };
const request = (body: unknown = value, headers: Record<string, string> = {}) => new Request('https://openlattice3d.com/api/glimpse/usage', {
  method: 'POST', headers: { Origin: 'https://openlattice3d.com', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
beforeEach(() => { vi.clearAllMocks(); record.mockResolvedValue(undefined); limit.mockResolvedValue({ success: true }); });

describe('Glimpse relay', () => {
  it('accepts only the original usage events and coarse buckets', () => {
    for (const key of ['email', 'filename', 'geometry', 'url', 'app', 'level', 'count', 'timestamp', 'consent']) {
      expect(parseUsage({ ...value, [key]: 'private' })).toBeNull();
    }
    for (const invalid of [null, [], {}, { ...value, event: 'api_request' }, { ...value, event: 'solver_completed' }, { ...value, bucket: 'private.stl' }]) expect(parseUsage(invalid)).toBeNull();
    expect(parseUsage({ event: 'operation_latency', bucket: '100ms_1s' })).toEqual({ level: 'optional', event: 'operation_latency', bucket: '100ms_1s' });
  });
  it('accepts exactly the targeted subset (Glimpse LATTICE_EXPANDED) and nothing else from v2', () => {
    for (const code of ['error_runtime', 'error_import', 'error_export', 'error_storage', 'error_render', 'error_unresponsive', 'error_gpu_lost', 'error_out_of_memory', 'error_worker']) {
      expect(parseUsage({ event: code, bucket: 'none' })).toEqual({ level: 'optional', event: code, bucket: 'none' });
      expect(parseUsage({ event: code, bucket: 'lt_1k' })).toBeNull();
    }
    for (const [event, bucket] of [['export_latency', 'gte_60s'], ['project_size', 'gte_100mib'], ['feature_category', 'measure'], ['lattice_cells', 'gte_100k'], ['lattice_cells', 'lt_1k']]) {
      expect(parseUsage({ event, bucket })).toEqual({ level: 'optional', event, bucket });
    }
    for (const [event, bucket] of [
      ['error_mesh', 'none'], ['error_solver', 'none'], ['error_cloud_save', 'none'], ['error_cloud_load', 'none'], ['error_feature', 'none'],
      ['feature_category', 'edit'], ['feature_category', 'mesh'], ['feature_category', 'solve'], ['save_latency', 'lt_100ms'],
      ['mesh_latency', 'lt_100ms'], ['solver_backend', 'cpu'], ['part_count', '1'], ['transfer_upload', 'lt_1mib'],
      ['cloud_status', 'network'], ['feature_operation', 'transaction'], ['lattice_cells', '12345'], ['project_size', '5000000'],
    ]) expect(parseUsage({ event, bucket })).toBeNull();
  });
  it('drops a subset event an older Glimpse rejects, but still reports v1 outages', async () => {
    record.mockRejectedValue(new Error('Invalid metric'));
    expect((await handleGlimpseUsage(request({ event: 'lattice_cells', bucket: '1k_10k' }), enabled)).status).toBe(204);
    expect(record).toHaveBeenCalledExactlyOnceWith({ level: 'optional', event: 'lattice_cells', bucket: '1k_10k' });
    expect((await handleGlimpseUsage(request(), enabled)).status).toBe(503);
  });
  it('constructs a minimal RPC and excludes telemetry, health and assets from basic counts', async () => {
    const waitUntil = vi.fn();
    expect((await worker.fetch(request(), enabled, { waitUntil })).status).toBe(204);
    expect(record).toHaveBeenCalledExactlyOnceWith({ level: 'optional', ...value });
    for (const path of ['/health', '/healthz', '/assets/model.stl']) await worker.fetch(new Request(`https://openlattice3d.com${path}`), enabled, { waitUntil });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith({ key: 'aggregate-usage' });
  });
  it('defaults off and tolerates absent bindings with either switch enabled', async () => {
    for (const env of [{}, { ...enabled, GLIMPSE_USAGE_ENABLED: 'false' }, { ...enabled, GLIMPSE: undefined }]) {
      expect((await handleGlimpseUsage(request(), env)).status).toBe(204);
    }
    expect(record).not.toHaveBeenCalled();
    await countApi({}, 500, 1000);
    await countApi({ ...enabled, GLIMPSE_BASIC_ENABLED: 'false' }, 500, 1000);
    expect(record).not.toHaveBeenCalled();
  });
  it('enforces same origin, method, content type, body size and the global limiter', async () => {
    expect((await handleGlimpseUsage(new Request('https://openlattice3d.com/api/glimpse/usage'), enabled)).status).toBe(405);
    expect((await handleGlimpseUsage(request(value, { Origin: 'https://other.test' }), enabled)).status).toBe(403);
    expect((await handleGlimpseUsage(request(value, { 'Sec-Fetch-Site': 'cross-site' }), enabled)).status).toBe(403);
    expect((await handleGlimpseUsage(request(value, { 'Content-Type': 'text/plain' }), enabled)).status).toBe(415);
    expect((await handleGlimpseUsage(request('x'.repeat(300)), enabled)).status).toBe(413);
    expect((await handleGlimpseUsage(request(value, { 'Content-Length': '300' }), enabled)).status).toBe(413);
    expect((await handleGlimpseUsage(request({ ...value, filename: 'private.stl' }), enabled)).status).toBe(400);
    limit.mockResolvedValueOnce({ success: false });
    expect((await handleGlimpseUsage(request(), enabled)).status).toBe(429);
    expect((await handleGlimpseUsage(request(), { ...enabled, GLIMPSE_USAGE_LIMITER: undefined })).status).toBe(429);
    expect(record).not.toHaveBeenCalled();
  });
  it('bounds streamed bodies without relying on Content-Length', async () => {
    let cancelled = false;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(200)); }, cancel() { cancelled = true; } });
    const req = new Request('https://openlattice3d.com/api/glimpse/usage', {
      method: 'POST', headers: { Origin: 'https://openlattice3d.com', 'Content-Type': 'application/json' }, body, duplex: 'half',
    } as RequestInit);
    expect((await handleGlimpseUsage(req, enabled)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(record).not.toHaveBeenCalled();
  });
  it('keeps delivery failures contained and does not log payloads', async () => {
    record.mockRejectedValue(new Error('unavailable'));
    expect((await handleGlimpseUsage(request(), enabled)).status).toBe(503);
    await expect(countApi(enabled, 503, 12)).resolves.toBeUndefined();
    limit.mockRejectedValueOnce(new Error('unavailable'));
    expect((await handleGlimpseUsage(request(), enabled)).status).toBe(503);
  });
  it('counts only backend API request, error and duration without client dimensions', async () => {
    await countApi(enabled, 503, 1234);
    expect(record.mock.calls.map(([metric]) => metric)).toEqual([
      { level: 'basic', event: 'api_request', bucket: 'none' },
      { level: 'basic', event: 'api_latency', bucket: '1s_10s' },
      { level: 'basic', event: 'api_error', bucket: 'none' },
    ]);
  });
});
