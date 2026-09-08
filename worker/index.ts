export default {
  async fetch(request: Request) {
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

    return new Response('Not found', { status: 404 });
  },
};
