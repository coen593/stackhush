import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
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

interface SentEmail {
  subject: string;
  text: string;
  html: string;
}

/** Everything the fake network and the fake email service do, adjustable between runs. */
interface World {
  siteStatus: number;
  ciConclusion: string;
  supabaseStatus: string;
  workGithubStatus: number;
  supabaseFails: boolean;
  /** Whether the Supabase token still sees the project that is not in the config. */
  strayProjectExists: boolean;
  /** The personal GitHub token's GraphQL call answers with this status. */
  personalGithubStatus: number;
  /** The personal repo's recent deployments are all previews: production scrolled out. */
  onlyPreviewDeployments: boolean;
  /** The personal repo's newest Production deployment failed. */
  productionDeployFailed: boolean;
  /** GitHub answers the work owner's GraphQL call with an error for its one repo. */
  workGraphqlForbidden: boolean;
  projects: readonly Project[];
  emailFails: boolean;
  fetchCount: number;
  sent: SentEmail[];
}

const ALL_SECRETS: Secrets = {
  github: new Map([
    ['personal', 't'],
    ['work', 't'],
  ]),
  supabase: 't',
  cloudflare: 't',
  vapid: { kind: 'absent' },
};

let sqlite: DatabaseSync;
let env: Env;
let world: World;
let runIndex: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function emptyRepo(): unknown {
  return {
    deployments: { nodes: [] },
    pullRequests: { nodes: [] },
  };
}

function fetcher(): Fetcher {
  return (url, init) => {
    world.fetchCount += 1;
    if (url.startsWith('https://api.github.com/graphql')) {
      // Only the personal repo has PRs; the work repo has none.
      const isWork = new Headers(init?.headers).get('Authorization')?.includes('work') ?? false;
      if (!isWork) {
        const body = githubGraphqlBody() as {
          data: {
            repo0: {
              deployments: { nodes: { environment: string; latestStatus: { state: string } }[] };
              held0?: { nodes: unknown[] };
            };
          };
        };
        const { deployments } = body.data.repo0;
        const production = deployments.nodes.filter((node) => node.environment === 'Production');
        if (world.productionDeployFailed && production[0]) {
          production[0].latestStatus.state = 'FAILURE';
        }
        if (world.onlyPreviewDeployments) {
          deployments.nodes = deployments.nodes.filter((node) => node.environment === 'Preview');
        }
        // Asked by name for the newest deployment of a failing environment: when production is
        // not listed here, that environment was deleted and has none.
        if (typeof init?.body === 'string' && init.body.includes('held0')) {
          body.data.repo0.held0 = {
            nodes: world.onlyPreviewDeployments ? [] : production.slice(0, 1),
          };
        }
        return Promise.resolve(json(body, world.personalGithubStatus));
      }
      if (world.workGraphqlForbidden) {
        // What a fine-grained token gets for a field it may not read: 200, data and an error.
        return Promise.resolve(
          json({
            data: { repo0: { deployments: null, pullRequests: { nodes: [] } } },
            errors: [{ type: 'FORBIDDEN', path: ['repo0', 'deployments'], message: 'denied' }],
          }),
        );
      }
      return Promise.resolve(json({ data: { repo0: emptyRepo() } }));
    }
    if (url.includes('/actions/workflows/')) {
      return Promise.resolve(json({ state: 'active' }));
    }
    if (url.startsWith('https://api.github.com/repos/acme-org/')) {
      const ok = world.workGithubStatus === 200;
      const runs = workflowRunsBody([
        {
          workflow: 5,
          name: 'Build',
          status: 'completed',
          conclusion: 'success',
          at: '2026-11-26T09:30:00Z',
        },
      ]);
      return Promise.resolve(json(ok ? runs : {}, world.workGithubStatus));
    }
    if (url.startsWith('https://api.github.com/repos/')) {
      return Promise.resolve(
        json(
          workflowRunsBody([
            {
              workflow: 1,
              name: 'CI',
              status: 'completed',
              conclusion: world.ciConclusion,
              at: '2026-11-26T10:00:00Z',
            },
          ]),
        ),
      );
    }
    if (url.startsWith('https://api.supabase.com/')) {
      if (world.supabaseFails) return Promise.reject(new TypeError('network down'));
      return Promise.resolve(
        json(
          (supabaseBody() as { status: string }[])
            .map((project, index) =>
              index === 0 ? { ...project, status: world.supabaseStatus } : project,
            )
            .filter((_, index) => index === 0 || world.strayProjectExists),
        ),
      );
    }
    if (url.startsWith('https://api.cloudflare.com/') && url.endsWith('/graphql')) {
      return Promise.resolve(
        json(analyticsBody([{ script: 'demo-worker', status: 'success', requests: 40 }])),
      );
    }
    if (url.startsWith('https://api.cloudflare.com/'))
      return Promise.resolve(json(scriptListBody()));
    return Promise.resolve(
      new Response('', { status: url.includes('demo.example') ? world.siteStatus : 200 }),
    );
  };
}

