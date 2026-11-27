// Example configuration with made-up projects. Copy it to stackhush.config.ts and edit that
// file: it is the only place that holds anything specific to your installation, and it is
// git-ignored so it does not end up in a public fork. (`npm run dev`, `build`, `lint` and `test`
// make the copy for you when the file is missing.)
//
// Tokens are not written here. Each one is a Worker secret (`wrangler secret put <NAME>`):
//   GITHUB_TOKEN_<KEY>   one per entry in `github`, the key in upper case with _ for -
//                        (below: GITHUB_TOKEN_PERSONAL and GITHUB_TOKEN_ACME_INC)
//   SUPABASE_TOKEN       for every `supabaseRef`
//   CF_TOKEN             one token for every account in `cloudflare`
// A source without its secret is shown as "not configured" and is not checked.

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
