interface Env {
  ASSETS: Fetcher;
  FEEDBACK_KV?: KVNamespace;
  FEEDBACK_EMAIL_TO?: string;
  FEEDBACK_EMAIL_FROM?: string;
}

const ASSET_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".css",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".txt",
  ".map",
  ".json",
  ".wasm",
  ".stl",
]);

function hasAssetExtension(pathname: string) {
  const lastDot = pathname.lastIndexOf(".");
  if (lastDot === -1) {
    return false;
  }
  return ASSET_EXTENSIONS.has(pathname.slice(lastDot));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/api/feedback") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return new Response("Expected JSON body", { status: 400 });
      }

      const { name, email, issue, userAgent, url: pageUrl, createdAt } =
        (await request.json()) as {
          name?: string;
          email?: string;
          issue?: string;
          userAgent?: string;
          url?: string;
          createdAt?: string;
        };

      if (!name?.trim() || !issue?.trim()) {
        return new Response("Name and issue are required.", { status: 400 });
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
            "content-type": "application/json",
            "cache-control": "max-age=86400",
          },
        });
        ctx.waitUntil(caches.default.put(cacheKey, cacheValue));
      }

      if (env.FEEDBACK_EMAIL_TO && env.FEEDBACK_EMAIL_FROM) {
        await fetch("https://api.mailchannels.net/tx/v1/send", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            personalizations: [
              {
                to: [{ email: env.FEEDBACK_EMAIL_TO }],
              },
            ],
            from: {
              email: env.FEEDBACK_EMAIL_FROM,
              name: "OpenLattice3D Feedback",
            },
            subject: `New feedback from ${feedbackEntry.name}`,
            content: [
              {
                type: "text/plain",
                value: [
                  `Name: ${feedbackEntry.name}`,
                  `Email: ${feedbackEntry.email ?? "n/a"}`,
                  `Issue: ${feedbackEntry.issue}`,
                  `Page: ${feedbackEntry.pageUrl ?? "unknown"}`,
                  `User Agent: ${feedbackEntry.userAgent ?? "unknown"}`,
                  `Submitted: ${feedbackEntry.createdAt}`,
                ].join("\n"),
              },
            ],
          }),
        });
      }

      return new Response("OK", { status: 200 });
    }

    let response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || hasAssetExtension(url.pathname)) {
      return response;
    }

    const fallbackUrl = new URL("/index.html", url);
    response = await env.ASSETS.fetch(new Request(fallbackUrl.toString(), request));

    if (response.status === 404) {
      return new Response("Not found", { status: 404 });
    }

    return response;
  },
};