async function runOnce(): Promise<void> {
  const now = new Date(START + runIndex * RUN_INTERVAL_MS);
  runIndex += 1;
  await runChecks(env, now, configWith(world.projects), fetcher());
}

function count(table: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
  return row.total;
}

function eventTitles(): string[] {
  return (
    sqlite.prepare('SELECT title FROM events ORDER BY rowid').all() as { title: string }[]
  ).map((row) => row.title);
}

function checkRow(
  projectId: string,
  checkKey: string,
): { status: string; summary: string; updated_at: string } | undefined {
  return sqlite
    .prepare(
      'SELECT status, summary, updated_at FROM check_states WHERE project_id = ? AND check_key = ?',
    )
    .get(projectId, checkKey) as
    { status: string; summary: string; updated_at: string } | undefined;
}

function eventKinds(): string[] {
  return (sqlite.prepare('SELECT kind FROM events ORDER BY rowid').all() as { kind: string }[]).map(
    (row) => row.kind,
  );
}

beforeEach(() => {
  const database = createTestDatabase();
  sqlite = database.sqlite;
  world = {
    siteStatus: 200,
    ciConclusion: 'success',
    supabaseStatus: 'ACTIVE_HEALTHY',
    workGithubStatus: 200,
    supabaseFails: false,
    strayProjectExists: true,
    personalGithubStatus: 200,
    onlyPreviewDeployments: false,
    productionDeployFailed: false,
    workGraphqlForbidden: false,
    projects: TEST_PROJECTS,
    emailFails: false,
    fetchCount: 0,
    sent: [],
  };
  env = {
    ...createTestEnv(database.db),
    ALERT_EMAIL: {
      send: (message: unknown) => {
        if (world.emailFails)
          return Promise.reject(Object.assign(new Error('boom'), { code: 'E_DELIVERY_FAILED' }));
        world.sent.push(message as SentEmail);
        return Promise.resolve({ messageId: 'id' });
      },
    },
  };
  runIndex = 0;
});

describe('the first run', () => {
  it('records everything, including problems, and sends nothing', async () => {
    world.ciConclusion = 'failure';
    world.supabaseStatus = 'INACTIVE';
    await runOnce();
    expect(world.sent).toEqual([]);
    expect(count('events')).toBe(0);
    expect(count('check_states')).toBeGreaterThan(8);
    expect(count('notified_review_requests')).toBe(1);
    const state = sqlite.prepare('SELECT last_run_finished_at FROM run_state').get() as {
      last_run_finished_at: string | null;
    };
    expect(state.last_run_finished_at).not.toBeNull();
  });

  it('stays silent on the next run too when the problems are unchanged', async () => {
    world.ciConclusion = 'failure';
    await runOnce();
    await runOnce();
    expect(world.sent).toEqual([]);
    expect(count('events')).toBe(0);
  });

  it('is still first after a crash before it finished', async () => {
    sqlite
      .prepare('INSERT INTO run_state (id, last_run_started_at) VALUES (1, ?)')
      .run('2026-11-26T11:00:00.000Z');
    world.ciConclusion = 'failure';
    await runOnce();
    expect(world.sent).toEqual([]);
    expect(count('events')).toBe(0);
  });
});

