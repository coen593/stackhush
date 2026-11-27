// A config that uses none of the newer optional fields must behave exactly as it did before they
// existed: live installations depend on the stored keys and rows. This plays one scripted
// history through the cron run and compares, run by run, every request made, every row written
// or deleted, every email sent and the dashboard's answer with a recording.
//
// The recording (__snapshots__/continuity.test.ts.snap) was made with the code of v0.2.0, before
// extra branches and pull request checks existed. Never refresh it with `vitest -u` to make this
// test pass: a difference means an existing installation would store, send or remove something
// else after an update. Record it again only for a change of behaviour that is meant, and say so
// in the changelog.
//
// One thing is read differently on purpose since v0.3.0: runs of pull requests from forks no
// longer count for the default branch (worker/sources/sources.test.ts, worker/branches.test.ts).
// The runs in this history all name their own repo as GitHub's do, v0.2.0 did not look at that
// field, and the recording still holds: without fork runs nothing changed.

import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyticsBody,
  configWith,
  githubGraphqlBody,
  scriptListBody,
  supabaseBody,
  TEST_PROJECTS,
  workflowRunsBody,
  type FixtureRun,
} from './testing/fixtures.ts';
import type { Project } from './config.ts';
import type { Fetcher } from './sources/http.ts';
import type { Secrets } from './secrets.ts';
import { loadStatus } from './status.ts';
import { runChecks } from './run.ts';
import { createTestEnv } from './testing/env.ts';
import { createTestDatabase } from './testing/fakeD1.ts';

const START = new Date('2026-11-26T12:00:00.000Z').getTime();
const RUN_INTERVAL_MS = 5 * 60 * 1000;

const ALL_SECRETS: Secrets = {
  github: new Map([
    ['personal', 't'],
    ['work', 't'],
  ]),
  supabase: 't',
  cloudflare: 't',
  vapid: { kind: 'absent' },
};

/** What the outside world looks like during one run. */
interface World {
  /** The personal repo's runs on its default branch, newest first. */
  ciRuns: FixtureRun[];
  /** What a lookup of the personal repo's workflow answers. */
  workflowStatus: number;
  siteStatus: number;
  productionDeployState: string;
  /** Whether PR 13 asks for my review too. */
  secondReviewRequested: boolean;
  workGithubStatus: number;
  strayProjectExists: boolean;
  emailFails: boolean;
  projects: readonly Project[];
}

const CALM: World = {
  ciRuns: [ciRun('success', 1, '2026-11-26T10:00:00Z')],
  workflowStatus: 200,
  siteStatus: 200,
  productionDeployState: 'SUCCESS',
  secondReviewRequested: false,
  workGithubStatus: 200,
  strayProjectExists: true,
  emailFails: false,
  projects: TEST_PROJECTS,
};

function ciRun(conclusion: string, id: number, at: string): FixtureRun {
  return { id, workflow: 1, name: 'CI', status: 'completed', conclusion, at };
}

const FAILED_RUN = ciRun('failure', 2, '2026-11-26T12:02:00Z');

/** One world per run. Each step names what changed since the calm start. */
const HISTORY: readonly [string, World][] = [
  ['the first run records everything', CALM],
  ['nothing changed', CALM],
  ['CI fails', { ...CALM, ciRuns: [FAILED_RUN, ...CALM.ciRuns] }],
  ['CI still failing, the workflow is looked up', { ...CALM, ciRuns: [FAILED_RUN] }],
  ['the failed run scrolled out of the recent ones', { ...CALM, ciRuns: [] }],
  ['the failing workflow was deleted', { ...CALM, ciRuns: [], workflowStatus: 404 }],
  ['CI passes again', { ...CALM, ciRuns: [ciRun('success', 3, '2026-11-26T12:20:00Z')] }],
  ['a site fails once', { ...CALM, siteStatus: 502 }],
  [
    'the site fails twice, while the email service is down',
    { ...CALM, siteStatus: 502, emailFails: true },
  ],
  ['the site is back and the email goes out', CALM],
  ['a production deploy fails', { ...CALM, productionDeployState: 'FAILURE' }],
  [
    'the deploy is fixed and a second review is requested',
    { ...CALM, secondReviewRequested: true },
  ],
  ['the work token fails', { ...CALM, workGithubStatus: 500 }],
  ['the work token fails again', { ...CALM, workGithubStatus: 500 }],
  ['the work token fails a third time', { ...CALM, workGithubStatus: 500 }],
  [
    'a project left the config while its token fails',
    { ...CALM, workGithubStatus: 500, projects: TEST_PROJECTS.slice(0, 1) },
  ],
  ['the work token works again', { ...CALM, projects: TEST_PROJECTS.slice(0, 1) }],
  [
    'a Supabase project nobody names was deleted',
    { ...CALM, strayProjectExists: false, projects: TEST_PROJECTS.slice(0, 1) },
  ],
];

