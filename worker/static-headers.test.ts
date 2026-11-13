import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';

/** Headers that public/_headers applies to every static asset path. */
function productionHeaders(): Record<string, string> {
  const lines = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').split(/\r?\n/);
  expect(lines[0]).toBe('/*');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(':');
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function lowerCaseKeys(headers: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

describe('static asset security headers', () => {
  const production = productionHeaders();

  it('keeps cross-origin isolation and baseline hardening in production', () => {
    expect(production).toMatchObject({
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    expect(production['permissions-policy']).toContain('camera=()');
  });

  it('allows only same-origin code, workers and connections', () => {
    const directives = Object.fromEntries(
      production['content-security-policy'].split(';').map((part) => {
        const [name, ...values] = part.trim().split(/\s+/);
        return [name, values];
      }),
    );
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['worker-src']).toEqual(["'self'"]);
    expect(directives['connect-src']).toEqual(["'self'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(production['content-security-policy']).not.toMatch(/unsafe-eval|unsafe-inline|https?:/);
  });

  it('previews with exactly the production headers', () => {
    expect(lowerCaseKeys(viteConfig.preview?.headers as Record<string, unknown>)).toEqual(production);
  });

  it('keeps the dev server isolated without a CSP (Vite HMR injects inline code)', () => {
    const dev = lowerCaseKeys(viteConfig.server?.headers as Record<string, unknown>);
    expect(dev['content-security-policy']).toBeUndefined();
    const { 'content-security-policy': _csp, ...rest } = production;
    void _csp;
    expect(dev).toEqual(rest);
  });
});
