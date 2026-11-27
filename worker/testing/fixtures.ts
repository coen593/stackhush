// Synthetic API responses in the shapes the real APIs return. No real repo names, PR titles or
// ids: every name here is made up.

import { defineConfig, type Config, type Project } from '../config.ts';

/** Seven sources: uptime, two GitHub owners, Supabase and three Cloudflare accounts. */
export const TEST_CONFIG: Config = defineConfig({
  dashboardUrl: 'https://status.example.test',
  alertTo: 'owner@example.test',
  alertFrom: 'stackhush@alerts.example.test',
  github: [
    { key: 'personal', owner: 'acme', logins: ['octo-me', 'octo-me-at-work'] },
    { key: 'work', owner: 'acme-org', logins: ['octo-me', 'octo-me-at-work'] },
  ],
  cloudflare: [
    { key: 'main', accountId: '11111111111111111111111111111111' },
    { key: 'client', accountId: '22222222222222222222222222222222' },
    { key: 'spare', accountId: '33333333333333333333333333333333' },
  ],
  groups: ['Side projects', 'Work'],
  projects: [
    {
      id: 'demo',
      name: 'Demo App',
      group: 'Side projects',
      github: { owner: 'personal', repo: 'demo-app', watchDeployments: true },
      productionUrls: ['https://demo.example.test', 'https://admin.demo.example.test'],
      supabaseRef: 'abcdefghijklmnopqrst',
      cloudflare: { account: 'main', scripts: ['demo-worker', 'demo-quiet'] },
    },
    {
      id: 'other',
      name: 'Other Site',
      group: 'Work',
      github: { owner: 'work', repo: 'other-site' },
      productionUrls: ['https://other.example.test'],
    },
  ],
});

export const [DEMO_PROJECT, OTHER_PROJECT] = TEST_CONFIG.projects as [Project, Project];
export const TEST_PROJECTS: readonly Project[] = TEST_CONFIG.projects;
export const [PERSONAL_OWNER, WORK_OWNER] = TEST_CONFIG.githubOwners as [
  Config['githubOwners'][number],
  Config['githubOwners'][number],
];
export const [MAIN_ACCOUNT, CLIENT_ACCOUNT, SPARE_ACCOUNT] = TEST_CONFIG.cloudflareAccounts as [
  Config['cloudflareAccounts'][number],
  Config['cloudflareAccounts'][number],
  Config['cloudflareAccounts'][number],
];

/** TEST_CONFIG with other projects, already in the Worker's shape. */
export function configWith(projects: readonly Project[]): Config {
  return { ...TEST_CONFIG, projects };
}

export function githubGraphqlBody(): unknown {
  return {
    data: {
      repo0: {
        deployments: {
          nodes: [
            {
              environment: 'Preview',
              createdAt: '2026-11-26T10:05:00Z',
              latestStatus: { state: 'FAILURE', logUrl: 'https://deploy.example.test/preview' },
            },
            {
              environment: 'Production',
              createdAt: '2026-11-26T09:00:00Z',
              latestStatus: { state: 'SUCCESS', logUrl: 'https://deploy.example.test/prod-2' },
            },
            {
              environment: 'Production',
              createdAt: '2026-11-25T09:00:00Z',
              latestStatus: { state: 'FAILURE', logUrl: 'https://deploy.example.test/prod-1' },
            },
          ],
        },
        pullRequests: {
          nodes: [
            {
              number: 12,
              title: 'Add the thing',
              url: 'https://github.test/acme/demo-app/pull/12',
              reviewRequests: {
                nodes: [
                  { requestedReviewer: { __typename: 'User', login: 'octo-me' } },
                  { requestedReviewer: { __typename: 'Team' } },
                ],
              },
            },
            {
              number: 13,
              title: 'Fix the other thing',
              url: 'https://github.test/acme/demo-app/pull/13',
              reviewRequests: {
                nodes: [{ requestedReviewer: { __typename: 'User', login: 'someone-else' } }],
              },
            },
          ],
        },
      },
    },
  };
}

export interface FixtureRun {
  /** Defaults to the run's position in the list, starting at 1. */
  id?: number;
  workflow: number;
  name: string;
  status: string;
  conclusion: string | null;
  at: string;
}

export function workflowRunsBody(runs: FixtureRun[]): unknown {
  return {
    total_count: runs.length,
    workflow_runs: runs.map((run, index) => ({
      id: run.id ?? index + 1,
      workflow_id: run.workflow,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      html_url: `https://github.test/acme/demo-app/actions/runs/${run.id ?? index + 1}`,
      created_at: run.at,
    })),
  };
}

export function supabaseBody(): unknown {
  return [
    {
      id: 'abcdefghijklmnopqrst',
      ref: 'abcdefghijklmnopqrst',
      name: 'demo-prod',
      status: 'INACTIVE',
    },
    {
      id: 'zzzzzzzzzzzzzzzzzzzz',
      ref: 'zzzzzzzzzzzzzzzzzzzz',
      name: 'stray-project',
      status: 'ACTIVE_HEALTHY',
    },
  ];
}

export function analyticsBody(
  rows: { script: string; status: string; requests: number }[],
): unknown {
  return {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: rows.map((row) => ({
              dimensions: { scriptName: row.script, status: row.status },
              sum: { requests: row.requests },
            })),
          },
        ],
      },
    },
    errors: null,
  };
}

export function scriptListBody(): unknown {
  return {
    success: true,
    result: [
      { id: 'demo-worker', modified_on: '2026-11-20T08:00:00.000000Z' },
      { id: 'demo-quiet', modified_on: '2026-10-01T08:00:00.000000Z' },
      { id: 'unrelated-script', modified_on: '2026-01-01T00:00:00.000000Z' },
    ],
  };
}