describe('alerts after the first run', () => {
  beforeEach(async () => {
    await runOnce();
  });

  it('emails once when CI goes red, and once when it recovers', async () => {
    world.ciConclusion = 'failure';
    await runOnce();
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.subject).toBe('Demo App: CI on the default branch went red');
    await runOnce();
    expect(world.sent).toHaveLength(1);
    world.ciConclusion = 'success';
    await runOnce();
    expect(world.sent).toHaveLength(2);
    expect(eventKinds()).toEqual(['ci_red', 'ci_green']);
    expect(count('unsent_alerts')).toBe(0);
  });

  it('waits for a second failed run before reporting a site down', async () => {
    world.siteStatus = 503;
    await runOnce();
    expect(world.sent).toHaveLength(0);
    await runOnce();
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.subject).toContain('demo.example.test is down');
  });

  it('puts every change of one run into one email', async () => {
    world.ciConclusion = 'failure';
    world.supabaseStatus = 'INACTIVE';
    await runOnce();
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.subject).toMatch(/^2 changes: /);
    expect(world.sent[0]?.text).toContain('CI on the default branch went red');
    expect(world.sent[0]?.text).toContain('Supabase project not healthy');
  });

  it('keeps unsent alerts when sending fails and retries them with the next change', async () => {
    world.emailFails = true;
    world.ciConclusion = 'failure';
    await runOnce();
    expect(world.sent).toHaveLength(0);
    expect(count('unsent_alerts')).toBe(1);
    const row = sqlite.prepare('SELECT attempts, last_attempt_at FROM unsent_alerts').get() as {
      attempts: number;
      last_attempt_at: string | null;
    };
    expect(row.attempts).toBe(1);
    expect(row.last_attempt_at).not.toBeNull();

    world.emailFails = false;
    world.supabaseStatus = 'INACTIVE';
    await runOnce();
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.subject).toMatch(/^2 changes: /);
    expect(count('unsent_alerts')).toBe(0);
  });

  it('never logs the email body when sending fails', async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    try {
      world.emailFails = true;
      world.ciConclusion = 'failure';
      await runOnce();
    } finally {
      console.error = original;
    }
    expect(logged.join('\n')).toContain('E_DELIVERY_FAILED');
    expect(logged.join('\n')).not.toContain('Demo App');
  });

  it('reports a source that fails three runs in a row, once, and when it works again', async () => {
    world.workGithubStatus = 401;
    await runOnce();
    await runOnce();
    expect(world.sent).toHaveLength(0);
    await runOnce();
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.subject).toBe(
      'GitHub (acme-org) has failed 3 runs in a row (acme-org/other-site: HTTP 401)',
    );
    await runOnce();
    expect(world.sent).toHaveLength(1);
    world.workGithubStatus = 200;
    await runOnce();
    expect(world.sent).toHaveLength(2);
    expect(eventKinds()).toEqual(['source_failing', 'source_ok']);
  });

  it('reports a GraphQL error for a repo as a failing source naming the repo, and still checks CI', async () => {
    world.workGraphqlForbidden = true;
    await runOnce();
    await runOnce();
    await runOnce();
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]?.subject).toBe(
      'GitHub (acme-org) has failed 3 runs in a row (acme-org/other-site: GraphQL FORBIDDEN)',
    );
    expect(checkRow('other', 'ci')).toBeDefined();
  });

  it('lets the other sources carry on when one fails', async () => {
    world.supabaseFails = true;
    world.ciConclusion = 'failure';
    await runOnce();
    expect(world.sent).toHaveLength(1);
    const health = sqlite
      .prepare(
        "SELECT consecutive_failures, last_error FROM source_health WHERE source = 'supabase'",
      )
      .get() as { consecutive_failures: number; last_error: string };
    expect(health).toEqual({ consecutive_failures: 1, last_error: 'network error' });
  });

  it('alerts on a new review request once, not on later runs', async () => {
    sqlite.prepare('DELETE FROM notified_review_requests').run();
    await runOnce();
    expect(eventKinds()).toEqual(['review_requested']);
    await runOnce();
    expect(eventKinds()).toEqual(['review_requested']);
    expect(world.sent).toHaveLength(1);
  });
});

