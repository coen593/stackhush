// Extra branches (CI watched like the default branch, with rows and alerts of their own) and
// pull request checks (shown on the PR rows, never alerted on), through whole cron runs.

import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineConfig, plannedSubrequests, type Config, type StackhushConfig } from './config.ts';
import { runChecks } from './run.ts';
import type { Secrets } from './secrets.ts';
import { parseRecentRuns } from './sources/github.ts';
import type { Fetcher } from './sources/http.ts';
import { loadStatus } from './status.ts';
import { createTestEnv } from './testing/env.ts';
import { createTestDatabase } from './testing/fakeD1.ts';
import { recentRunsBody, type FixtureRecentRun, type FixtureRun } from './testing/fixtures.ts';

const START = new Date('2026-11-26T12:00:00.000Z').getTime();
const RUN_INTERVAL_MS = 5 * 60 * 1000;
const REPO = 'acme/shop';

const SECRETS: Secrets = {
  github: new Map([['personal', 't']]),
  supabase: null,
  cloudflare: null,
  vapid: { kind: 'absent' },
};

type RepoFields = NonNullable<StackhushConfig['projects'][number]['github']>;

/** One repo, 'acme/shop', with the given optional fields. */
function shopConfig(fields: Partial<RepoFields>): Config {
  return defineConfig({
    dashboardUrl: 'https://status.example.test',
    alertTo: 'owner@example.test',
    alertFrom: 'stackhush@alerts.example.test',
    github: [{ key: 'personal', owner: 'acme', logins: ['octo-me'] }],
    groups: ['Work'],
    projects: [
      {
        id: 'shop',
        name: 'Shop',
        group: 'Work',
        github: { owner: 'personal', repo: 'shop', ...fields },
      },
    ],
  });
}

const WITH_STAGING = shopConfig({ extraBranches: ['staging'] });
const WITH_PR_CHECKS = shopConfig({ pullRequestChecks: true });

interface FixturePullRequest {
  number: number;
  sha: string;
  isReviewRequested?: boolean;
}

/** What GitHub answers during one run. */
interface World {
  /** The default branch's own list. */
  mainRuns: FixtureRun[];
  /** The repo's recent runs on every branch, newest first. */
  recentRuns: FixtureRecentRun[];
  recentStatus: number;
  graphqlStatus: number;
  pullRequests: FixturePullRequest[];
  /** GitHub refuses the field that reads the PRs' head commits. */
  headsForbidden: boolean;
  /** Workflow ids that a lookup finds deleted. */
  deletedWorkflows: number[];
}

let sqlite: DatabaseSync;
let env: Env;
let world: World;
let sent: { subject: string }[];
let requests: string[];
let runIndex: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function finished(conclusion: string, id: number, at: string, workflow = 1): FixtureRun {
  return { id, workflow, name: `W${workflow}`, status: 'completed', conclusion, at };
}

function on(branch: string, run: FixtureRun, sha?: string): FixtureRecentRun {
  return { ...run, branch, ...(sha === undefined ? {} : { sha }) };
}

function graphqlBody(requestBody: string): unknown {
  const pullRequests = world.pullRequests.map((pr) => ({
    number: pr.number,
    title: `Change ${pr.number}`,
    url: `https://github.test/${REPO}/pull/${pr.number}`,
    reviewRequests: {
      nodes: pr.isReviewRequested
        ? [{ requestedReviewer: { __typename: 'User', login: 'octo-me' } }]
        : [],
    },
  }));
  const repo: Record<string, unknown> = {
    deployments: { nodes: [] },
    pullRequests: { nodes: pullRequests },
  };
  if (!requestBody.includes('heads0:')) return { data: { repo0: repo } };
  if (world.headsForbidden) {
    // GraphQL nulls the whole block an error is in; the repo's own block is another one.
    return {
      data: { repo0: repo, heads0: null },
      errors: [{ type: 'FORBIDDEN', path: ['heads0', 'pullRequests', 'nodes', 0, 'headRefOid'] }],
    };
  }
  const heads = world.pullRequests.map((pr) => ({ number: pr.number, headRefOid: pr.sha }));
  return { data: { repo0: repo, heads0: { pullRequests: { nodes: heads } } } };
}

