// Checks the template files this repo ships, for upstream CI only. A private fork fills in
// wrangler.jsonc and stops ignoring stackhush.config.ts, so this check fails there by design;
// the unit tests never read these files, so `npm test` passes in a fork.
//
//   node scripts/check-templates.ts
//
// - wrangler.jsonc equals worker/testing/wrangler.template.jsonc byte for byte, so the copy the
//   deploy-guard tests use never drifts from what a fresh clone gets;
// - wrangler.jsonc still has its placeholders;
// - .gitignore still ignores stackhush.config.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const WRANGLER_FILE = 'wrangler.jsonc';
const FIXTURE_FILE = 'worker/testing/wrangler.template.jsonc';

const PLACEHOLDERS: readonly string[] = [
  '"account_id": "00000000000000000000000000000000"',
  '"database_id": "00000000-0000-0000-0000-000000000000"',
  '"pattern": "status.example.com"',
  '"destination_address": "you@example.com"',
];

const wrangler = readFileSync(join(ROOT, WRANGLER_FILE), 'utf8');
const fixture = readFileSync(join(ROOT, FIXTURE_FILE), 'utf8');
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');

const problems: string[] = [];
if (wrangler !== fixture) {
  problems.push(`${WRANGLER_FILE} differs from ${FIXTURE_FILE}; change both together.`);
}
for (const placeholder of PLACEHOLDERS) {
  if (!wrangler.includes(placeholder)) {
    problems.push(`${WRANGLER_FILE} no longer has the placeholder ${placeholder}.`);
  }
}
if (!/^stackhush\.config\.ts$/m.test(gitignore)) {
  problems.push('.gitignore no longer ignores stackhush.config.ts.');
}

if (problems.length > 0) {
  console.error(
    `The shipped templates are not templates any more (fine in a private fork, not upstream):\n${problems
      .map((line) => `- ${line}`)
      .join('\n')}`,
  );
  process.exit(1);
}
console.log('Templates OK.');
