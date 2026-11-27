// Makes sure there is a valid stackhush.config.ts before anything is built, linted, tested or
// served. A fresh clone has none (the file is git-ignored), so the example is copied in its
// place, and said so. Importing the file runs defineConfig, which throws listing every problem.
//
//   node scripts/check-config.ts              (what the pre* npm scripts run)
//   node scripts/check-config.ts --deploy     (also refuses the templates and a config that
//                                              does not match wrangler.jsonc)

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../worker/config.ts';
import { deployProblems, installedConfigProblem } from '../worker/deployGuard.ts';

const ROOT = join(import.meta.dirname, '..');
const CONFIG_FILE = join(ROOT, 'stackhush.config.ts');
const EXAMPLE_FILE = join(ROOT, 'stackhush.config.example.ts');
const WRANGLER_FILE = join(ROOT, 'wrangler.jsonc');

function stop(reason: string): never {
  console.error(reason);
  process.exit(1);
}

if (!existsSync(CONFIG_FILE)) {
  copyFileSync(EXAMPLE_FILE, CONFIG_FILE);
  console.warn(
    'No stackhush.config.ts found: copied stackhush.config.example.ts. Edit it before deploying.',
  );
}

let installed: { default: Config };
try {
  installed = (await import(CONFIG_FILE)) as { default: Config };
} catch (error) {
  stop(error instanceof Error ? error.message : 'stackhush.config.ts could not be loaded.');
}

if (process.argv.includes('--deploy')) {
  const problem = installedConfigProblem(
    readFileSync(CONFIG_FILE, 'utf8'),
    readFileSync(EXAMPLE_FILE, 'utf8'),
  );
  if (problem !== null) stop(`Not deploying: ${problem}`);
  const problems = deployProblems(installed.default, readFileSync(WRANGLER_FILE, 'utf8'));
  if (problems.length > 0) {
    stop(`Not deploying:\n${problems.map((line) => `- ${line}`).join('\n')}`);
  }
}
