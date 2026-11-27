// Creates a one-time sign-in code in D1 and prints the link that uses it. The code works once,
// for 15 minutes. Only its SHA-256 is stored; the code itself exists only in this output.
//
//   node scripts/signin-link.ts --local --url http://localhost:5173
//   node scripts/signin-link.ts --remote
//
// Without --url the link points at the dashboardUrl of stackhush.config.ts.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Config } from '../worker/config.ts';
import { installedConfigProblem } from '../worker/deployGuard.ts';
import { generateToken, hashToken, SIGNIN_CODE_LIFETIME_MS } from '../worker/tokens.ts';

// The D1 binding in wrangler.jsonc; wrangler accepts it in place of the database name.
const DATABASE_BINDING = 'DB';
const WRANGLER_TIMEOUT_MS = 120_000;
const ROOT = join(import.meta.dirname, '..');
const CONFIG_FILE = join(ROOT, 'stackhush.config.ts');
const EXAMPLE_FILE = join(ROOT, 'stackhush.config.example.ts');

const { values } = parseArgs({
  options: {
    local: { type: 'boolean', default: false },
    remote: { type: 'boolean', default: false },
    url: { type: 'string' },
  },
});

if (values.local === values.remote) {
  throw new Error('Pass exactly one of --local or --remote.');
}
const target = values.local ? '--local' : '--remote';

// A remote link is for a real installation. It is refused before anything else happens when
// the config is missing or still the example: nothing is copied into place for it (unlike the
// local scripts), and no code is written to a database the example's addresses do not belong to.
if (values.remote) {
  const problem = installedConfigProblem(
    existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null,
    readFileSync(EXAMPLE_FILE, 'utf8'),
  );
  if (problem !== null) {
    console.error(`No sign-in link made: ${problem}`);
    process.exit(1);
  }
}
// Imported only now: a missing config must give the message above, not a failed import.
const { default: config } = (await import(CONFIG_FILE)) as { default: Config };

const code = generateToken();
const codeHash = await hashToken(code);
const now = new Date();
const expiresAt = new Date(now.getTime() + SIGNIN_CODE_LIFETIME_MS).toISOString();

// wrangler d1 execute takes no bound parameters. Both values are generated here (hex and an ISO
// timestamp), so they contain no quotes. The command line carries only the hash, never the code.
const sql = `INSERT INTO signin_codes (code_hash, expires_at) VALUES ('${codeHash}', '${expiresAt}');`;
execFileSync('npx', ['wrangler', 'd1', 'execute', DATABASE_BINDING, target, '--command', sql], {
  encoding: 'utf8',
  timeout: WRANGLER_TIMEOUT_MS,
  stdio: ['ignore', 'ignore', 'inherit'],
});

// The code goes in the fragment: browsers never send it to the server, so it stays out of
// request logs and Referer headers, and link previewers that fetch the URL cannot use it up.
const link = new URL('/signin', values.url ?? config.dashboardUrl);
link.hash = `code=${code}`;
console.log(`Sign-in link (works once, until ${expiresAt}):`);
console.log(link.href);
