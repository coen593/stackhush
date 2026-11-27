# Changelog

## 0.2.0 (unreleased)

- Push notifications, server side: a run that sends an alert email also sends one Web Push
  message per subscribed device, with the email's subject, the number of current problems and
  the dashboard's address. Optional: it needs the secrets `VAPID_PUBLIC_KEY` and
  `VAPID_PRIVATE_KEY`, which `npm run push-keys` makes and stores without showing the private
  key. Without them nothing changes. See [docs/setup.md](docs/setup.md#9-push-notifications-optional).
- New routes behind the session check: `POST /api/push/subscribe`, `/api/push/unsubscribe` and
  `/api/push/test` (5 an hour). `GET /api/status` gains `push.vapidPublicKey`.
- Each push is one subrequest of the run's budget, set aside after the checks and their known
  redirects. Devices that do not fit get no notification and show as a problem on the
  dashboard; the email is always sent. Push is best effort and the email stays the record, see
  [docs/limits.md](docs/limits.md).
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
