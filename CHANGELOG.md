# Changelog

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
