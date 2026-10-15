import { countApi, handleGlimpseUsage, type GlimpseEnv } from './glimpse';

export default {
  async fetch(request: Request, env: GlimpseEnv = {}, ctx?: Pick<ExecutionContext, 'waitUntil'>) {
    const started = performance.now();
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      const headers = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
      }
      return new Response(
        request.method === 'HEAD' ? null : JSON.stringify({ status: 'ok', service: 'openlattice3d' }),
        { headers },
      );
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    if (url.pathname === '/api/glimpse/usage') return handleGlimpseUsage(request, env);
    const response = new Response('Not found', { status: 404 });
    // No geometry API exists today. Health, assets and usage relay are excluded.
    if (url.pathname.startsWith('/api/') && ctx && env.GLIMPSE_BASIC_ENABLED === 'true') {
      ctx.waitUntil(countApi(env, response.status, performance.now() - started));
    }
    return response;
  },
};
