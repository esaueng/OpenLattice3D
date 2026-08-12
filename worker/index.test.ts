import { describe, expect, it } from 'vitest';
import worker from './index';

describe('production health check', () => {
  it('returns an uncached JSON success response at GET /health', async () => {
    const response = await worker.fetch(new Request('https://openlattice3d.com/health'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('preserves the 404 response for other worker-handled paths', async () => {
    const response = await worker.fetch(new Request('https://openlattice3d.com/missing'));

    expect(response.status).toBe(404);
  });
});
