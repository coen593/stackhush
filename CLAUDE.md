# stackhush

Owner-only status dashboard and alert emails for one person's projects: uptime, CI, deploys, PR
review requests, Supabase health and Worker errors, with one email only when something changes.
React + Vite + Tailwind SPA, one Cloudflare Worker (static assets, `/api/*`, cron every 5
minutes), D1 behind the binding `DB`. Open source (MIT): nothing in this repo may name a real
installation. No emojis; never `eslint-disable`, `@ts-ignore` or `@ts-expect-error`.

## Configuration

- `stackhush.config.ts` (git-ignored; `scripts/check-config.ts` copies
  `stackhush.config.example.ts` when it is missing) is the only installation-specific code:
  dashboard URL, alert addresses, GitHub owners, Cloudflare accounts, groups, projects, and the
  subrequest budget. `worker/config.ts` has its types, `defineConfig` (validates and throws one
  error listing every problem) and the names derived from it: source keys (`uptime`,
  `github:<key>`, `supabase`, `cloudflare:<key>`), labels, and the secret of a GitHub owner
  (`GITHUB_TOKEN_<KEY>`).
- It is checked before `dev`, `build`, `lint` and `test` (npm `pre*` scripts) and when the Worker
  starts (`worker/index.ts` imports it). Only `worker/index.ts` and `scripts/` import the
  installed config; everything else takes a `Config` argument, and tests use `TEST_CONFIG` from
  `worker/testing/fixtures.ts` through `createWorker` (`worker/app.ts`), so they pass with any
  installed config. Tests never read installation files (`wrangler.jsonc`, `.gitignore`, the
  installed config), so `npm test` passes in a private fork; the deploy-guard tests use
  `worker/testing/wrangler.template.jsonc`. `scripts/check-templates.ts` (upstream CI only)
  keeps that copy equal to the shipped `wrangler.jsonc` and checks the placeholders and the
  `.gitignore` line.
- Private: never import the config or `worker/` from `src/` (eslint enforces it), because
  everything `src/` imports ships in the public bundle. Group names and whatever else the UI
  needs come from `GET /api/status`.
- Secrets are optional (`worker/secrets.ts`). A source without its token is "not configured": not
  called, `source_health.last_error = 'not configured'` with zero failures, never an alert. Its
  stored checks are kept untouched (never pruned, a Worker deployed without its secrets must not
  wipe state) and `worker/status.ts` leaves them out of groups and problems until the token is
  back.
- `wrangler.jsonc` is a template with placeholders (account id, D1 id, custom domain, email
  destination). `npm run deploy` refuses the templates, leftover `example.com` values, an
  `alertTo` that is not the email binding's destination and a `dashboardUrl` whose host no route
  serves (`worker/deployGuard.ts`, run by `scripts/check-config.ts --deploy`).
- There are two migrations, 0001 and 0002. A third (`0003_spread.sql`, table `scheduled_units`)
  existed only in unpublished commits and was never applied to a live database; a local
  `.wrangler` state that has it is harmless.
- Stored keys are a compatibility surface: `check_states (project_id, check_key)`,
  `source_health.source`, `notified_review_requests.repo` and the secret names. Existing
  installations depend on them; do not change how they are built. Migrations are additive only.

## Layout

- `worker/index.ts` Worker entry: exports only the default handler (workerd treats any named
  export there as an entrypoint and refuses to start; `worker/entry.test.ts` checks this).
  `worker/app.ts` builds the handlers for a config.
- `worker/api.ts` the router. `sessionFreeRoutes` is the complete list of routes that work
  without a session (the three sign-in POSTs; `worker/access.test.ts` pins the list). Every route
  in `protectedRoutes` sits behind the one session check, and the same test file checks each of
  them without a session. Add new routes to `protectedRoutes`.
- `worker/access.ts`, `worker/tokens.ts` sign-in codes and sessions (stored as SHA-256 only).
- `worker/emailSignin.ts` sign-in by email: the request, its caps, checking the typed code, and
  the cron cleanup. `worker/signinEmail.ts` composes the email. `shared/signinCode.ts` holds the
  short code's alphabet and how typed input is tidied up, for both sides.
- `worker/run.ts` the cron run (`runChecks`); only `scheduled` calls it, no HTTP route.
  `worker/sources/` has one module per source (uptime, github, supabase, cloudflare), each
  returning a `SourceResult`; `worker/transitions.ts` is the pure core `(previous state,
observations) -> (new state, transitions)`; `worker/store.ts` does the D1 reads and writes;
  `worker/alerts.ts` composes and sends the one batched email through the `ALERT_EMAIL` binding.
  `worker/testing/fixtures.ts` holds the test config and synthetic API responses.
