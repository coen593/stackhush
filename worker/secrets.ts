// The tokens the Worker reads, set with `wrangler secret put` (see docs/setup.md). Every one is
// optional: a source without its token is "not configured" and is simply not checked.

import { githubTokenSecretName, type Config } from './config.ts';
import { isMatchingVapidPair, isVapidKeyPair, type VapidKeys } from './webPush.ts';

/**
 * The push keys (VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, made by `npm run push-keys`). Without
 * them push is simply not set up. `invalid` is one of the two missing, values that are not
 * keys, or two keys that do not belong together: the dashboard says so, and nothing is sent.
 * readSecrets only looks at the shape; confirmVapid checks that the two are a pair.
 */
export type VapidSecrets =
  { kind: 'absent' } | { kind: 'invalid' } | { kind: 'ready'; keys: VapidKeys };

export interface Secrets {
  /** GitHub owner key -> token, for the owners that have one. */
  github: ReadonlyMap<string, string>;
  supabase: string | null;
  cloudflare: string | null;
  vapid: VapidSecrets;
}

/** Reads the secrets a config needs from the Worker's env. Missing and empty both mean absent. */
export function readSecrets(env: Env, config: Config): Secrets {
  // GitHub secret names come from the config, so they are not properties TypeScript knows.
  const values: Record<string, unknown> = { ...env };
  const read = (name: string): string | null => {
    const value = values[name];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const github = new Map<string, string>();
  for (const owner of config.githubOwners) {
    const token = read(githubTokenSecretName(owner.key));
    if (token !== null) github.set(owner.key, token);
  }
  return {
    github,
    supabase: read('SUPABASE_TOKEN'),
    cloudflare: read('CF_TOKEN'),
    vapid: readVapid(read('VAPID_PUBLIC_KEY'), read('VAPID_PRIVATE_KEY')),
  };
}

function readVapid(publicKey: string | null, privateKey: string | null): VapidSecrets {
  if (publicKey === null && privateKey === null) return { kind: 'absent' };
  if (publicKey === null || privateKey === null) return { kind: 'invalid' };
  const keys = { publicKey, privateKey };
  return isVapidKeyPair(keys) ? { kind: 'ready', keys } : { kind: 'invalid' };
}

// The pair is checked once per isolate (two signature operations), not on every request.
let checkedPair: { keys: VapidKeys; isPair: Promise<boolean> } | null = null;

/**
 * The same secrets, with push keys that are not a pair marked `invalid`. Everything that acts on
 * the push keys (the routes, the run, the status) reads them through this.
 */
export async function confirmVapid(secrets: Secrets): Promise<Secrets> {
  if (secrets.vapid.kind !== 'ready') return secrets;
  const { keys } = secrets.vapid;
  if (
    checkedPair?.keys.publicKey !== keys.publicKey ||
    checkedPair.keys.privateKey !== keys.privateKey
  ) {
    checkedPair = { keys, isPair: isMatchingVapidPair(keys) };
  }
  return (await checkedPair.isPair) ? secrets : { ...secrets, vapid: { kind: 'invalid' } };
}
