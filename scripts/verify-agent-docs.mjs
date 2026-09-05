#!/usr/bin/env node
// Verifies the repository agent docs: CLAUDE.md must be a relative symlink to
// AGENTS.md, and every npm command documented in AGENTS.md must exist in
// package.json scripts. Runs in CI so the docs cannot drift from reality.
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const failures = [];

const agentsPath = `${root}/AGENTS.md`;
const claudePath = `${root}/CLAUDE.md`;

let agents;
try {
  agents = readFileSync(agentsPath, 'utf8');
} catch {
  failures.push('AGENTS.md is missing');
}

const claudeStat = lstatSync(claudePath, { throwIfNoEntry: false });
if (!claudeStat) {
  failures.push('CLAUDE.md is missing');
} else if (!claudeStat.isSymbolicLink()) {
  failures.push('CLAUDE.md must be a symlink to AGENTS.md, not a separate file');
} else {
  const target = readlinkSync(claudePath);
  if (target !== 'AGENTS.md') {
    failures.push(`CLAUDE.md must be a relative symlink to AGENTS.md, got "${target}"`);
  }
}

if (agents) {
  const documented = new Set();
  for (const match of agents.matchAll(/\bnpm run ([a-z][\w:-]*)/g)) documented.add(match[1]);
  if (/\bnpm test\b/.test(agents)) documented.add('test');

  const scripts = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).scripts ?? {};
  for (const command of documented) {
    if (!(command in scripts)) {
      failures.push(`AGENTS.md documents "npm run ${command}" but package.json has no "${command}" script`);
    }
  }
  console.log(`Checked ${documented.size} documented npm commands against package.json.`);
}

if (failures.length > 0) {
  console.error('Agent docs verification failed:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('Agent docs verification passed.');
