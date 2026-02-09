interface Env {
  ASSETS: Fetcher;
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
