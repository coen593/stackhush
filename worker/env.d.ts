// Secrets the Worker reads, set with `wrangler secret put` (see docs/setup.md). They are declared here
// rather than under "secrets" in wrangler.jsonc, which makes every local build warn that they
// are missing: local dev and tests never use real tokens. Each is optional: without it the
// source is "not configured". The GitHub tokens are not listed because their names come from
// the config (GITHUB_TOKEN_<KEY>); worker/secrets.ts reads them. The two VAPID keys are the push
// keys, set by `npm run push-keys`; without them push notifications are not set up.
interface Env {
  SUPABASE_TOKEN?: string;
  CF_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}
