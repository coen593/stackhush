import { beforeEach, describe, expect, it } from 'vitest';
import { runChecks } from './run.ts';
import {
  analyticsBody,
  githubGraphqlBody,
  scriptListBody,
  supabaseBody,
  TEST_CONFIG,
  workflowRunsBody,
} from './testing/fixtures.ts';
import type { Fetcher } from './sources/http.ts';
import type { Secrets } from './secrets.ts';
import { loadStatus } from './status.ts';
import { createTestEnv } from './testing/env.ts';
import { createTestDatabase } from './testing/fakeD1.ts';

const ALL_SECRETS: Secrets = {
  github: new Map([
    ['personal', 't'],
    ['work', 't'],
  ]),
  supabase: 't',
  cloudflare: 't',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const fetcher: Fetcher = (url) => {
  if (url.endsWith('/graphql') && url.includes('github'))
    return Promise.resolve(json(githubGraphqlBody()));
  if (url.includes('/actions/workflows/')) return Promise.resolve(json({ state: 'active' }));
  if (url.includes('/actions/runs')) {
    return Promise.resolve(
      json(
        workflowRunsBody([
          {
            workflow: 1,
            name: 'CI',
            status: 'completed',
            conclusion: 'failure',
            at: '2026-11-26T10:00:00Z',
          },
        ]),
      ),
    );
  }
  if (url.includes('supabase')) return Promise.resolve(json(supabaseBody()));
  if (url.endsWith('/graphql')) return Promise.resolve(json(analyticsBody([])));
  if (url.includes('cloudflare')) return Promise.resolve(json(scriptListBody()));
  return Promise.resolve(new Response('', { status: url.includes('admin.demo') ? 500 : 200 }));
};

describe('loadStatus', () => {
  let db: D1Database;

  beforeEach(() => {
    db = createTestDatabase().db;
  });

  it('is empty before the first run', async () => {
    const status = await loadStatus(db, TEST_CONFIG, ALL_SECRETS);
    expect(status).toMatchObject({ checkedAt: null, problems: [], groups: [], events: [] });
  });

  it('shows rows that apply, problems, unassigned Supabase projects and the check time', async () => {
    const env = {
      ...createTestEnv(db),
      ALERT_EMAIL: { send: () => Promise.resolve({ messageId: 'x' }) },
    } as Env;
    await runChecks(env, new Date('2026-11-26T12:00:00.000Z'), TEST_CONFIG, fetcher);
    await runChecks(env, new Date('2026-11-26T12:05:00.000Z'), TEST_CONFIG, fetcher);
    const status = await loadStatus(db, TEST_CONFIG, ALL_SECRETS);

    expect(status.checkedAt).toBe('2026-11-26T12:05:00.000Z');
    expect(status.unassigned.map((view) => view.label)).toEqual(['stray-project']);
    const demo = status.groups
      .flatMap((group) => group.projects)
      .find((project) => project.id === 'demo');
    expect(demo?.sites.map((site) => [site.label, site.status])).toEqual([
      ['demo.example.test', 'ok'],
      ['admin.demo.example.test', 'problem'],
    ]);
    expect(demo?.ci?.status).toBe('problem');
    expect(demo?.supabase?.summary).toBe('INACTIVE (paused)');
    expect(demo?.pullRequests?.map((pr) => [pr.number, pr.isReviewRequestedFromMe])).toEqual([
      [12, true],
      [13, false],
    ]);
    expect(demo?.workers.map((worker) => worker.label)).toEqual(['demo-worker', 'demo-quiet']);
    expect(status.problems.map((problem) => problem.title)).toEqual(
      expect.arrayContaining([
        'Demo App: CI - Failing: CI',
        'Demo App: Supabase - INACTIVE (paused)',
      ]),
    );
  });
});