describe('a source that only starts working after the first run', () => {
  it('records what it finds, including review requests and red CI, without emailing', async () => {
    world.personalGithubStatus = 401;
    world.ciConclusion = 'failure';
    await runOnce();
    await runOnce();
    expect(count('notified_review_requests')).toBe(0);
    expect(checkRow('demo', 'ci')).toBeUndefined();

    world.personalGithubStatus = 200;
    await runOnce();
    expect(world.sent).toEqual([]);
    expect(count('events')).toBe(0);
    expect(count('notified_review_requests')).toBe(1);
    expect(checkRow('demo', 'ci')?.status).toBe('problem');

    // From here on it alerts like any other source.
    world.ciConclusion = 'success';
    await runOnce();
    expect(eventKinds()).toEqual(['ci_green']);
  });

  it('says so when it had been failing long enough to be reported', async () => {
    world.personalGithubStatus = 401;
    await runOnce();
    await runOnce();
    await runOnce();
    await runOnce();
    world.personalGithubStatus = 200;
    await runOnce();
    expect(eventKinds()).toEqual(['source_failing', 'source_ok']);
  });
});

describe('a check first seen as a problem after the first run', () => {
  it('alerts, and later reports the recovery', async () => {
    world.projects = [TEST_PROJECTS[0] as Project];
    await runOnce();
    // A second project is added to the config while its site is down.
    world.projects = TEST_PROJECTS;
    const down = fetcher();
    const downFetcher: Fetcher = (url, init) =>
      url.includes('other.example')
        ? Promise.resolve(new Response('', { status: 503 }))
        : down(url, init);
    const runWith = async (use: Fetcher) => {
      await runChecks(
        env,
        new Date(START + runIndex * RUN_INTERVAL_MS),
        configWith(world.projects),
        use,
      );
      runIndex += 1;
    };
    await runWith(downFetcher);
    await runWith(downFetcher);
    expect(eventKinds()).toEqual(['site_down']);
    await runWith(fetcher());
    expect(eventKinds()).toEqual(['site_down', 'site_up']);
  });
});

describe('writes', () => {
  it('leaves rows that did not change untouched', async () => {
    await runOnce();
    const before = checkRow('demo', 'ci');
    const supabaseBefore = checkRow('demo', 'supabase:abcdefghijklmnopqrst');
    await runOnce();
    await runOnce();
    expect(checkRow('demo', 'ci')).toEqual(before);
    expect(checkRow('demo', 'supabase:abcdefghijklmnopqrst')).toEqual(supabaseBefore);
    expect(before?.updated_at).toBe(new Date(START).toISOString());
  });

  it('rewrites a row when the check changes', async () => {
    await runOnce();
    world.ciConclusion = 'failure';
    await runOnce();
    const row = checkRow('demo', 'ci');
    expect(row?.status).toBe('problem');
    expect(row?.updated_at).toBe(new Date(START + RUN_INTERVAL_MS).toISOString());
  });
});