- `worker/budget.ts` shares what the budget leaves among uptime redirects (see "The subrequest
  budget" below).
- `worker/status.ts` builds `GET /api/status`: groups, problems, events and one row per source
  (working, failing, not configured).
- `worker/responses.ts` builds every API response with the security headers; `public/_headers`
  sets the same headers on static assets (`worker/headers.test.ts` keeps them in sync).
- `shared/api.ts` types for `GET /api/status`, used by both sides. Nothing private may live in
  `shared/`: it ships in the public bundle.
- `migrations/` D1 schema. Tests run the real handler on these migrations via Node's SQLite
  (`worker/testing/fakeD1.ts`, `worker/testing/env.ts`).
- State between runs lives in `check_states`. Each row's `detail_json` names the source that
  reported it and holds what that source needs back next run (failing workflows, workflows found
  deleted or switched off (`gone`), failing deploy environments, the last Worker threshold
  reading). Unchanged rows are not rewritten; rows a source no longer reports are deleted, but
  only in a run where that source was called and worked.
- Every POST to `/api/*` must be `Content-Type: application/json` and, when the browser says,
  same-origin (`isOwnPagePost` in `worker/api.ts`); anything else is 403 before the session check.
- `npm run seed:local` fills the local D1 with synthetic state for whatever config is installed;
  `docs/setup.md` is the one-time setup; `docs/configuration.md` documents every config field.

## The subrequest budget

Every run makes every check; nothing takes turns across runs (that was built and taken out
before v0.1: it kept producing edge cases; it may come back later). `plannedSubrequests`
(`worker/config.ts`) adds up a run: 1 per uptime URL, 1 per repo, 6 per GitHub token with repos,
1 Supabase, 2 per Cloudflare account in use. D1 and the email binding are not subrequests of
this limit. `defineConfig` refuses a config that needs more than `subrequestBudget` (default 45),
so it fails at build, at Worker start and in `npm run deploy`.

A run never makes more subrequests than the budget. Uptime checks follow redirects by hand
(`redirect: 'manual'`, at most 5) and pay for them from what the budget has left after the plan
(`allowRedirects` in `worker/budget.ts`): first the chains of URLs whose last check completed
(`redirects` in the row's `detail_json`), then URLs whose last check ran short, then new ones
from the shared spare. A URL that ran short never takes a subrequest from a completed chain,
and keeps its `short` mark through a check that could not reach it (only a chain followed to
the end clears it).
A redirect with no subrequest left is not followed: the observation is `unknown` (state kept)
and carries `learned` (`redirects`, and `short`: how many subrequests it lacked), the one kind
of memory that is stored even with an unknown status. `worker/status.ts` turns `short` into the
problem "Over the subrequest budget: <url> needs at least N more" until a check completes. Tests:
`worker/budget.test.ts`, `worker/sources/uptimeRedirects.test.ts`.

## Sign-in

Two ways in; both end in an `__Host-session` cookie (HttpOnly, Secure, SameSite=Lax, 180 days).

**By email (the normal way).** The signed-out page has one button. `POST /api/signin/request`
makes a row in `signin_requests`, sets an `__Host-signin-request` cookie (HttpOnly, Secure,
SameSite=Strict, 15 minutes) holding a random request id, and emails two codes through the
`ALERT_EMAIL` binding, which can only reach the owner's address (the sign-in link in it is built
from the config's `dashboardUrl`, never from the request's Host):

- an 8-character code (`XXXX-XXXX`, 31-character alphabet) typed on the same screen and sent to
  `POST /api/signin/verify`. It only works with the request cookie, so only in the browser that
  asked; 5 wrong codes close the request. Stored as SHA-256 of request id + code.
- a link `/signin#code=<256-bit code>`, a normal `signin_codes` row used through
  `POST /api/signin`.

Using either one voids the other. Emails are capped at 5 an hour and 20 a day in total
(`signin_email_sends`); at the cap, and when sending fails, the page only says "Try again
later". The constants and the brute-force arithmetic (about 1 in 23 million per year at these
caps) are at the top of `worker/emailSignin.ts`; change them together. The page never shows the
email address, and the subject never holds a code.

**From the terminal (the fallback).** `npm run signin-link` (or `:local`) stores a hashed
one-time code (15 minutes) and prints `/signin#code=<code>`. The code is in the fragment, so it
never reaches the server in a URL, logs or a Referer header, and link previewers cannot use it
up. The page takes it out of the address bar and POSTs it to `/api/signin`.

The remote script refuses to run when `stackhush.config.ts` is missing or still the example
(`installedConfigProblem` in `worker/deployGuard.ts`, the same check as the deploy guard), and it
has no pre-hook that would copy the example into place; only `signin-link:local` has one.

Agents never run the remote script, and never print a live code, request id or session id.
To sign out everywhere: `npx wrangler d1 execute DB --remote --command "DELETE FROM sessions"`.

## Commands

```bash
npm run dev                 # http://localhost:5173
npm run db:migrate:local    # create the local database
npm run signin-link:local   # local sign-in link
npm run lint && npm run build && npm test
```

`npm run deploy` (the owner runs it, never an agent) first refuses the template files
(`scripts/check-config.ts --deploy`), applies pending remote migrations, then
`scripts/deploy-check.ts` stops it unless the database has recorded every file in `migrations/`
(read-only, through `wrangler d1 execute`), so the Worker never runs ahead of its schema. In a
terminal wrangler asks before migrating, and answering no stops the deploy; without a terminal (CI,
a pipe) it applies them without asking. Never call `wrangler deploy` on its own after adding a
migration: the Worker would run ahead of its schema.
