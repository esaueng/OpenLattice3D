#!/usr/bin/env node
// Rejects mutable action references in workflow files. Every `uses:` must be
// pinned to a full commit SHA with the reviewed release version kept beside
// it as a comment (Dependabot updates both). Local actions (uses: ./...) are
// exempt.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowsDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const USES_PATTERN = /^\s*-?\s*uses:\s*([^\s#]+?)\s*(?:#\s*(.+))?$/;
const PINNED_REF_PATTERN = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const VERSION_COMMENT_PATTERN = /^v\d+\.\d+\.\d+\b/;

const failures = [];
let checked = 0;

for (const file of readdirSync(workflowsDir).sort()) {
  if (!/\.ya?ml$/.test(file)) continue;
  const lines = readFileSync(join(workflowsDir, file), 'utf8').split('\n');
  lines.forEach((line, index) => {
    const match = USES_PATTERN.exec(line);
    if (!match) return;
    const [, ref, comment] = match;
    if (ref.startsWith('./')) return;
    checked++;
    const location = `${file}:${index + 1}`;
    if (!PINNED_REF_PATTERN.test(ref)) {
      failures.push(`${location}: "${ref}" is not pinned to a full 40-character commit SHA`);
      return;
    }
    if (!comment || !VERSION_COMMENT_PATTERN.test(comment)) {
      failures.push(`${location}: "${ref}" needs its release version beside the SHA, e.g. "# v4.2.2"`);
    }
  });
}

if (failures.length > 0) {
  console.error('Workflow action pin check failed:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`Workflow action pin check passed (${checked} pinned actions).`);
