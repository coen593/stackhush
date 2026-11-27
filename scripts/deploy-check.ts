// Stops a deploy while database migrations are still pending. `wrangler d1 migrations apply`
// exits 0 when its "continue?" question is answered with no, so its exit code proves nothing.
// This reads which migrations the database has recorded and fails unless every .sql file in
// migrations/ is among them. Anything unexpected (wrangler failing, output that cannot be read)
// also fails: not deploying is the safe way to be wrong.
//
//   node scripts/deploy-check.ts --remote     (what `npm run deploy` runs; read-only)
//   node scripts/deploy-check.ts --local
//
// Further arguments are passed on to `wrangler d1 execute`. It uses `d1 execute` because
// wrangler 4.152's `d1 migrations list --remote` ignores the account pinned in wrangler.jsonc.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// The D1 binding in wrangler.jsonc; wrangler accepts it in place of the database name.
const DATABASE_BINDING = 'DB';
const WRANGLER_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIRECTORY = join(import.meta.dirname, '..', 'migrations');
// The table wrangler keeps its record in. It does not exist before the first migration.
const APPLIED_QUERY = 'SELECT name FROM d1_migrations';
const NO_TABLE_ERROR = 'no such table: d1_migrations';

function stop(reason: string): never {
  console.error(`Not deploying: ${reason}`);
  process.exit(1);
}

/** wrangler may print a banner first; the JSON starts at the first line opening with [ or {. */
function parseJson(output: string): unknown {
  const start = output.search(/^[[{]/m);
  if (start === -1) return undefined;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return undefined;
  }
}

/** The names in a successful answer: [{ results: [{ name }, ...], success: true }]. */
function readNames(answer: unknown): string[] | null {
  if (!Array.isArray(answer) || answer.length !== 1) return null;
  const first: unknown = answer[0];
  if (typeof first !== 'object' || first === null) return null;
  if (!('success' in first) || first.success !== true) return null;
  if (!('results' in first) || !Array.isArray(first.results)) return null;
  const names: string[] = [];
  for (const row of first.results as unknown[]) {
    if (typeof row !== 'object' || row === null || !('name' in row)) return null;
    if (typeof row.name !== 'string') return null;
    names.push(row.name);
  }
  return names;
}

function readAppliedMigrations(): string[] {
  const wrangler = spawnSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      DATABASE_BINDING,
      ...process.argv.slice(2),
      '--json',
      '--command',
      APPLIED_QUERY,
    ],
    { encoding: 'utf8', timeout: WRANGLER_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (wrangler.error) stop(`could not run wrangler (${wrangler.error.message}).`);
  if (wrangler.status !== 0) {
    // A database no migration has touched yet: nothing is applied.
    if (wrangler.stdout.includes(NO_TABLE_ERROR)) return [];
    console.error(wrangler.stdout);
    stop('wrangler could not read the applied migrations.');
  }
  const names = readNames(parseJson(wrangler.stdout));
  if (names === null) {
    console.error(wrangler.stdout);
    stop('the list of applied migrations could not be read from wrangler.');
  }
  return names;
}

const files = readdirSync(MIGRATIONS_DIRECTORY)
  .filter((file) => file.endsWith('.sql'))
  .sort();
if (files.length === 0) stop(`no migrations found in ${MIGRATIONS_DIRECTORY}.`);

const applied = new Set(readAppliedMigrations());
const pending = files.filter((file) => !applied.has(file));
if (pending.length > 0) {
  stop(`migrations are still pending (${pending.join(', ')}). Run npm run db:migrate first.`);
}
console.log(`Migrations are up to date (${files.length} applied).`);