describe('checks that are no longer reported', () => {
  const STRAY = 'supabase:zzzzzzzzzzzzzzzzzzzz';
  const OTHER_SITE = 'uptime:https://other.example.test';

  beforeEach(async () => {
    await runOnce();
  });

  it('deletes the row of a deleted Supabase project and logs it, without email', async () => {
    expect(checkRow('unassigned', STRAY)).toBeDefined();
    world.strayProjectExists = false;
    await runOnce();
    expect(checkRow('unassigned', STRAY)).toBeUndefined();
    expect(eventKinds()).toEqual(['check_removed']);
    expect(eventTitles()).toEqual(['Unassigned: stray-project no longer watched']);
    expect(count('unsent_alerts')).toBe(0);
    expect(world.sent).toEqual([]);
    // Everything else Supabase and the other sources reported is still there.
    expect(checkRow('demo', 'supabase:abcdefghijklmnopqrst')).toBeDefined();
    expect(checkRow('demo', 'ci')).toBeDefined();
    expect(checkRow('other', OTHER_SITE)).toBeDefined();
  });

  it('keeps a healthy Deploy row when production deployments scroll out of the recent ones', async () => {
    const before = checkRow('demo', 'deploy');
    expect(before?.status).toBe('ok');
    world.onlyPreviewDeployments = true;
    await runOnce();
    await runOnce();
    expect(checkRow('demo', 'deploy')).toEqual(before);
    expect(count('events')).toBe(0);
  });

  it('deletes a red Deploy row when its only production environment was deleted', async () => {
    world.productionDeployFailed = true;
    await runOnce();
    expect(checkRow('demo', 'deploy')?.status).toBe('problem');
    expect(world.sent).toHaveLength(1);
    // The environment is deleted in GitHub: no deployment of it is left, only previews.
    world.onlyPreviewDeployments = true;
    await runOnce();
    await runOnce();
    expect(checkRow('demo', 'deploy')).toBeUndefined();
    expect(eventKinds()).toEqual(['deploy_failed', 'check_removed']);
    expect(eventTitles()[1]).toBe('Demo App: Deploy no longer watched');
    expect(count('unsent_alerts')).toBe(0);
    expect(world.sent).toHaveLength(1);
    const status = await loadStatus(env.DB, configWith(world.projects), ALL_SECRETS, new Date());
    expect(status.problems).toEqual([]);
  });

  it('deletes the Deploy row when the repo stops watching deployments', async () => {
    const demo = TEST_PROJECTS[0] as Project;
    if (!demo.github) throw new Error('The demo project has a repo');
    world.projects = [
      { ...demo, github: { ...demo.github, watchDeployments: false } },
      TEST_PROJECTS[1] as Project,
    ];
    await runOnce();
    expect(checkRow('demo', 'deploy')).toBeUndefined();
    expect(eventTitles()).toEqual(['Demo App: Deploy no longer watched']);
  });

  it('keeps the row when the source failed this run, and deletes it once it works again', async () => {
    world.strayProjectExists = false;
    world.supabaseFails = true;
    await runOnce();
    await runOnce();
    expect(checkRow('unassigned', STRAY)).toBeDefined();
    expect(count('events')).toBe(0);
    world.supabaseFails = false;
    await runOnce();
    expect(checkRow('unassigned', STRAY)).toBeUndefined();
  });

  it('clears a problem that was stuck on a URL taken out of the config', async () => {
    world.siteStatus = 503;
    await runOnce();
    await runOnce();
    const demo = TEST_PROJECTS[0] as Project;
    const downUrl = 'uptime:https://demo.example.test';
    expect(checkRow('demo', downUrl)?.status).toBe('problem');

    world.projects = [{ ...demo, productionUrls: [] }, TEST_PROJECTS[1] as Project];
    await runOnce();
    expect(checkRow('other', OTHER_SITE)).toBeDefined();
    expect(checkRow('demo', downUrl)).toBeUndefined();
    const status = await loadStatus(env.DB, configWith(world.projects), ALL_SECRETS, new Date());
    expect(status.problems).toEqual([]);
  });

  it('keeps the GitHub rows of a repo while its token is failing', async () => {
    world.workGithubStatus = 500;
    await runOnce();
    expect(checkRow('other', 'prs')).toBeDefined();
    // The same config change that would remove them when the source works:
    world.projects = [TEST_PROJECTS[0] as Project];
    world.personalGithubStatus = 500;
    await runOnce();
    expect(checkRow('demo', 'ci')).toBeDefined();
    expect(checkRow('demo', 'prs')).toBeDefined();
  });

  it('deletes the rows of a project taken out of the config', async () => {
    world.projects = [TEST_PROJECTS[0] as Project];
    await runOnce();
    expect(count("check_states WHERE project_id = 'other'")).toBe(0);
    expect(count("check_states WHERE project_id = 'demo'")).toBeGreaterThan(5);
  });

  it("deletes rows whose source no longer exists, and that source's health row", async () => {
    sqlite
      .prepare(
        `INSERT INTO check_states (project_id, check_key, status, summary, detail_json, problem_since, observed_at)
         VALUES ('demo', 'worker:renamed', 'problem', 'x', '{"label":"renamed","source":"cloudflare:old-name"}', ?, ?)`,
      )
      .run('2026-11-26T11:00:00.000Z', '2026-11-26T11:00:00.000Z');
    sqlite
      .prepare(
        "INSERT INTO source_health (source, consecutive_failures, last_error, last_attempt_at) VALUES ('cloudflare:old-name', 9, 'HTTP 403', ?)",
      )
      .run('2026-11-26T11:00:00.000Z');
    expect(
      (await loadStatus(env.DB, configWith(world.projects), ALL_SECRETS, new Date())).problems,
    ).toHaveLength(2);
    await runOnce();
    expect(checkRow('demo', 'worker:renamed')).toBeUndefined();
    expect(count("source_health WHERE source = 'cloudflare:old-name'")).toBe(0);
    expect(count('source_health')).toBe(7);
    expect(
      (await loadStatus(env.DB, configWith(world.projects), ALL_SECRETS, new Date())).problems,
    ).toEqual([]);
  });
});