const network: Fetcher = (url, init) => {
  requests.push(url);
  if (url.endsWith('/graphql')) {
    const body = typeof init?.body === 'string' ? init.body : '';
    return Promise.resolve(json(graphqlBody(body), world.graphqlStatus));
  }
  if (url.includes('/actions/workflows/')) {
    const id = Number(url.slice(url.lastIndexOf('/') + 1));
    return Promise.resolve(
      world.deletedWorkflows.includes(id) ? json({}, 404) : json({ state: 'active' }),
    );
  }
  if (url.includes('branch=main')) return Promise.resolve(json(mainBody()));
  return Promise.resolve(json(recentRunsBody(REPO, world.recentRuns), world.recentStatus));
};

function mainBody(): { workflow_runs: unknown[] } {
  return recentRunsBody(
    REPO,
    world.mainRuns.map((run) => on('main', run)),
  ) as { workflow_runs: unknown[] };
}

async function runOnce(config: Config): Promise<void> {
  const now = new Date(START + runIndex * RUN_INTERVAL_MS);
  runIndex += 1;
  requests = [];
  await runChecks(env, now, config, network);
}

interface StoredCheck {
  status: string;
  summary: string;
  detail: Record<string, unknown>;
}

function check(checkKey: string): StoredCheck | undefined {
  const row = sqlite
    .prepare('SELECT status, summary, detail_json FROM check_states WHERE check_key = ?')
    .get(checkKey) as { status: string; summary: string; detail_json: string } | undefined;
  if (!row) return undefined;
  return {
    status: row.status,
    summary: row.summary,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
  };
}

function events(): string[] {
  const rows = sqlite.prepare('SELECT check_key, kind, title FROM events ORDER BY rowid').all();
  return (rows as { check_key: string; kind: string; title: string }[]).map(
    (row) => `${row.check_key} ${row.kind}: ${row.title}`,
  );
}

function lookups(): string[] {
  return requests
    .filter((url) => url.includes('/actions/workflows/'))
    .map((url) => url.slice(url.lastIndexOf('/') + 1));
}

function sourceFailures(): number {
  const row = sqlite
    .prepare("SELECT consecutive_failures FROM source_health WHERE source = 'github:personal'")
    .get() as { consecutive_failures: number };
  return row.consecutive_failures;
}

const MAIN_OK = finished('success', 1, '2026-11-26T09:00:00Z');
const STAGING_OK = finished('success', 2, '2026-11-26T10:00:00Z');
const STAGING_FAILED = finished('failure', 3, '2026-11-26T12:02:00Z');
const STAGING_FIXED = finished('success', 4, '2026-11-26T12:30:00Z');
/** What a busy repo's list looks like once the branch's runs have left it. */
const ONLY_MAIN = [on('main', finished('success', 50, '2026-11-26T12:40:00Z'))];

beforeEach(() => {
  const database = createTestDatabase();
  sqlite = database.sqlite;
  sent = [];
  requests = [];
  runIndex = 0;
  world = {
    mainRuns: [MAIN_OK],
    recentRuns: [on('staging', STAGING_OK), on('main', MAIN_OK)],
    recentStatus: 200,
    graphqlStatus: 200,
    pullRequests: [],
    headsForbidden: false,
    deletedWorkflows: [],
  };
  env = {
    ...createTestEnv(database.db),
    SUPABASE_TOKEN: undefined,
    CF_TOKEN: undefined,
    ALERT_EMAIL: {
      send: (message: unknown) => {
        sent.push(message as { subject: string });
        return Promise.resolve({ messageId: 'id' });
      },
    },
  };
});

