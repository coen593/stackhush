# Configuration

Everything specific to your installation is in one typed file, `stackhush.config.ts` at the repo
root. Copy `stackhush.config.example.ts` to start (`npm run dev`, `build`, `lint` and `test` make the
copy for you when the file is missing). The file is git-ignored so a public fork does not publish
your projects; in a private fork, delete the `stackhush.config.ts` line from `.gitignore` and commit
it.

The config is checked in three places: before `dev`, `build`, `lint` and `test`
(`scripts/check-config.ts`), when the Worker starts, and by `npm run deploy`. A bad config stops
with one error listing every problem, including fields that are missing or of the wrong kind.

`npm run deploy` checks more, because a mismatch between the two files only shows once it is
live. It refuses to deploy when:

- `stackhush.config.ts` is still the example, or `dashboardUrl`, `alertTo`, `alertFrom` or a
  production URL is still on `example.com`;
- `wrangler.jsonc` still has the all-zero account or database id, or an `example.com` route;
- `alertTo` is not the `destination_address` of the `ALERT_EMAIL` binding in `wrangler.jsonc` (the
  binding can send nowhere else, so no alert or sign-in email would arrive);
- `wrangler.jsonc` has routes and none of them serves the host of `dashboardUrl` (emails would
  link to the wrong place). Custom domains, zone routes (`status.example.org/*`), routes written
  as plain strings, the singular `route` key and `*` wildcards are all understood; only the host
  part of a pattern is compared. Without routes, on the workers.dev address, this is not checked.

The config never reaches the browser: the dashboard reads group names and everything else from `/api/status` after signing
in.

Tokens are not part of the config. They are Worker secrets, see [setup.md](setup.md).

## The example

This is `stackhush.config.example.ts`, all made-up values:

```ts
import { defineConfig } from './worker/config.ts';

export default defineConfig({
  // Where the dashboard is served. Alert emails and sign-in links point here.
  dashboardUrl: 'https://status.example.com',
  // Who gets the emails. The same address as `destination_address` in wrangler.jsonc.
  alertTo: 'you@example.com',
  // The sender, on a domain onboarded for Cloudflare Email Sending.
  alertFrom: 'stackhush@alerts.example.com',

  // Subrequests a run may make. Every run makes every check, so a config that needs more is
  // refused. The default of 45 fits the Workers Free limit of 50; on Workers Paid raise it.
  // subrequestBudget: 45,

  github: [
    // `logins` are your own accounts: a review requested from one of them is "your review".
    { key: 'personal', owner: 'octo-jane', logins: ['octo-jane'] },
    { key: 'acme-inc', owner: 'acme-inc', logins: ['octo-jane', 'jane-at-acme'] },
  ],

  cloudflare: [{ key: 'main', accountId: '0123456789abcdef0123456789abcdef' }],

  // The order the dashboard shows the groups in.
  groups: ['Side projects', 'Acme Inc'],

  projects: [
    {
      id: 'recipe-box',
      name: 'Recipe Box',
      group: 'Side projects',
      github: { owner: 'personal', repo: 'recipe-box', watchDeployments: true },
      productionUrls: ['https://recipes.example.com'],
      supabaseRef: 'abcdefghijklmnopqrst',
    },
    {
      id: 'link-shortener',
      name: 'Link shortener',
      group: 'Side projects',
      github: { owner: 'personal', repo: 'link-shortener' },
      productionUrls: ['https://go.example.com'],
      cloudflare: { account: 'main', scripts: ['link-shortener'] },
    },
    {
      id: 'acme-shop',
      name: 'Acme shop',
      group: 'Acme Inc',
      github: { owner: 'acme-inc', repo: 'shop', defaultBranch: 'trunk' },
      productionUrls: ['https://shop.example.com', 'https://admin.shop.example.com'],
      supabaseRef: 'tsrqponmlkjihgfedcba',
      cloudflare: { account: 'main', scripts: ['shop-api', 'shop-emails'] },
    },
    {
      // A mobile app: no site, only the repo's CI and pull requests.
      id: 'acme-app',
      name: 'Acme mobile app',
      group: 'Acme Inc',
      github: { owner: 'acme-inc', repo: 'mobile-app' },
    },
  ],
});
```

## Top-level fields

