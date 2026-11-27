// A Worker env for tests: the fake D1 plus dummy values for every secret TEST_CONFIG names. The
// dummy secrets are not real tokens; tests must never reach a real API with them.

import { createWorker } from '../app.ts';
import { TEST_CONFIG } from './fixtures.ts';

/** The Worker's handlers on TEST_CONFIG, so tests do not depend on the installed config. */
export const testWorker = createWorker(TEST_CONFIG);

export function createTestEnv(db: D1Database): Env {
  const env = {
    DB: db,
    ALERT_EMAIL: { send: () => Promise.resolve({ messageId: 'test' }) },
    GITHUB_TOKEN_PERSONAL: 'test-github-personal',
    GITHUB_TOKEN_WORK: 'test-github-work',
    SUPABASE_TOKEN: 'test-supabase',
    CF_TOKEN: 'test-cloudflare',
  };
  return env;
}
