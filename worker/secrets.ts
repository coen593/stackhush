// The tokens the Worker reads, set with `wrangler secret put` (see docs/setup.md). Every one is
// optional: a source without its token is "not configured" and is simply not checked.

import { githubTokenSecretName, type Config } from './config.ts';

export interface Secrets {
  /** GitHub owner key -> token, for the owners that have one. */
  github: ReadonlyMap<string, string>;
  supabase: string | null;
  cloudflare: string | null;
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
  return { github, supabase: read('SUPABASE_TOKEN'), cloudflare: read('CF_TOKEN') };
}
