// Makes the push keys (a VAPID key pair, RFC 8292) and stores them as the Worker's secrets
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY. The pair exists only in this process's memory: both
// keys go to one `wrangler secret bulk` call through its standard input, so the private key is
// never printed, never written to a file and never on a command line.
//
//   node scripts/push-keys.ts             set both secrets on the deployed Worker
//   node scripts/push-keys.ts --dry-run   make a pair, show the public key, store nothing
//
// Running it again replaces the pair. Subscriptions made with the old pair stop working; a
// device subscribes again by itself the next time its dashboard is open (see docs/setup.md).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { installedConfigProblem } from '../worker/deployGuard.ts';
import { generateVapidKeys, isVapidKeyPair } from '../worker/webPush.ts';

const WRANGLER_TIMEOUT_MS = 120_000;
const ROOT = join(import.meta.dirname, '..');
const CONFIG_FILE = join(ROOT, 'stackhush.config.ts');
const EXAMPLE_FILE = join(ROOT, 'stackhush.config.example.ts');

const { values } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
});

const keys = await generateVapidKeys();
if (!isVapidKeyPair(keys)) throw new Error('The generated keys are not a VAPID pair');

if (values['dry-run']) {
  console.log('Dry run: this pair is thrown away and no secret is set.');
  console.log(`Public key: ${keys.publicKey}`);
  process.exit(0);
}

// Secrets are for a real installation. Refused before anything is sent when the config is
// missing or still the example, the same check as `npm run signin-link` and the deploy.
const problem = installedConfigProblem(
  existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null,
  readFileSync(EXAMPLE_FILE, 'utf8'),
);
if (problem !== null) {
  console.error(`No push keys made: ${problem}`);
  process.exit(1);
}

// Both secrets in one request (`wrangler secret bulk` reads JSON from standard input), so the
// Worker never has the public key of one pair next to the private key of another. Wrangler's
// own output goes to the terminal; it names the secrets, never their values.
const result = spawnSync('npx', ['wrangler', 'secret', 'bulk'], {
  cwd: ROOT,
  input: JSON.stringify({
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
  }),
  stdio: ['pipe', 'inherit', 'inherit'],
  timeout: WRANGLER_TIMEOUT_MS,
});
if (result.status !== 0) {
  console.error(
    'The push keys were not set. If wrangler reported that only one of the two was stored, ' +
      'the dashboard shows "Push keys are not valid" until you run npm run push-keys again.',
  );
  process.exit(1);
}
console.log('Push keys set. Turn notifications on in the dashboard on each device.');