describe('CI on an extra branch', () => {
  it('has a check of its own, next to the default branch whose key stays "ci"', async () => {
    await runOnce(WITH_STAGING);
    expect(check('ci')).toMatchObject({ status: 'ok', detail: { label: 'CI' } });
    expect(check('ci:staging')).toMatchObject({
      status: 'ok',
      summary: 'Passing',
      detail: { label: 'CI (staging)', source: 'github:personal', failing: [] },
    });
    expect(requests.filter((url) => url.includes('/actions/runs'))).toEqual([
      `https://api.github.com/repos/${REPO}/actions/runs?branch=main&exclude_pull_requests=true&per_page=15`,
      `https://api.github.com/repos/${REPO}/actions/runs?exclude_pull_requests=true&per_page=50`,
    ]);
  });

  it('emails once when the branch goes red and once when it is green again, naming it', async () => {
    await runOnce(WITH_STAGING);
    world.recentRuns = [on('staging', STAGING_FAILED), ...world.recentRuns];
    await runOnce(WITH_STAGING);
    await runOnce(WITH_STAGING);
    expect(check('ci:staging')).toMatchObject({ status: 'problem', summary: 'Failing: W1' });
    expect(check('ci')?.status).toBe('ok');
    world.recentRuns = [on('staging', STAGING_FIXED), ...world.recentRuns];
    await runOnce(WITH_STAGING);
    expect(check('ci:staging')?.status).toBe('ok');
    expect(events()).toEqual([
      'ci:staging ci_red: Shop: CI on staging went red',
      'ci:staging ci_green: Shop: CI on staging is green again',
    ]);
    expect(sent.map((email) => email.subject)).toEqual([
      'Shop: CI on staging went red',
      'Shop: CI on staging is green again',
    ]);
  });

  it('judges each branch by its own runs: a red default branch leaves it green, and the other way round', async () => {
    await runOnce(WITH_STAGING);
    const mainFailed = finished('failure', 5, '2026-11-26T12:03:00Z');
    world.mainRuns = [mainFailed, MAIN_OK];
    world.recentRuns = [on('main', mainFailed), ...world.recentRuns];
    await runOnce(WITH_STAGING);
    expect(check('ci')?.status).toBe('problem');
    expect(check('ci:staging')?.status).toBe('ok');
    expect(events()).toEqual(['ci ci_red: Shop: CI on the default branch went red']);
  });

  it('keeps the default branch green when a pull request from a fork branch called main fails', async () => {
    await runOnce(WITH_STAGING);
    const forkFailed = { ...on('main', finished('failure', 5, '2026-11-26T12:03:00Z')) };
    const body = recentRunsBody(REPO, [{ ...forkFailed, headRepo: 'someone/shop' }]) as {
      workflow_runs: unknown[];
    };
    const [forkRun] = body.workflow_runs;
    // The branch filter returns it, since only the branch's name is compared.
    const withFork: Fetcher = (url, init) =>
      url.includes('branch=main')
        ? Promise.resolve(json({ workflow_runs: [forkRun, ...mainBody().workflow_runs] }))
        : network(url, init);
    await runChecks(env, new Date(START + RUN_INTERVAL_MS), WITH_STAGING, withFork);
    expect(check('ci')).toMatchObject({ status: 'ok', summary: 'Passing' });
    expect(events()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('ignores a pull request from a fork whose branch has the same name', async () => {
    await runOnce(WITH_STAGING);
    world.recentRuns = [
      { ...on('staging', STAGING_FAILED), headRepo: 'someone/shop' },
      ...world.recentRuns,
    ];
    await runOnce(WITH_STAGING);
    expect(check('ci:staging')?.status).toBe('ok');
    expect(events()).toEqual([]);
  });

  it('shows on the dashboard as a row labelled with the branch', async () => {
    await runOnce(WITH_STAGING);
    const status = await loadStatus(env.DB, WITH_STAGING, SECRETS, new Date(START));
    const [project] = status.groups.flatMap((group) => group.projects);
    expect(project?.ci?.label).toBe('CI');
    expect(project?.branchCi).toEqual([
      {
        label: 'CI (staging)',
        status: 'ok',
        summary: 'Passing',
        at: '2026-11-26T10:00:00Z',
        linkUrl: `https://github.test/acme/demo-app/actions/runs/2`,
      },
    ]);
  });
});

describe('a red extra branch whose runs scrolled out of the recent ones', () => {
  beforeEach(async () => {
    await runOnce(WITH_STAGING);
    world.recentRuns = [on('staging', STAGING_FAILED), ...world.recentRuns];
    await runOnce(WITH_STAGING);
    sent = [];
  });

  it('stays red, without a second alert and without being removed', async () => {
    world.recentRuns = ONLY_MAIN;
    await runOnce(WITH_STAGING);
    await runOnce(WITH_STAGING);
    expect(check('ci:staging')).toMatchObject({
      status: 'problem',
      summary: 'Failing: W1',
      detail: { failing: [{ workflowId: 1, runId: 3 }] },
    });
    expect(events()).toEqual(['ci:staging ci_red: Shop: CI on staging went red']);
    expect(sent).toEqual([]);
    // Held with no newer run: looked up each run, like the default branch.
    expect(lookups()).toEqual(['1']);
  });

  it('is not turned green by a success of the same workflow on another branch', async () => {
    world.mainRuns = [finished('success', 60, '2026-11-26T12:45:00Z'), MAIN_OK];
    world.recentRuns = [on('main', finished('success', 60, '2026-11-26T12:45:00Z'))];
    await runOnce(WITH_STAGING);
    expect(check('ci:staging')?.status).toBe('problem');
    expect(sent).toEqual([]);
  });

  it('turns green at the next success of that workflow on that branch', async () => {
    world.recentRuns = ONLY_MAIN;
    await runOnce(WITH_STAGING);
    world.recentRuns = [on('staging', STAGING_FIXED), ...ONLY_MAIN];
    await runOnce(WITH_STAGING);
    expect(check('ci:staging')?.status).toBe('ok');
    expect(sent.map((email) => email.subject)).toEqual(['Shop: CI on staging is green again']);
  });

  it('turns green when the failing workflow is found deleted, and is not looked up again', async () => {
    world.recentRuns = ONLY_MAIN;
    world.deletedWorkflows = [1];
    await runOnce(WITH_STAGING);
    expect(lookups()).toEqual(['1']);
    expect(check('ci:staging')).toMatchObject({
      status: 'ok',
      summary: 'No finished runs of an active workflow',
      detail: { failing: [] },
    });
    await runOnce(WITH_STAGING);
    expect(lookups()).toEqual([]);
    expect(check('ci:staging')?.status).toBe('ok');
    expect(sent.map((email) => email.subject)).toEqual(['Shop: CI on staging is green again']);
  });
});

describe('a healthy extra branch whose runs scrolled out of the recent ones', () => {
  it('keeps its row and its state, with no event', async () => {
    await runOnce(WITH_STAGING);
    world.recentRuns = ONLY_MAIN;
    await runOnce(WITH_STAGING);
    world.recentRuns = [];
    await runOnce(WITH_STAGING);
    expect(check('ci:staging')).toMatchObject({ status: 'ok', summary: 'Passing' });
    expect(events()).toEqual([]);
  });

  it('is listed as unknown when the branch has no recent runs from the start', async () => {
    world.recentRuns = ONLY_MAIN;
    await runOnce(WITH_STAGING);
    await runOnce(WITH_STAGING);
    expect(check('ci:staging')).toMatchObject({ status: 'unknown', summary: 'No recent runs' });
    // Its first runs are news like those of any other check: a failure alerts.
    world.recentRuns = [on('staging', STAGING_FAILED), ...ONLY_MAIN];
    await runOnce(WITH_STAGING);
    expect(sent.map((email) => email.subject)).toEqual(['Shop: CI on staging went red']);
  });
});

describe('workflows gone, per branch', () => {
  it('remembers a deleted workflow for the branch it failed on, and only there', async () => {
    const nightlyFailed = finished('failure', 7, '2026-11-26T11:00:00Z', 2);
    world.recentRuns = [on('staging', nightlyFailed), ...world.recentRuns];
    world.deletedWorkflows = [2];
    await runOnce(WITH_STAGING);
    expect(lookups()).toEqual(['2']);
    expect(check('ci:staging')).toMatchObject({
      status: 'ok',
      summary: 'Passing',
      detail: { failing: [], gone: [{ workflowId: 2, at: '2026-11-26T11:00:00Z' }] },
    });
    expect(check('ci')?.detail['gone']).toBeUndefined();
    // Its failed run is still listed, and is left out without another lookup.
    await runOnce(WITH_STAGING);
    expect(lookups()).toEqual([]);
    expect(check('ci:staging')?.status).toBe('ok');
    expect(events()).toEqual([]);
  });

  it('looks a workflow up once when it is failing on both branches', async () => {
    const failed = finished('failure', 8, '2026-11-26T11:00:00Z');
    world.mainRuns = [failed];
    world.recentRuns = [on('staging', { ...failed, id: 9 }), on('main', failed)];
    await runOnce(WITH_STAGING);
    expect(lookups()).toEqual(['1']);
    expect(check('ci')?.status).toBe('problem');
    expect(check('ci:staging')?.status).toBe('problem');
  });

  it('gives the default branches their lookups before any extra branch', async () => {
    // Five failing workflows on main, and a sixth that fails only on staging.
    const mainFailures = [11, 12, 13, 14, 15].map((workflow) =>
      finished('failure', workflow, '2026-11-26T11:00:00Z', workflow),
    );
    world.mainRuns = mainFailures;
    world.recentRuns = [
      on('staging', finished('failure', 16, '2026-11-26T11:00:00Z', 6)),
      ...mainFailures.map((run) => on('main', run)),
    ];
    await runOnce(WITH_STAGING);
    expect(lookups().sort()).toEqual(['11', '12', '13', '14', '15']);
  });
});

describe('an extra branch taken out of the config', () => {
  beforeEach(async () => {
    await runOnce(WITH_STAGING);
    world.recentRuns = [on('staging', STAGING_FAILED), ...world.recentRuns];
    await runOnce(WITH_STAGING);
    sent = [];
  });

  it('loses its row in a run where GitHub worked, with an event and no email', async () => {
    await runOnce(shopConfig({}));
    expect(check('ci:staging')).toBeUndefined();
    expect(check('ci')?.status).toBe('ok');
    expect(events().at(-1)).toBe('ci:staging check_removed: Shop: CI (staging) no longer watched');
    expect(sent).toEqual([]);
    // Without extra branches or pull request checks the extra call is not made.
    expect(requests.filter((url) => url.includes('/actions/runs'))).toHaveLength(1);
  });

  it('keeps its row while GitHub fails, and loses it once GitHub works again', async () => {
    world.graphqlStatus = 500;
    await runOnce(shopConfig({}));
    expect(check('ci:staging')?.status).toBe('problem');
    world.graphqlStatus = 200;
    await runOnce(shopConfig({}));
    expect(check('ci:staging')).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe('the call for the recent runs failing', () => {
  it('keeps the extra branch as it was, still checks the default branch, and names the repo', async () => {
    await runOnce(WITH_STAGING);
    world.recentStatus = 500;
    world.mainRuns = [finished('failure', 5, '2026-11-26T12:03:00Z'), MAIN_OK];
    await runOnce(WITH_STAGING);
    expect(check('ci:staging')).toMatchObject({ status: 'ok', summary: 'Passing' });
    expect(check('ci')?.status).toBe('problem');
    const health = sqlite
      .prepare("SELECT last_error FROM source_health WHERE source = 'github:personal'")
      .get() as { last_error: string };
    expect(health.last_error).toBe('acme/shop: HTTP 500');
    expect(events()).toEqual(['ci ci_red: Shop: CI on the default branch went red']);
  });
});

describe('pull request checks', () => {
  const PASSING = on('feature', finished('success', 21, '2026-11-26T11:00:00Z'), 'aaa111');
  const prChecks = () =>
    (check('prs')?.detail['pullRequests'] as { number: number; checks?: string }[]).map((pr) => [
      pr.number,
      pr.checks,
    ]);

  beforeEach(() => {
    world.pullRequests = [
      { number: 7, sha: 'aaa111' },
      { number: 8, sha: 'bbb222' },
      { number: 9, sha: 'ccc333' },
    ];
    world.recentRuns = [PASSING, on('main', MAIN_OK)];
  });

  it('says passing, failing or running per PR from the runs on its head commit', async () => {
    world.recentRuns = [
      PASSING,
      // A second workflow on the same commit is still going: the PR is running.
      on('other', finished('success', 22, '2026-11-26T11:00:00Z', 1), 'bbb222'),
      on(
        'other',
        { ...finished('', 23, '2026-11-26T11:01:00Z', 2), status: 'in_progress' },
        'bbb222',
      ),
      // A failure wins over a workflow that is still going.
      on('third', finished('failure', 24, '2026-11-26T11:00:00Z', 1), 'ccc333'),
      on('third', { ...finished('', 25, '2026-11-26T11:01:00Z', 2), status: 'queued' }, 'ccc333'),
    ];
    await runOnce(WITH_PR_CHECKS);
    expect(prChecks()).toEqual([
      [7, 'passing'],
      [8, 'running'],
      [9, 'failing'],
    ]);
    const status = await loadStatus(env.DB, WITH_PR_CHECKS, SECRETS, new Date(START));
    const [project] = status.groups.flatMap((group) => group.projects);
    expect(project?.pullRequests?.map((pr) => pr.checks)).toEqual([
      'passing',
      'running',
      'failing',
    ]);
    expect(project?.branchCi).toBeUndefined();
  });

  it('skips a run it cannot read instead of losing the whole list', () => {
    const body = recentRunsBody(REPO, [PASSING, on('staging', STAGING_OK)]) as {
      workflow_runs: Record<string, unknown>[];
    };
    body.workflow_runs.unshift({ ...body.workflow_runs[0], id: 99, name: null });
    const runs = parseRecentRuns(body, REPO);
    expect(runs.map((run) => run.id)).toEqual([21, 2]);
    expect(() => parseRecentRuns({ message: 'Not Found' }, REPO)).toThrow('invalid response');
  });

  it('leaves a PR without runs on its head commit, or with only cancelled ones, unmarked', async () => {
    world.recentRuns = [
      on('other', finished('cancelled', 22, '2026-11-26T11:00:00Z'), 'bbb222'),
      // An older commit of the same PR says nothing about its head.
      on('third', finished('failure', 24, '2026-11-26T11:00:00Z'), 'old999'),
    ];
    await runOnce(WITH_PR_CHECKS);
    expect(check('prs')?.detail['pullRequests']).toEqual([
      expect.not.objectContaining({ checks: expect.anything() as unknown }),
      expect.not.objectContaining({ checks: expect.anything() as unknown }),
      expect.not.objectContaining({ checks: expect.anything() as unknown }),
    ]);
  });

  it('never makes an event, an email or a problem, whatever the checks do', async () => {
    const failing = on('feature', finished('failure', 31, '2026-11-26T12:10:00Z'), 'aaa111');
    const rerun = { ...failing, status: 'in_progress', conclusion: null };
    const histories: FixtureRecentRun[][] = [
      [PASSING],
      [failing, PASSING],
      [rerun, PASSING],
      [failing, PASSING],
      [],
      [on('feature', finished('success', 32, '2026-11-26T12:30:00Z'), 'aaa111')],
    ];
    const seen: unknown[] = [];
    for (const recentRuns of histories) {
      world.recentRuns = recentRuns;
      await runOnce(WITH_PR_CHECKS);
      seen.push(prChecks()[0]?.[1]);
      const status = await loadStatus(env.DB, WITH_PR_CHECKS, SECRETS, new Date(START));
      expect(status.problems).toEqual([]);
      expect(check('prs')?.status).toBe('ok');
    }
    expect(seen).toEqual(['passing', 'failing', 'running', 'failing', undefined, 'passing']);
    expect(events()).toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) AS total FROM unsent_alerts').get()).toEqual({
      total: 0,
    });
    expect(sent).toEqual([]);
    expect(sourceFailures()).toBe(0);
  });

  it('still alerts on a review request, exactly as without checks', async () => {
    await runOnce(WITH_PR_CHECKS);
    world.pullRequests = [{ number: 7, sha: 'aaa111', isReviewRequested: true }];
    await runOnce(WITH_PR_CHECKS);
    expect(sent.map((email) => email.subject)).toEqual([
      'Shop: review requested on PR #7 (Change 7)',
    ]);
    expect(check('prs')?.summary).toBe('1 open, 1 need your review');
  });

  it('shows no checks when the recent runs cannot be read, and that is not a failing source', async () => {
    await runOnce(WITH_PR_CHECKS);
    world.recentStatus = 500;
    for (let run = 0; run < 4; run += 1) await runOnce(WITH_PR_CHECKS);
    expect(prChecks()).toEqual([
      [7, undefined],
      [8, undefined],
      [9, undefined],
    ]);
    expect(sourceFailures()).toBe(0);
    expect(events()).toEqual([]);
    expect(check('ci')?.status).toBe('ok');
  });

  it('shows no checks when the token may not read the head commits, and keeps the PRs', async () => {
    world.headsForbidden = true;
    world.pullRequests = [
      { number: 7, sha: 'aaa111', isReviewRequested: true },
      ...world.pullRequests.slice(1),
    ];
    for (let run = 0; run < 4; run += 1) await runOnce(WITH_PR_CHECKS);
    expect(prChecks()).toEqual([
      [7, undefined],
      [8, undefined],
      [9, undefined],
    ]);
    // The repo's own block is intact: its PRs and its CI are read as ever.
    expect(check('prs')?.summary).toBe('3 open, 1 need your review');
    expect(check('ci')?.status).toBe('ok');
    expect(sourceFailures()).toBe(0);
    expect(events()).toEqual([]);
  });

  it('does not ask for head commits, or for the recent runs, unless the repo opted in', async () => {
    const bodies: string[] = [];
    const recording: Fetcher = (url, init) => {
      if (typeof init?.body === 'string') bodies.push(init.body);
      return network(url, init);
    };
    await runChecks(env, new Date(START), shopConfig({}), recording);
    expect(bodies.join('')).not.toContain('headRefOid');
    expect(requests.filter((url) => url.includes('/actions/runs'))).toHaveLength(1);
    await runChecks(env, new Date(START + RUN_INTERVAL_MS), WITH_PR_CHECKS, recording);
    // Under a root alias of its own, never inside the repo's block.
    expect(bodies.join('')).toContain(
      'repo0: repository(owner: $owner0, name: $name0) { ...Watched }\\n  heads0: repository(owner: $owner0, name: $name0) { pullRequests(states: OPEN',
    );
  });
});

describe('the subrequests of a run', () => {
  const countRuns = async (fields: Partial<RepoFields>) => {
    await runOnce(shopConfig(fields));
    return requests.length;
  };

  it('is one more for a repo with extra branches, pull request checks, or both', async () => {
    // GraphQL and the default branch's runs.
    expect(await countRuns({})).toBe(2);
    expect(await countRuns({ extraBranches: ['staging'] })).toBe(3);
    expect(await countRuns({ pullRequestChecks: true })).toBe(3);
    expect(await countRuns({ extraBranches: ['staging', 'next'], pullRequestChecks: true })).toBe(
      3,
    );
  });

  it('is what the plan says', () => {
    // 1 repo + 6 for its token + 1 for Supabase.
    expect(plannedSubrequests(shopConfig({}))).toBe(8);
    expect(plannedSubrequests(shopConfig({ extraBranches: ['staging'] }))).toBe(9);
    expect(plannedSubrequests(shopConfig({ pullRequestChecks: true }))).toBe(9);
    expect(
      plannedSubrequests(
        shopConfig({ extraBranches: ['staging', 'next'], pullRequestChecks: true }),
      ),
    ).toBe(9);
    // A repo whose token is not set is not called, so it plans nothing.
    const noTokens = { github: () => false, supabase: false, cloudflare: false };
    expect(plannedSubrequests(WITH_STAGING, noTokens)).toBe(0);
  });
});
