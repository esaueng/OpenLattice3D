import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/cloudflare.yml', import.meta.url),
  'utf8',
);
const deployJobMarker = '\n  deploy:\n';
const deployJobIndex = workflow.indexOf(deployJobMarker);

if (deployJobIndex === -1) {
  throw new Error('Cloudflare workflow does not define a deploy job');
}

const deployJob = workflow.slice(deployJobIndex);
const deployStepMarker = '      - run: npx wrangler deploy\n';
const smokeStepMarker = '      - name: Smoke test deployed health endpoints\n';
const deployStepIndex = deployJob.indexOf(deployStepMarker);
const smokeStepIndex = deployJob.indexOf(smokeStepMarker);

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe('Cloudflare deployment workflow', () => {
  it('keeps deployment main-only and secrets scoped to Wrangler', () => {
    expect(deployJob).toContain(
      "    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
    );
    expect(deployStepIndex).toBeGreaterThan(-1);
    expect(smokeStepIndex).toBeGreaterThan(deployStepIndex);

    const beforeDeploy = deployJob.slice(0, deployStepIndex);
    const deployStep = deployJob.slice(deployStepIndex, smokeStepIndex);
    const smokeStep = deployJob.slice(smokeStepIndex);

    expect(beforeDeploy).not.toContain('secrets.');
    expect(deployStep).toContain(
      'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    );
    expect(deployStep).toContain(
      'CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
    );
    expect(smokeStep).not.toContain('secrets.');
    expect(smokeStep).not.toContain('${{');
    expect(countOccurrences(workflow, 'secrets.CLOUDFLARE_API_TOKEN')).toBe(1);
    expect(countOccurrences(workflow, 'secrets.CLOUDFLARE_ACCOUNT_ID')).toBe(1);
  });

  it('checks both uncached JSON health responses with bounded retries', () => {
    const smokeStep = deployJob.slice(smokeStepIndex);

    expect(smokeStep).toContain("readonly expected_body='{\"status\":\"ok\"}'");
    expect(smokeStep).toContain(
      "readonly expected_content_type='application/json; charset=utf-8'",
    );
    expect(smokeStep).toContain("readonly expected_cache_control='no-store'");
    expect(smokeStep).toContain("'https://openlattice3d.com/health'");
    expect(smokeStep).toContain("'https://lattice.esau.app/health'");
    expect(smokeStep).toContain('readonly max_attempts=5');
    expect(smokeStep).toContain('for ((attempt = 1; attempt <= max_attempts; attempt++))');
    expect(smokeStep).toContain('sleep "${retry_delay_seconds}"');
    expect(smokeStep).toContain('--connect-timeout 5 --max-time 10');
    expect(smokeStep).toContain("--header 'Cache-Control: no-cache'");
    expect(smokeStep).toContain('return 1');
    expect(smokeStep).toContain('if ! check_endpoint "${endpoint}"');
    expect(smokeStep).toContain('exit "${smoke_failed}"');
  });
});