interface Request {
  method: string;
  url: string;
  body: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function personalGraphql(world: World, requestBody: string): unknown {
  const body = githubGraphqlBody() as {
    data: {
      repo0: {
        deployments: { nodes: { environment: string; latestStatus: { state: string } }[] };
        pullRequests: {
          nodes: { reviewRequests: { nodes: { requestedReviewer: Record<string, string> }[] } }[];
        };
        held0?: { nodes: unknown[] };
      };
    };
  };
  const { deployments, pullRequests } = body.data.repo0;
  const production = deployments.nodes.filter((node) => node.environment === 'Production');
  if (production[0]) production[0].latestStatus.state = world.productionDeployState;
  if (world.secondReviewRequested) {
    pullRequests.nodes[1]?.reviewRequests.nodes.push({
      requestedReviewer: { __typename: 'User', login: 'octo-me' },
    });
  }
  if (requestBody.includes('held0')) body.data.repo0.held0 = { nodes: production.slice(0, 1) };
  return body;
}

/**
 * The runs of a repo as GitHub lists them: each names the repo its branch lives in. All of them
 * are the repo's own here; runs of pull requests from forks are what v0.3.0 reads differently.
 */
function ownRunsBody(repo: string, runs: FixtureRun[]): unknown {
  const body = workflowRunsBody(runs) as { workflow_runs: Record<string, unknown>[] };
  return {
    ...body,
    workflow_runs: body.workflow_runs.map((run) => ({
      ...run,
      head_repository: { full_name: repo },
    })),
  };
}

function network(world: World, requests: Request[]): Fetcher {
  return (url, init) => {
    const body = typeof init?.body === 'string' ? init.body : null;
    requests.push({ method: init?.method ?? 'GET', url, body });
    const isWork = new Headers(init?.headers).get('Authorization')?.includes('work') ?? false;
    if (url === 'https://api.github.com/graphql') {
      if (isWork) {
        const empty = { deployments: { nodes: [] }, pullRequests: { nodes: [] } };
        return Promise.resolve(json({ data: { repo0: empty } }, world.workGithubStatus));
      }
      return Promise.resolve(json(personalGraphql(world, body ?? '')));
    }
    if (url.includes('/actions/workflows/')) {
      return Promise.resolve(json({ state: 'active' }, world.workflowStatus));
    }
    if (url.startsWith('https://api.github.com/repos/acme-org/')) {
      return Promise.resolve(
        json(
          ownRunsBody('acme-org/other-site', [ciRun('success', 9, '2026-11-26T09:30:00Z')]),
          world.workGithubStatus,
        ),
      );
    }
    if (url.startsWith('https://api.github.com/repos/')) {
      return Promise.resolve(json(ownRunsBody('acme/demo-app', world.ciRuns)));
    }
    if (url.startsWith('https://api.supabase.com/')) {
      const projects = supabaseBody() as unknown[];
      return Promise.resolve(json(world.strayProjectExists ? projects : projects.slice(0, 1)));
    }
    if (url.startsWith('https://api.cloudflare.com/') && url.endsWith('/graphql')) {
      return Promise.resolve(
        json(analyticsBody([{ script: 'demo-worker', status: 'success', requests: 40 }])),
      );
    }
    if (url.startsWith('https://api.cloudflare.com/'))
      return Promise.resolve(json(scriptListBody()));
    const status = url.startsWith('https://demo.example') ? world.siteStatus : 200;
    return Promise.resolve(new Response('', { status }));
  };
}

// Every table a run writes, each row under its key. The database's own timestamps are left
// out; an unsent alert is named by the event it belongs to.
const TABLES: Readonly<Record<string, string>> = {
  check_states: `SELECT project_id || '|' || check_key AS key, status, consecutive_failures,
      summary, link_url, detail_json, problem_since, observed_at FROM check_states`,
  events: `SELECT occurred_at || ' ' || check_key || ' ' || kind AS key, id, project_id, title,
      link_url FROM events`,
  unsent_alerts: `SELECT events.occurred_at || ' ' || events.check_key || ' ' || events.kind AS key,
      unsent_alerts.attempts FROM unsent_alerts JOIN events ON events.id = unsent_alerts.event_id`,
  source_health: `SELECT source AS key, consecutive_failures, last_error, last_attempt_at,
      last_success_at FROM source_health`,
  notified_review_requests: `SELECT repo || '#' || pr_number AS key FROM notified_review_requests`,
  run_state: `SELECT id AS key, last_run_started_at, last_run_finished_at FROM run_state`,
};

type Rows = Map<string, string>;

function readRows(sqlite: DatabaseSync): Rows {
  const rows: Rows = new Map();
  for (const [table, sql] of Object.entries(TABLES)) {
    for (const row of sqlite.prepare(sql).all() as Record<string, unknown>[]) {
      rows.set(`${table} ${String(row['key'])}`, JSON.stringify(row));
    }
  }
  return rows;
}

/** What a run did to the database: rows written (new or changed) and rows deleted. */
function changes(before: Rows, after: Rows): { written: string[]; deleted: string[] } {
  return {
    written: [...after]
      .filter(([key, row]) => before.get(key) !== row)
      .map(([, row]) => row)
      .sort(),
    deleted: [...before.keys()].filter((key) => !after.has(key)).sort(),
  };
}

describe('a config without the newer optional fields', () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let sent: unknown[];
  let emailFails: boolean;

  beforeEach(() => {
    // The two things a run takes from its surroundings, pinned so that a recording can be
    // compared: how long a site took to answer (part of the stored summary), and the random
    // ids of events (alerts of the same moment are listed in the order of their ids).
    vi.spyOn(Date, 'now').mockReturnValue(START);
    let nextId = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      nextId += 1;
      return `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`;
    });
    const database = createTestDatabase();
    sqlite = database.sqlite;
    sent = [];
    emailFails = false;
    env = {
      ...createTestEnv(database.db),
      ALERT_EMAIL: {
        send: (message: unknown) => {
          if (emailFails) {
            return Promise.reject(Object.assign(new Error('boom'), { code: 'E_DELIVERY_FAILED' }));
          }
          sent.push(message);
          return Promise.resolve({ messageId: 'id' });
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests, stores, sends and removes exactly what v0.2.0 did', async () => {
    const recording: unknown[] = [];
    for (const [index, [step, world]] of HISTORY.entries()) {
      const now = new Date(START + index * RUN_INTERVAL_MS);
      const config = configWith(world.projects);
      const requests: Request[] = [];
      const before = readRows(sqlite);
      const sentBefore = sent.length;
      emailFails = world.emailFails;
      await runChecks(env, now, config, network(world, requests));

      const status = await loadStatus(env.DB, config, ALL_SECRETS, now);
      recording.push({
        step,
        // The order of calls that run side by side is not part of the behaviour.
        requests: requests.map((request) => JSON.stringify(request)).sort(),
        ...changes(before, readRows(sqlite)),
        emails: sent.slice(sentBefore),
        status: JSON.stringify(status),
      });
    }
    expect(recording).toMatchSnapshot();
  });
});