describe('a failing alert email', () => {
  beforeEach(async () => {
    await runOnce();
  });

  it('shows as a problem on the dashboard until the email goes out', async () => {
    world.emailFails = true;
    world.ciConclusion = 'failure';
    await runOnce();
    world.supabaseStatus = 'INACTIVE';
    await runOnce();
    const failing = (
      await loadStatus(env.DB, configWith(world.projects), ALL_SECRETS, new Date())
    ).problems.find((problem) => problem.projectId === null);
    expect(failing).toEqual({
      projectId: null,
      title: 'Alert email failing: 2 unsent since 2026-11-26 12:05 UTC',
      linkUrl: null,
      since: '2026-11-26T12:05:00.000Z',
    });

    world.emailFails = false;
    await runOnce();
    const after = await loadStatus(env.DB, configWith(world.projects), ALL_SECRETS, new Date());
    expect(after.problems.filter((problem) => problem.projectId === null)).toEqual([]);
  });

  it('is not reported for alerts that are merely waiting for their first send', async () => {
    sqlite
      .prepare(
        "INSERT INTO events (id, project_id, check_key, kind, title, occurred_at) VALUES ('queued', 'demo', 'ci', 'ci_red', 'queued', ?)",
      )
      .run('2026-11-26T12:00:00.000Z');
    sqlite.prepare("INSERT INTO unsent_alerts (event_id) VALUES ('queued')").run();
    const status = await loadStatus(env.DB, configWith(world.projects), ALL_SECRETS, new Date());
    expect(status.problems.filter((problem) => problem.projectId === null)).toEqual([]);
  });

  it('leads the late email with the latest change, not the oldest', async () => {
    world.emailFails = true;
    world.siteStatus = 503;
    await runOnce();
    await runOnce();
    world.siteStatus = 200;
    await runOnce();
    world.emailFails = false;
    await runOnce();
    expect(world.sent).toHaveLength(1);
    // Both demo sites went down and came back while the email was failing.
    expect(world.sent[0]?.subject).toMatch(
      /^4 changes: \S+ is back up, \S+ is back up, \S+ is down/,
    );
  });
});

