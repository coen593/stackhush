# Contributing

stackhush is small on purpose: one owner, read-only keys, email alerts. Before a larger change,
open an issue to check that it fits. See [CLAUDE.md](CLAUDE.md) for how the code is laid out.

## Dev loop

You need Node 24.

```bash
npm ci
npm run db:migrate:local    # local D1
npm run seed:local          # synthetic state, no tokens needed
npm run dev                 # http://localhost:5173
npm run signin-link:local   # open the printed link to sign in
```

`npm run dev` always uses port 5173 and refuses to pick another, so the local sign-in link
(which points at `localhost:5173`) always matches. If another server holds only 127.0.0.1:5173,
open `http://localhost:5173`. To use another port, pass it to both:
`npm run dev -- --port 5174` and `node scripts/signin-link.ts --local --url http://localhost:5174`.

Without tokens, the local dashboard lists the GitHub, Supabase and Cloudflare sources as "not
configured" and hides their checks, so a project with only a repo has no card. Recent changes
still lists the seeded events for them. `npm run screenshots` shows the configured view: it starts
the dev server with placeholder tokens, which are never sent anywhere.

`stackhush.config.ts` is git-ignored and copied from the example when missing, so a fresh clone
works. Local development needs no tokens and no network.

## Checks

Run all three before opening a pull request; CI runs them too, plus a smoke run of the built
Worker.

```bash
npm run lint      # ESLint, zero warnings
npm run build     # tsc -b and vite build
npm test          # vitest
```

Tests run the real request handler on the real migrations through Node's SQLite
(`worker/testing/`), with the test config `TEST_CONFIG`, so they pass whatever config is installed.
Unit tests never read installation files (`wrangler.jsonc`, `.gitignore`, `stackhush.config.ts`),
so they pass in a private fork too; the deploy-guard tests use the copy
`worker/testing/wrangler.template.jsonc`. `npm run check-templates` checks that the shipped
`wrangler.jsonc` equals that copy and still has its placeholders, and that `.gitignore` still
ignores the config; it runs in CI on the upstream repository only, since a fork fills them in.
Test the unhappy path (a source that fails, a missing token, a rejected request) as well as the
happy one.

To try the built Worker as workerd runs it:

```bash
npm run db:migrate:local && npm run build
npx vite preview --port 4173 --strictPort &
for _ in $(seq 1 60); do curl -sf http://localhost:4173/ > /dev/null && break; sleep 1; done
curl "http://localhost:4173/cdn-cgi/handler/scheduled"
npx wrangler d1 execute DB --local --command "SELECT source, last_error FROM source_health"
```

With no tokens, every token source reads "not configured" and `uptime` has no `last_error`. The
example config's uptime URLs do not exist, so their checks (in `check_states`) say `unreachable`;
that is expected.

CI goes one step further (`.github/ci/smoke.sh`): it rebuilds with a CI-only config whose one
uptime URL is `https://example.com`, triggers a run and fails unless that check stored a `200`
summary, so a Worker that cannot make outgoing requests fails the job. The script overwrites
`stackhush.config.ts` and refuses to run unless `CI=true`; try it in a scratch clone.

## Adding a source

A source is one module in `worker/sources/` that reads one external API and returns a
`SourceResult` (`worker/observations.ts`): a `source` key, a `label`, an `error` (null when it
worked) and a list of observations. Use `worker/sources/supabase.ts` as the smallest example.

1. Write `worker/sources/<name>.ts`: take a `Fetcher` (`worker/sources/http.ts`, which sets the
   timeout), the token and the config's projects; return observations. A failing check is an
   observation with `status: 'problem'`; an unreadable API is `error`, not a throw.
2. Name it in `worker/config.ts` (source key and label, as `SUPABASE_SOURCE` does) and add any
   config field it needs, with its checks in `defineConfig`.
3. Read its secret in `worker/secrets.ts`. It must be optional: no secret means "not configured".
4. Call it from `collectSources` in `worker/run.ts`, and count its subrequests in
   `plannedSubrequests` (`worker/config.ts`): a run must never make more than the budget.
5. Add synthetic responses to `worker/testing/fixtures.ts` and tests: working, failing, token
   missing, and the first-run-silent and recovery transitions.
6. Document the token and its exact read-only permissions in `docs/setup.md`, the config fields in
   `docs/configuration.md`, and add a line to `CHANGELOG.md`.

Only read-only APIs and tokens are accepted.

## Rules that must hold

These are enforced by lint and tests where possible; keep them when you change code.

- No emojis anywhere. Never `eslint-disable`, `@ts-ignore` or `@ts-expect-error`; fix the code.
  Strict TypeScript, no `any`.
- Nothing private in the public bundle. `src/` and `shared/` ship to every visitor: never import
  the config or `worker/` from `src/`. Anything the UI needs comes from `GET /api/status`.
- Auth. Routes that work without a session are only the sign-in POSTs (`sessionFreeRoutes` in
  `worker/api.ts`, pinned by `worker/access.test.ts`). Add new routes to `protectedRoutes`. Every
  POST must be JSON and same-origin. Sessions and codes are stored as SHA-256 only.
- Read-only keys. No new token with write permission, and no secret in a file or on a command line.
- Stored keys are a compatibility surface: `check_states (project_id, check_key)`,
  `source_health.source`, `notified_review_requests.repo` and secret names. Existing installations
  depend on them. Migrations are additive only.
- Push is best effort and comes last: it never delays or fails the email, the run or a state
  write, and a failed push never becomes an event or an alert. Tests never send to a real push
  service.
- Every run makes every check and never more subrequests than `subrequestBudget`. A stored
  check is only removed in a run in which its source was called and worked.
- A source without its token is "not configured": not called, never failing, never alerting.
- No real installation's names, domains or ids in code, tests, fixtures or docs. Use `example.com`
  and made-up names.
- Pin dependencies to exact versions and keep new ones to a minimum.
- Format with Prettier (`npm run format`).

## Pull requests

Keep them small and focused, fill in the template, and say how you checked the change. Do not run
`npm run deploy` or any `--remote` command as part of a contribution.
