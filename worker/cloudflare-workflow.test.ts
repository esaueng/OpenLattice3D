import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/cloudflare.yml', import.meta.url),
  'utf8',
);

const smokeJobMarker = '\n  smoke:\n';
const smokeJobIndex = workflow.indexOf(smokeJobMarker);

if (smokeJobIndex === -1) {
  throw new Error('Cloudflare workflow does not define a smoke job');
}

const smokeJob = workflow.slice(smokeJobIndex);

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe('Cloudflare workflow', () => {
  // Publishing is owned by Cloudflare Workers Builds. A second publisher here
  // would race it on every push to main, so this asserts the absence of one --
  // the Actions deploy job that used to live here never had credentials and
  // failed on every run.
  it('never publishes, and needs no credentials to run', () => {
    const publishSteps = workflow
      .split('\n')
      .filter((line) => line.includes('wrangler deploy') && !line.includes('--dry-run'));
    expect(publishSteps).toEqual([]);

    expect(workflow).toContain('- run: npx wrangler deploy --dry-run');

    expect(workflow).not.toContain('secrets.');
    expect(countOccurrences(workflow, 'CLOUDFLARE_API_TOKEN')).toBe(0);
    expect(countOccurrences(workflow, 'CLOUDFLARE_ACCOUNT_ID')).toBe(0);
  });

  it('runs the smoke check on main only, never on pull requests', () => {
    expect(smokeJob).toContain(
      "    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
    );
    expect(smokeJob).not.toContain('${{ secrets');
  });

  it('checks both uncached JSON health responses with bounded retries', () => {
    expect(smokeJob).toContain("readonly expected_body='{\"status\":\"ok\"}'");
    expect(smokeJob).toContain(
      "readonly expected_content_type='application/json; charset=utf-8'",
    );
    expect(smokeJob).toContain("readonly expected_cache_control='no-store'");
    expect(smokeJob).toContain("'https://openlattice3d.com/health'");
    expect(smokeJob).toContain("'https://lattice.esau.app/health'");
    expect(smokeJob).toContain('for ((attempt = 1; attempt <= max_attempts; attempt++))');
    expect(smokeJob).toContain('sleep "${retry_delay_seconds}"');
    expect(smokeJob).toContain('--connect-timeout 5 --max-time 10');
    expect(smokeJob).toContain("--header 'Cache-Control: no-cache'");
    expect(smokeJob).toContain('return 1');
    expect(smokeJob).toContain('if ! check_endpoint "${endpoint}"');
    expect(smokeJob).toContain('exit "${smoke_failed}"');
  });

  it('waits long enough to outlast an asynchronous Workers Builds publish', () => {
    // Actions is not notified when Workers Builds finishes, so the retry window
    // is the only thing absorbing that lag. #44's original 5x5s assumed the
    // deploy had just completed in the same job.
    const attempts = Number(/readonly max_attempts=(\d+)/.exec(smokeJob)?.[1]);
    const delay = Number(/readonly retry_delay_seconds=(\d+)/.exec(smokeJob)?.[1]);
    expect(attempts).toBeGreaterThan(0);
    expect(delay).toBeGreaterThan(0);
    expect(attempts * delay).toBeGreaterThanOrEqual(240);
  });
});
