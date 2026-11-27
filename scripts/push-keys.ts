// Makes the push keys (a VAPID key pair, RFC 8292) and stores them as the Worker's secrets
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY. The pair exists only in this process's memory: each
// key goes to `wrangler secret put` through its standard input, so the private key is never
// printed, never written to a file and never on a command line.
//
//   node scripts/push-keys.ts             set both secrets on the deployed Worker
//   node scripts/push-keys.ts --dry-run   make a pair, show the public key, store nothing
//
// Running it again replaces the pair. Subscriptions made with the old pair stop working:
// every device has to turn notifications off and on again (see docs/setup.md).

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

/** Hands the value to wrangler on standard input. Wrangler's own output goes to the terminal. */
function putSecret(name: string, value: string): boolean {
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    cwd: ROOT,
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: WRANGLER_TIMEOUT_MS,
  });
  return result.status === 0;
}

if (!putSecret('VAPID_PUBLIC_KEY', keys.publicKey)) {
  console.error('VAPID_PUBLIC_KEY was not set; nothing changed. Run npm run push-keys again.');
  process.exit(1);
}
if (!putSecret('VAPID_PRIVATE_KEY', keys.privateKey)) {
  // The two secrets now belong to different pairs, which the dashboard cannot tell apart.
  console.error(
    'VAPID_PRIVATE_KEY was not set, but VAPID_PUBLIC_KEY was: the two no longer belong together ' +
      'and no notification can be sent. Run npm run push-keys again until both are set.',
  );
  process.exit(1);
}
console.log('Push keys set. Turn notifications on in the dashboard on each device.');
