import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

describe('production Glimpse connection', () => {
  it('connects enabled collection to the app-specific collector entrypoint', () => {
    expect(config.services).toContainEqual({
      binding: 'GLIMPSE', service: 'glimpse', entrypoint: 'OpenLattice3DIngest',
    });
    expect(config.ratelimits).toContainEqual(expect.objectContaining({ name: 'GLIMPSE_USAGE_LIMITER' }));
  });

  it('keeps branch previews from sending production analytics', () => {
    expect(config.previews.vars).toMatchObject({
      GLIMPSE_BASIC_ENABLED: 'false', GLIMPSE_USAGE_ENABLED: 'false',
    });
  });
});