describe('cleanup', () => {
  it('deletes events older than 90 days except ones still unsent', async () => {
    await runOnce();
    const insert = sqlite.prepare(
      'INSERT INTO events (id, project_id, check_key, kind, title, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const old = '2026-08-01T00:00:00.000Z';
    const recent = '2026-11-20T00:00:00.000Z';
    insert.run('old-sent', 'demo', 'ci', 'ci_red', 'old sent', old);
    insert.run('old-unsent', 'demo', 'ci', 'ci_red', 'old unsent', old);
    insert.run('recent', 'demo', 'ci', 'ci_red', 'recent', recent);
    sqlite.prepare('INSERT INTO unsent_alerts (event_id) VALUES (?)').run('old-unsent');
    world.emailFails = true;
    await runOnce();
    const ids = (sqlite.prepare('SELECT id FROM events ORDER BY id').all() as { id: string }[]).map(
      (row) => row.id,
    );
    expect(ids).toEqual(['old-unsent', 'recent']);
    expect(count('unsent_alerts')).toBe(1);
  });
});

describe('more deleted failing workflows than lookups', () => {
  const repoProject = (id: string, fullName: string): Project => ({
    id,
    name: id,
    group: 'Side projects',
    github: { fullName, ownerKey: 'personal', defaultBranch: 'main', watchDeployments: false },
    productionUrls: [],
    supabaseRef: null,
    cloudflare: null,
  });
  const projects = [repoProject('alpha', 'acme/alpha'), repoProject('beta', 'acme/beta')];
  const failedRuns = (firstWorkflow: number) =>
    workflowRunsBody(
      [0, 1, 2].map((offset) => ({
        id: firstWorkflow + offset,
        workflow: firstWorkflow + offset,
        name: `W${firstWorkflow + offset}`,
        status: 'completed',
        conclusion: 'failure',
        at: '2026-11-20T03:00:00Z',
      })),
    );
  const after = (ms: number, response: Response) =>
    new Promise<Response>((resolve) => setTimeout(() => resolve(response), ms));

  it('looks up the same workflows whichever repo answers first, so nothing flips', async () => {
    const lookedUp: string[][] = [];
    for (let round = 0; round < 6; round += 1) {
      const thisRound: string[] = [];
      lookedUp.push(thisRound);
      const alphaFirst = round % 2 === 0;
      // Six failing workflows and five lookups. Only the last in line (W22) was deleted.
      const network: Fetcher = (url) => {
        if (url.endsWith('/graphql')) {
          return Promise.resolve(json({ data: { repo0: emptyRepo(), repo1: emptyRepo() } }));
        }
        if (url.includes('/actions/workflows/')) {
          thisRound.push(url.slice(url.indexOf('/repos/')));
          const answer = url.endsWith('/22') ? json({}, 404) : json({ state: 'active' });
          return after(alphaFirst ? 1 : 3, answer);
        }
        if (url.includes('/acme/alpha/')) return after(alphaFirst ? 1 : 8, json(failedRuns(10)));
        if (url.includes('/acme/beta/')) return after(alphaFirst ? 8 : 1, json(failedRuns(20)));
        return Promise.resolve(json([]));
      };
      await runChecks(
        env,
        new Date(START + round * RUN_INTERVAL_MS),
        configWith(projects),
        network,
      );
    }
    expect(count('events')).toBe(0);
    expect(world.sent).toEqual([]);
    for (const urls of lookedUp) expect([...urls].sort()).toEqual([...(lookedUp[0] ?? [])].sort());
    expect(lookedUp[0]).toHaveLength(5);
    expect(lookedUp[0]?.some((url) => url.endsWith('/22'))).toBe(false);
    // The deleted one is past the cap and stays red, every run, whoever answers first.
    expect(checkRow('beta', 'ci')).toMatchObject({
      status: 'problem',
      summary: 'Failing: W20, W21, W22',
    });
  });

  it('forgets a deleted workflow for good once it got a lookup, whatever the others do', async () => {
    // Alpha: five failing workflows that still exist. Beta: one passing workflow, and a deleted
    // one whose failed run is still listed and which is sixth in line for a lookup.
    const alphaRun = (workflow: number, extra: Partial<FixtureRun> = {}): FixtureRun => ({
      id: workflow,
      workflow,
      name: `W${workflow}`,
      status: 'completed',
      conclusion: 'failure',
      at: '2026-11-20T03:00:00Z',
      ...extra,
    });
    const allFailed = [1, 2, 3, 4, 5].map((workflow) => alphaRun(workflow));
    // A new run of W1 is on its way (W1 then needs no lookup), or has failed again (it does).
    const newRunStarted = (at: string) => [
      alphaRun(1, { id: 100, status: 'in_progress', conclusion: null, at }),
      ...allFailed,
    ];
    const newRunFailed = (at: string) => [alphaRun(1, { id: 100, at }), ...allFailed];
    const nights = [
      allFailed,
      newRunStarted('2026-11-27T03:00:00Z'),
      newRunFailed('2026-11-27T03:00:00Z'),
      newRunStarted('2026-11-28T03:00:00Z'),
      newRunFailed('2026-11-28T03:00:00Z'),
      newRunStarted('2026-11-29T03:00:00Z'),
      newRunFailed('2026-11-29T03:00:00Z'),
    ];
    const betaRuns = workflowRunsBody([
      alphaRun(9, { name: 'Removed' }),
      alphaRun(8, { name: 'Build', conclusion: 'success' }),
    ]);
    const betaLookups: number[] = [];

    for (const [round, alphaRuns] of nights.entries()) {
      const network: Fetcher = (url) => {
        if (url.endsWith('/graphql')) {
          return Promise.resolve(json({ data: { repo0: emptyRepo(), repo1: emptyRepo() } }));
        }
        if (url.includes('/acme/beta/actions/workflows/')) {
          betaLookups.push(round);
          return Promise.resolve(json({}, 404));
        }
        if (url.includes('/actions/workflows/')) return Promise.resolve(json({ state: 'active' }));
        if (url.includes('/acme/alpha/')) return Promise.resolve(json(workflowRunsBody(alphaRuns)));
        if (url.includes('/acme/beta/')) return Promise.resolve(json(betaRuns));
        return Promise.resolve(json([]));
      };
      await runChecks(
        env,
        new Date(START + round * RUN_INTERVAL_MS),
        configWith(projects),
        network,
      );
      // Seeded red (sixth in line); from the first lookup on it is, and stays, forgotten.
      expect(checkRow('beta', 'ci')?.status, `round ${round}`).toBe(round === 0 ? 'problem' : 'ok');
    }
    expect(betaLookups).toEqual([1]);
    expect(eventKinds()).toEqual(['ci_green']);
    expect(world.sent).toHaveLength(1);
    expect(checkRow('alpha', 'ci')?.status).toBe('problem');
  });
});

describe('fetch options', () => {
  // The tests run on Node, which accepts fetch options the Workers runtime rejects at call
  // time (redirect: 'error' throws there). Every value the Worker passes must be on this list.
  const WORKERD_REDIRECT_MODES: (string | undefined)[] = [undefined, 'follow', 'manual'];
  const WORKERD_INIT_KEYS = ['method', 'headers', 'body', 'redirect', 'signal'];

  it('are ones the Workers runtime accepts, on every call of a run', async () => {
    const inits: { url: string; init: RequestInit | undefined }[] = [];
    const real = fetcher();
    world.ciConclusion = 'failure';
    const recording: Fetcher = (url, init) => {
      inits.push({ url, init });
      return real(url, init);
    };
    await runChecks(env, new Date(START), configWith(TEST_PROJECTS), recording);
    await runChecks(env, new Date(START + RUN_INTERVAL_MS), configWith(TEST_PROJECTS), recording);
    // Every kind of call was made, the workflow lookup included.
    for (const part of [
      '/graphql',
      '/actions/runs',
      '/actions/workflows/',
      'supabase',
      'demo.example',
    ]) {
      expect(inits.some(({ url }) => url.includes(part))).toBe(true);
    }
    for (const { url, init } of inits) {
      expect(WORKERD_REDIRECT_MODES, url).toContain(init?.redirect);
      for (const key of Object.keys(init ?? {})) expect(WORKERD_INIT_KEYS, url).toContain(key);
      // Never 'follow': with a token it could hand the token to another host, and without one
      // it would be a subrequest nobody counted.
      expect(init?.redirect, url).toBe('manual');
    }
  });
});

describe('subrequests', () => {
  it('makes one fetch per site, one GraphQL per token plus one per repo, 1 for Supabase, 2 per Cloudflare account', async () => {
    await runOnce();
    // 3 sites + (1 + 1) personal GitHub + (1 + 1) work GitHub + 1 Supabase + 2 Cloudflare.
    expect(world.fetchCount).toBe(10);
  });
});
