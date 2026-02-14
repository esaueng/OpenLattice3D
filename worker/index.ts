interface Env {
  FEEDBACK_KV?: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === '/api/feedback') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      const contentType = request.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        return new Response('Expected JSON body', { status: 400 });
      }

      let payload: {
        name?: string;
        email?: string;
        issue?: string;
        userAgent?: string;
        url?: string;
        createdAt?: string;
      };

      try {
        payload = (await request.json()) as {
          name?: string;
          email?: string;
          issue?: string;
          userAgent?: string;
          url?: string;
          createdAt?: string;
        };
      } catch {
        return new Response('Invalid JSON body', { status: 400 });
      }

      const { name, email, issue, userAgent, url: pageUrl, createdAt } = payload;

      if (!name?.trim() || !issue?.trim()) {
        return new Response('Name and issue are required.', { status: 400 });
      }

      if (name.length > 200 || issue.length > 5000 || (email && email.length > 320)) {
        return new Response('Feedback fields exceed maximum length.', { status: 400 });
      }

      const feedbackEntry = {
        id: crypto.randomUUID(),
        name: name.trim(),
        email: email?.trim() || null,
        issue: issue.trim(),
        userAgent: userAgent ?? null,
        pageUrl: pageUrl ?? null,
        createdAt: createdAt ?? new Date().toISOString(),
        receivedAt: new Date().toISOString(),
      };

      const kvKey = `feedback:${feedbackEntry.receivedAt}:${feedbackEntry.id}`;
      if (env.FEEDBACK_KV) {
        await env.FEEDBACK_KV.put(kvKey, JSON.stringify(feedbackEntry));
      } else {
        const cacheKey = new Request(`https://feedback.local/${kvKey}`);
        const cacheValue = new Response(JSON.stringify(feedbackEntry), {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'max-age=86400',
          },
        });
        ctx.waitUntil(caches.default.put(cacheKey, cacheValue));
      }

      return new Response('OK', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  },
};
