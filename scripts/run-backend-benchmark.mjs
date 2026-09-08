#!/usr/bin/env node
// Runs the warm-run backend benchmark (env-gated out of the default suite).
import { spawnSync } from 'node:child_process';

const vitest = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(vitest, ['vitest', 'run', 'src/backend/benchmark.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, RUN_BACKEND_BENCH: '1' },
});
process.exit(result.status ?? 1);
