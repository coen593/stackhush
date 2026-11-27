# Changelog

## 0.3.0 (unreleased)

- More branches per repo: `github.extraBranches` in a project (for example `['staging']`) watches
  CI on those branches by the rules of the default branch. Each has its own row on the dashboard
  ("CI (staging)") and its own alerts ("CI on staging went red", "is green again"). The default
  branch's check is unchanged, and so is everything stored for it.
- Checks on open pull requests: with `github.pullRequestChecks: true` each open PR shows whether
  the Actions runs on its head commit are passing, failing or running, and such PRs are listed
  as rows. Dashboard only: no email, no push, no problem, no event.
- Either or both cost one more subrequest per run for that repo (its 50 most recent runs on any
  branch). `defineConfig` counts it, so a config that no longer fits its `subrequestBudget` is
  refused at build. A config that uses neither makes the same requests and stores the same rows
  as 0.2.0.
- `GET /api/status` gains `branchCi` on a project (only when it has extra branches) and `checks`
  on a pull request (only when known).
- No migration. See [docs/configuration.md](docs/configuration.md#extra-branches-and-pull-request-checks)
  and [docs/limits.md](docs/limits.md) for what a busy repo can push out of the 50 runs, and for
  the CPU time each such repo adds on Workers Free.

## 0.2.0

- Push notifications, server side: a run that sends an alert email also sends one Web Push
  message per subscribed device, with the email's subject, the number of current problems and
  the dashboard's address. Optional: it needs the secrets `VAPID_PUBLIC_KEY` and
  `VAPID_PRIVATE_KEY`, which `npm run push-keys` makes and stores without showing the private
  key. Without them nothing changes. See [docs/setup.md](docs/setup.md#9-push-notifications-optional).
- New routes behind the session check: `POST /api/push/subscribe`, `/api/push/unsubscribe` and
  `/api/push/test` (5 an hour). `GET /api/status` gains `push.vapidPublicKey`, `push.devices` and
  `push.keys` (`absent`, `invalid` or `ready`; a mismatched key pair is caught and sends nothing).
- A device gets notifications only while its browser is signed in: a subscription is deleted
  with the session that made it.
- Each push is one subrequest, paid last from what a run has left of its budget after the
  checks and their redirects. Devices that do not fit get no notification and show as a problem
  on the dashboard; the email is always sent. Push is best effort and the email stays the
  record, see [docs/limits.md](docs/limits.md).
- The dashboard is now a PWA: a service worker (`public/sw.js`) caches the app shell and the last
  `/api/status` (nothing else), so the page opens offline with a note saying how old the copy is;
  a copy older than 7 days is refused and deleted. It shows push notifications, sets the app
  icon badge to the number of problems and focuses or opens the dashboard when one is tapped.
- A Notifications section at the bottom of the page: turn on (the permission is asked on that
  tap), send a test, turn off. On iPhone and iPad it asks for the Home Screen app first. A device
  whose subscription uses an older key subscribes again by itself. Signing out first removes
  this device's subscription and clears the caches and the badge.
- PNG icons (`apple-touch-icon.png`, 192, 512 and a maskable 512) made from `public/icon.svg` by
  `npm run icons`; the manifest lists them.
- New migration `0003_push.sql` (additive). `npm run deploy` applies it before deploying.

## 0.1.0

First release.

- Dashboard for uptime, GitHub CI, deploys and pull requests, Supabase health and Cloudflare
  Worker errors, with one batched email when something changes.
- One typed config file, `stackhush.config.ts`, for dashboard URL, alert addresses, GitHub owners,
  Cloudflare accounts, groups and projects. Checked at build and at startup.
- Optional sources: a source without its token is shown as "not configured" and never alerts.
- Every check runs every five minutes. A run never makes more subrequests than
  `subrequestBudget` (default 45, for the Workers Free limit of 50), and a config that needs more
  is refused with the number it needs. Bigger setups need Workers Paid and a higher budget;
  spreading checks across runs is not in this release and may come later.
- Owner-only access with sign-in by email code or link, and a terminal fallback.
- Runs on one Cloudflare Worker with static assets, a cron trigger and a D1 database. MIT licence.