| Field              | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboardUrl`     | yes      | Where the dashboard is served. `https` and the origin only, no path. Alert emails and sign-in links point here. It is never taken from a request's Host header.                                                                                                                                                                                                                                                                                                                                                                 |
| `alertTo`          | yes      | Who gets alert and sign-in emails. Must be the same address as `destination_address` in `wrangler.jsonc`, and a verified destination on the Cloudflare account.                                                                                                                                                                                                                                                                                                                                                                 |
| `alertFrom`        | yes      | The sender, on a domain onboarded for Cloudflare Email Sending (a subdomain such as `alerts.example.com` is a good choice).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `subrequestBudget` | no       | Subrequests a cron run may make. Default 45; the Workers Free limit is 50. Every run makes every check: one per uptime URL, one per repo, six per GitHub token with repos, one for Supabase, two per Cloudflare account in use. A config that needs more than the budget is refused with the number it needs; remove checks or, on Workers Paid, raise this. What is left pays for redirects of uptime checks. A whole number above 0. See [setup.md](setup.md#bigger-setups-the-subrequest-budget) and [limits.md](limits.md). |
| `github`           | no       | GitHub owners, see below. Up to 20, one entry per owner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cloudflare`       | no       | Cloudflare accounts, see below. Up to 20.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `groups`           | yes      | Group names in the order the dashboard shows them. No empty or duplicate names.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `projects`         | yes      | The projects to watch, see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## `github`: one entry per owner

| Field    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key`    | Short name: lower-case letters and digits, optionally in several parts joined by a single `-` or `_` (`acme`, `acme-inc`, `team_2`). It starts and ends with a letter or digit, and separators are never doubled. Used in projects, in the source key `github:<key>` and in the secret name `GITHUB_TOKEN_<KEY>` (upper case, `_` for `-`: `acme-inc` gives `GITHUB_TOKEN_ACME_INC`). Two keys that give the same secret name are refused. |
| `owner`  | The login of the user or organisation that owns the repos, as in `github.com/<owner>`. Each owner has one entry (one token reads one owner); a second entry for the same login is refused.                                                                                                                                                                                                                                                 |
| `logins` | Your own accounts. A review requested from one of them counts as "your review".                                                                                                                                                                                                                                                                                                                                                            |

An owner without its token set is "not configured": listed as such on the dashboard, never counted
as failing, never alerting. Its repos' checks are kept as they were and hidden until the token is
set (see [limits.md](limits.md)).

## `cloudflare`: one entry per account

| Field       | Meaning                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `key`       | Short name, same rules as GitHub keys. Used in projects and in the source key `cloudflare:<key>`. |
| `accountId` | The 32-character hex account id.                                                                  |

All accounts are read with the one `CF_TOKEN` secret. Without it, Cloudflare is "not configured".

## `projects`

| Field                     | Required          | Meaning                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | yes               | Stable id, stored with every check. No spaces or `\|`, not `unassigned`. Changing it starts the project's history afresh. Unique.                                                                                                                                                                                      |
| `name`                    | yes               | Shown on the dashboard and in emails.                                                                                                                                                                                                                                                                                  |
| `group`                   | yes               | One of `groups`.                                                                                                                                                                                                                                                                                                       |
| `github.owner`            | with `github`     | The `key` of an entry in `github` (not the login).                                                                                                                                                                                                                                                                     |
| `github.repo`             | with `github`     | The repo name only, without the owner.                                                                                                                                                                                                                                                                                 |
| `github.defaultBranch`    | no                | The branch whose CI is watched. `main` when left out. It is written here because reading it from the API would need the Contents permission.                                                                                                                                                                           |
| `github.watchDeployments` | no                | Whether GitHub Deployments say something useful about production (they do when a host such as Vercel reports deploys to GitHub). `false` when left out.                                                                                                                                                                |
| `productionUrls`          | no                | Sites checked for uptime: a GET that follows up to 5 redirects; the answer at the end decides. Down after two failed checks in a row. `http` or `https`. Each redirect is a subrequest of the run; one the budget has no room for is not followed and shows as a problem on the dashboard, see [limits.md](limits.md). |
| `supabaseRef`             | no                | The 20-character Supabase project ref. Unique across projects. Projects the Supabase token sees that no entry names appear under "Unassigned".                                                                                                                                                                         |
| `cloudflare.account`      | with `cloudflare` | The `key` of an entry in `cloudflare`.                                                                                                                                                                                                                                                                                 |
| `cloudflare.scripts`      | with `cloudflare` | Worker script names on that account, watched for error rate.                                                                                                                                                                                                                                                           |

A project may have any mix of these parts. A project with only `github` shows CI and pull
requests; one with only `productionUrls` shows uptime.

## Stored keys

Check ids stored in the database (`project_id` plus check key), the source names
(`uptime`, `github:<key>`, `supabase`, `cloudflare:<key>`) and the secret names are built from the
`id` and `key` values above. Renaming one in a live installation orphans its history and re-records
the check silently, so choose them once.
