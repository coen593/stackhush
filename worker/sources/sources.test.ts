import { describe, expect, it } from 'vitest';
import type { StateObservation } from '../observations.ts';
import type { PreviousCheck } from '../transitions.ts';
import {
  fetchCloudflare,
  parseAnalytics,
  parseScriptList,
  workerObservation,
} from './cloudflare.ts';
import {
  analyticsBody,
  CLIENT_ACCOUNT,
  DEMO_PROJECT,
  githubGraphqlBody,
  MAIN_ACCOUNT,
  OTHER_PROJECT,
  PERSONAL_OWNER,
  scriptListBody,
  SPARE_ACCOUNT,
  supabaseBody,
  type FixtureRun,
  TEST_PROJECTS,
  recentRunsBody,
  workflowRunsBody,
  WORK_OWNER,
} from '../testing/fixtures.ts';
import { MAX_WORKFLOW_LOOKUPS } from '../config.ts';
import {
  buildQuery,
  buildVariables,
  ciObservation,
  deployObservation,
  fetchGitHub,
  parseGitHubGraphql,
  parseWorkflowRuns,
  readFailingEnvironments,
  readFailingWorkflows,
  readGoneWorkflows,
} from './github.ts';
import type { Fetcher } from './http.ts';
import { fetchSupabase, parseSupabaseProjects } from './supabase.ts';
import { describeResponse, fetchUptime } from './uptime.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stateOf(observation: unknown): StateObservation {
  const value = observation as StateObservation | null | undefined;
  if (value?.type !== 'state') throw new Error('Expected a state observation');
  return value;
}

type Run = FixtureRun;

const NO_REDIRECTS = { reserved: new Map<string, number>(), spare: 0 };

const MY_LOGINS = PERSONAL_OWNER.logins;

/** That many repos with nothing failing, as the query builder and parser take them. */
function queried(count: number): { fullName: string; failingEnvironments: never[] }[] {
  return Array.from({ length: count }, (_, index) => ({
    fullName: `acme/repo-${index}`,
    failingEnvironments: [],
  }));
}

function storedCheck(checkKey: string, detail: Record<string, unknown>): PreviousCheck {
  return {
    projectId: 'demo',
    checkKey,
    status: 'problem',
    consecutiveFailures: 1,
    summary: '',
    linkUrl: null,
    detail,
    problemSince: '2026-11-26T10:05:00.000Z',
  };
}

function run(overrides: Partial<Run>): Run {
  return {
    workflow: 1,
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    at: '2026-11-26T10:00:00Z',
    ...overrides,
  };
}

describe('uptime', () => {
  it('formats the response and latency', () => {
    expect(describeResponse(200, 312)).toBe('200 in 312 ms');
    expect(describeResponse(503, 80)).toBe('HTTP 503 in 80 ms');
  });

  it('marks 2xx up, others down, and failures unreachable, with the fixed User-Agent', async () => {
    const agents = new Set<string>();
    const fetcher: Fetcher = (url, init) => {
      agents.add(new Headers(init?.headers).get('User-Agent') ?? '');
      if (url.startsWith('https://demo.example.test')) return Promise.resolve(new Response('ok'));
      if (url.startsWith('https://admin.demo')) {
        return Promise.resolve(new Response('', { status: 502 }));
      }
      return Promise.reject(new TypeError('connect failed'));
    };
    const result = await fetchUptime(fetcher, TEST_PROJECTS, new Map(), NO_REDIRECTS);
    expect(result.error).toBeNull();
    expect([...agents]).toEqual(['stackhush-uptime']);
    const byKey = new Map(result.observations.map((o) => [stateOf(o).checkKey, stateOf(o)]));
    expect(byKey.get('uptime:https://demo.example.test')?.status).toBe('ok');
    const admin = byKey.get('uptime:https://admin.demo.example.test');
    expect(admin?.status).toBe('problem');
    expect(admin?.summary).toMatch(/^HTTP 502 in \d+ ms$/);
    expect(byKey.get('uptime:https://other.example.test')?.summary).toBe('unreachable');
    expect([...byKey.values()].every((o) => o.failuresToProblem === 2)).toBe(true);
  });

  it('calls a timeout a timeout', async () => {
    const fetcher: Fetcher = () => Promise.reject(new DOMException('slow', 'TimeoutError'));
    const result = await fetchUptime(fetcher, [OTHER_PROJECT], new Map(), NO_REDIRECTS);
    expect(stateOf(result.observations[0]).summary).toBe('timed out');
  });
});

describe('github graphql', () => {
  it('builds one aliased query for all repos with owner and name as variables', () => {
    const query = buildQuery(queried(2));
    expect(query).toContain('repo0: repository(owner: $owner0, name: $name0)');
    expect(query).toContain('repo1: repository(owner: $owner1, name: $name1)');
    expect(
      buildVariables([
        { fullName: 'acme/a', failingEnvironments: [] },
        { fullName: 'acme/b', failingEnvironments: [] },
      ]),
    ).toEqual({
      owner0: 'acme',
      name0: 'a',
      owner1: 'acme',
      name1: 'b',
    });
  });

  it('does not ask for the default branch, which the tokens may not read', () => {
    expect(buildQuery(queried(1))).not.toContain('defaultBranchRef');
  });

  it('parses deployments and PRs, and spots my review request', () => {
    const [answer] = parseGitHubGraphql(githubGraphqlBody(), queried(1), MY_LOGINS);
    expect(answer?.error).toBeNull();
    expect(answer?.snapshot?.deployments).toHaveLength(3);
    expect(
      answer?.snapshot?.pullRequests.map((p) => [p.number, p.isReviewRequestedFromMe]),
    ).toEqual([
      [12, true],
      [13, false],
    ]);
  });

  it('turns an error about one repo into that repo, and keeps the others', () => {
    const body = githubGraphqlBody() as { data: Record<string, unknown>; errors?: unknown };
    body.data['repo1'] = null;
    body.errors = [
      { type: 'NOT_FOUND', path: ['repo1'], message: 'Could not resolve to a Repository' },
    ];
    const answers = parseGitHubGraphql(body, queried(2), MY_LOGINS);
    expect(answers[0]?.error).toBeNull();
    expect(answers[1]).toEqual({ snapshot: null, error: 'GraphQL NOT_FOUND' });
  });

  it('counts an error on one field of a repo, even when the rest of the repo came back', () => {
    // What a token without Contents permission got for defaultBranchRef: data, plus an error.
    const body = githubGraphqlBody() as { errors?: unknown };
    body.errors = [
      {
        type: 'FORBIDDEN',
        path: ['repo0', 'deployments'],
        message: 'Resource not accessible by personal access token',
      },
    ];
    expect(parseGitHubGraphql(body, queried(1), MY_LOGINS)).toEqual([
      { snapshot: null, error: 'GraphQL FORBIDDEN' },
    ]);
  });

  it('fails the whole call for an error that is not about one repo', () => {
    const body = { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit' }] };
    expect(() => parseGitHubGraphql(body, queried(1), MY_LOGINS)).toThrow('GraphQL RATE_LIMITED');
    expect(() =>
      parseGitHubGraphql({ errors: [{ message: 'Parse error on "x"' }] }, queried(1), MY_LOGINS),
    ).toThrow('GraphQL error');
  });

  it('reports a repo that is missing from the answer without an error entry', () => {
    expect(parseGitHubGraphql({ data: { repo0: null } }, queried(1), MY_LOGINS)).toEqual([
      { snapshot: null, error: 'not accessible' },
    ]);
  });

  it('rejects a body without data', () => {
    expect(() => parseGitHubGraphql({ message: 'Bad credentials' }, queried(1), MY_LOGINS)).toThrow(
      'invalid response',
    );
  });
});

describe('deployObservation', () => {
  const [answer] = parseGitHubGraphql(githubGraphqlBody(), queried(1), MY_LOGINS);
  const deployments = answer?.snapshot?.deployments ?? [];
  const production = (state: string, createdAt: string, environment = 'Production') => ({
    environment,
    createdAt,
    state,
    logUrl: null,
  });
  const observe = (
    list: Parameters<typeof deployObservation>[2],
    failing: Parameters<typeof deployObservation>[3] = [],
  ) => deployObservation(DEMO_PROJECT, 'acme/demo-app', list, failing, false);

  it('uses the newest Production deployment and ignores previews', () => {
    const observation = stateOf(
      deployObservation(DEMO_PROJECT, 'acme/demo-app', deployments, [], false),
    );
    expect(observation.status).toBe('ok');
    expect(observation.summary).toBe('Succeeded');
    expect(observation.at).toBe('2026-11-26T09:00:00Z');
    expect(observation.linkUrl).toBe('https://deploy.example.test/prod-2');
  });

  it('is a problem when a production environment failed', () => {
    const observation = stateOf(
      deployObservation(
        DEMO_PROJECT,
        'acme/demo-app',
        [
          {
            environment: 'Production - web',
            createdAt: '2026-11-26T09:00:00Z',
            state: 'FAILURE',
            logUrl: null,
          },
          {
            environment: 'Production - api',
            createdAt: '2026-11-26T08:00:00Z',
            state: 'SUCCESS',
            logUrl: null,
          },
        ],
        [],
        false,
      ),
    );
    expect(observation.status).toBe('problem');
    expect(observation.linkUrl).toBe('https://github.com/acme/demo-app/deployments');
  });

  it('is unknown while a deploy is running, and null with no production deploys', () => {
    const building = stateOf(
      deployObservation(
        DEMO_PROJECT,
        'acme/demo-app',
        [
          {
            environment: 'Production',
            createdAt: '2026-11-26T09:00:00Z',
            state: 'IN_PROGRESS',
            logUrl: null,
          },
        ],
        [],
        false,
      ),
    );
    expect(building.status).toBe('unknown');
    expect(
      deployObservation(
        DEMO_PROJECT,
        'acme/demo-app',
        [
          {
            environment: 'Preview',
            createdAt: '2026-11-26T09:00:00Z',
            state: 'SUCCESS',
            logUrl: null,
          },
        ],
        [],
        false,
      ),
    ).toBeNull();
  });

  it('holds what was known when production deploys scrolled out behind previews', () => {
    const previews = Array.from({ length: 30 }, (_, index) =>
      production('SUCCESS', `2026-11-26T09:${10 + index}:00Z`, 'Preview'),
    );
    // No Deploy check stored yet: nothing to report. One stored: it stands, and is not "gone".
    expect(deployObservation(DEMO_PROJECT, 'acme/demo-app', previews, [], false)).toBeNull();
    const held = stateOf(deployObservation(DEMO_PROJECT, 'acme/demo-app', previews, [], true));
    expect(held.status).toBe('unknown');
    expect(held.checkKey).toBe('deploy');
  });

  const failedProduction = { environment: 'Production', at: '2026-11-26T09:00:00Z', url: null };

  it('remembers which environment failed', () => {
    const observation = stateOf(observe([production('FAILURE', '2026-11-26T09:00:00Z')]));
    expect(observation.status).toBe('problem');
    expect(observation.memory).toEqual({ failing: [failedProduction] });
  });

  it('stays failed while the next deployment of that environment is still building', () => {
    const observation = stateOf(
      observe(
        [
          production('IN_PROGRESS', '2026-11-26T10:00:00Z'),
          production('FAILURE', '2026-11-26T09:00:00Z'),
        ],
        [failedProduction],
      ),
    );
    expect(observation.status).toBe('problem');
  });

  it('stays failed when the failed environment is no longer among the listed deployments', () => {
    const failedApi = { ...failedProduction, environment: 'Production - api' };
    const onlyWeb = [production('SUCCESS', '2026-11-26T11:00:00Z', 'Production - web')];
    expect(stateOf(observe(onlyWeb, [failedApi])).status).toBe('problem');
    // Not even when no production deployment is listed at all.
    expect(stateOf(observe([], [failedApi])).status).toBe('problem');
    expect(stateOf(observe([], [failedApi])).memory).toEqual({ failing: [failedApi] });
  });

  it('recovers when a newer deployment of that same environment succeeded', () => {
    const observation = stateOf(
      observe(
        [
          production('SUCCESS', '2026-11-26T10:00:00Z'),
          production('FAILURE', '2026-11-26T09:00:00Z'),
        ],
        [failedProduction],
      ),
    );
    expect(observation.status).toBe('ok');
    expect(observation.memory).toEqual({ failing: [] });
  });
});

describe('ciObservation', () => {
  const parse = (runs: Run[]) => parseWorkflowRuns(workflowRunsBody(runs), 'acme/demo-app');

  it('is null without any runs', () => {
    expect(ciObservation(DEMO_PROJECT, [], [])).toBeNull();
  });

  it('is green when the latest finished run of every workflow succeeded', () => {
    const observation = stateOf(
      ciObservation(
        DEMO_PROJECT,
        parse([
          run({}),
          run({ conclusion: 'failure', at: '2026-11-25T10:00:00Z' }),
          run({ workflow: 2, name: 'Nightly', at: '2026-11-26T03:00:00Z' }),
        ]),
        [],
      ),
    );
    expect(observation.status).toBe('ok');
    expect(observation.summary).toBe('Passing (2 workflows)');
  });

  it('is red when any workflow latest run failed, linking to that run', () => {
    const observation = stateOf(
      ciObservation(
        DEMO_PROJECT,
        parse([run({}), run({ workflow: 2, name: 'Nightly', conclusion: 'timed_out' })]),
        [],
      ),
    );
    expect(observation.status).toBe('problem');
    expect(observation.summary).toBe('Failing: Nightly');
    expect(observation.linkUrl).toContain('/actions/runs/2');
  });

  it('skips running and cancelled runs and uses the earlier finished one', () => {
    const observation = stateOf(
      ciObservation(
        DEMO_PROJECT,
        parse([
          run({ status: 'in_progress', conclusion: null, at: '2026-11-26T11:00:00Z' }),
          run({ conclusion: 'cancelled' }),
          run({ conclusion: 'failure', at: '2026-11-26T09:00:00Z' }),
        ]),
        [],
      ),
    );
    expect(observation.status).toBe('problem');
  });

  it('is unknown when nothing has finished yet', () => {
    const observation = stateOf(
      ciObservation(DEMO_PROJECT, parse([run({ status: 'queued', conclusion: null })]), []),
    );
    expect(observation.status).toBe('unknown');
  });

  it('rejects a body that is not a runs list', () => {
    expect(() => parseWorkflowRuns({ message: 'Not Found' }, 'acme/demo-app')).toThrow(
      'invalid response',
    );
  });

  it('leaves out runs of pull requests from forks, which the branch filter returns too', () => {
    const body = recentRunsBody('acme/demo-app', [
      { ...run({ id: 1, conclusion: 'failure' }), branch: 'main', headRepo: 'someone/demo-app' },
      { ...run({ id: 2 }), branch: 'main', headRepo: 'Acme/Demo-App' },
      { ...run({ id: 3, conclusion: 'failure' }), branch: 'main' },
    ]) as { workflow_runs: Record<string, unknown>[] };
    // A fork that was deleted since.
    body.workflow_runs.push({ ...body.workflow_runs[0], id: 4, head_repository: null });
    expect(parseWorkflowRuns(body, 'acme/demo-app').map((item) => item.id)).toEqual([2, 3]);
  });

  describe('a workflow that was failing', () => {
    const failedAt = '2026-11-26T10:00:00Z';
    const olderSuccess = run({ id: 6, at: '2026-11-25T10:00:00Z' });
    const observeRuns = (runs: Run[], failing = FAILING) =>
      stateOf(ciObservation(DEMO_PROJECT, parse(runs), failing));
    const FAILING = [
      {
        workflowId: 1,
        name: 'CI',
        runId: 7,
        at: failedAt,
        url: 'https://github.test/acme/demo-app/actions/runs/7',
      },
    ];

    it('is remembered when it fails', () => {
      const observation = observeRuns([run({ id: 7, conclusion: 'failure', at: failedAt })], []);
      expect(observation.status).toBe('problem');
      expect(observation.memory).toEqual({ failing: FAILING });
    });

    it('stays red while the failed run is being re-run, despite an older success', () => {
      const observation = observeRuns([
        run({ id: 7, status: 'in_progress', conclusion: null, at: failedAt }),
        olderSuccess,
      ]);
      expect(observation.status).toBe('problem');
      expect(observation.summary).toBe('Failing: CI');
      expect(observation.memory).toEqual({ failing: FAILING });
    });

    it('stays red when it has dropped out of the recent runs', () => {
      const others = Array.from({ length: 15 }, (_, index) =>
        run({
          id: 100 + index,
          workflow: 2,
          name: 'Deploy',
          at: `2026-11-26T11:${10 + index}:00Z`,
        }),
      );
      const observation = observeRuns(others);
      expect(observation.status).toBe('problem');
      expect(observation.summary).toBe('Failing: CI');
      // Not even when the repo lists no runs at all.
      expect(observeRuns([]).status).toBe('problem');
    });

    it('stays red while a newer run of it is in progress or was cancelled', () => {
      const failed = run({ id: 7, conclusion: 'failure', at: failedAt });
      const newer = { id: 8, at: '2026-11-26T11:00:00Z' };
      expect(
        observeRuns([run({ ...newer, status: 'in_progress', conclusion: null }), failed]).status,
      ).toBe('problem');
      expect(observeRuns([run({ ...newer, conclusion: 'cancelled' }), failed]).status).toBe(
        'problem',
      );
    });

    it('goes green when a newer run of the same workflow succeeds', () => {
      const observation = observeRuns([
        run({ id: 8, at: '2026-11-26T11:00:00Z' }),
        run({ id: 7, conclusion: 'failure', at: failedAt }),
      ]);
      expect(observation.status).toBe('ok');
      expect(observation.memory).toEqual({ failing: [] });
    });

    it('goes green when the failed run itself succeeds on a re-run', () => {
      expect(observeRuns([run({ id: 7, at: failedAt }), olderSuccess]).status).toBe('ok');
    });

    it('is not cleared by another workflow succeeding', () => {
      const observation = observeRuns([
        run({ id: 9, workflow: 2, name: 'Deploy', at: '2026-11-26T11:00:00Z' }),
      ]);
      expect(observation.status).toBe('problem');
    });

    it('ignores stored state that is not in the expected shape', () => {
      expect(readFailingWorkflows([{ workflowId: 'x' }, null, 'text'])).toEqual([]);
      expect(readFailingWorkflows(undefined)).toEqual([]);
      expect(readFailingEnvironments([{ environment: 'Production' }, 3])).toEqual([]);
    });
  });
});

describe('fetchGitHub', () => {
  const runsBody = workflowRunsBody([run({})]);

  it('makes one GraphQL call plus one REST call per repo, only to GitHub, with the token', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetcher: Fetcher = (url, init) => {
      calls.push({ url, auth: new Headers(init?.headers).get('Authorization') });
      return Promise.resolve(url.endsWith('/graphql') ? json(githubGraphqlBody()) : json(runsBody));
    };
    const result = await fetchGitHub(
      fetcher,
      'secret-token',
      PERSONAL_OWNER,
      TEST_PROJECTS,
      new Map(),
    );
    expect(result.error).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url.startsWith('https://api.github.com/'))).toBe(true);
    expect(calls.every((call) => call.auth === 'Bearer secret-token')).toBe(true);
    expect(calls[1]?.url).toContain('/repos/acme/demo-app/actions/runs?branch=main');
    expect(result.observations.map((o) => (o.type === 'state' ? o.checkKey : o.type))).toEqual([
      'pull_requests',
      'deploy',
      'ci',
    ]);
  });

  it('reports a rejected token as HTTP 401 without anything else leaking', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(json({ message: 'Bad credentials secret-token' }, 401));
    const result = await fetchGitHub(fetcher, 'secret-token', WORK_OWNER, TEST_PROJECTS, new Map());
    expect(result).toMatchObject({ source: 'github:work', error: 'HTTP 401', observations: [] });
  });

  it('keeps the other observations when an actions call fails, and reports the error', async () => {
    const fetcher: Fetcher = (url) =>
      Promise.resolve(
        url.endsWith('/graphql') ? json(githubGraphqlBody()) : json({ message: 'nope' }, 403),
      );
    const result = await fetchGitHub(fetcher, 't', PERSONAL_OWNER, TEST_PROJECTS, new Map());
    expect(result.error).toBe('acme/demo-app: HTTP 403');
    expect(result.observations.map((o) => o.type)).toEqual(['pull_requests', 'state']);
  });

  it('names each failing repo, and still reports the repos that worked', async () => {
    const second = {
      ...OTHER_PROJECT,
      github: { ...DEMO_PROJECT.github, fullName: 'acme/second' },
    } as typeof OTHER_PROJECT;
    const third = { ...second, id: 'third', github: { ...second.github, fullName: 'acme/third' } };
    const graphql = githubGraphqlBody() as { data: Record<string, unknown> };
    graphql.data['repo1'] = { deployments: { nodes: [] }, pullRequests: { nodes: [] } };
    graphql.data['repo2'] = { deployments: { nodes: [] }, pullRequests: { nodes: [] } };
    const fetcher: Fetcher = (url) => {
      if (url.endsWith('/graphql')) return Promise.resolve(json(graphql));
      if (url.includes('/acme/demo-app/')) return Promise.resolve(json(runsBody));
      return Promise.resolve(json({}, url.includes('/acme/second/') ? 404 : 500));
    };
    const result = await fetchGitHub(
      fetcher,
      't',
      PERSONAL_OWNER,
      [DEMO_PROJECT, second, third] as typeof TEST_PROJECTS,
      new Map(),
    );
    expect(result.error).toBe('acme/second: HTTP 404 (and 1 more)');
    const checks = result.observations.map((o) =>
      o.type === 'state' ? `${o.projectId}:${o.checkKey}` : `${o.projectId}:prs`,
    );
    expect(checks).toContain('demo:ci');
    expect(checks).toContain('other:prs');
    expect(checks).toContain('third:prs');
  });

  it('still checks CI on the configured branch when GraphQL has an error for the repo', async () => {
    const graphql = {
      data: { repo0: { deployments: null, pullRequests: { nodes: [] } } },
      errors: [{ type: 'FORBIDDEN', path: ['repo0', 'deployments'], message: 'not accessible' }],
    };
    const urls: string[] = [];
    const fetcher: Fetcher = (url) => {
      urls.push(url);
      return Promise.resolve(url.endsWith('/graphql') ? json(graphql) : json(runsBody));
    };
    const result = await fetchGitHub(fetcher, 't', PERSONAL_OWNER, TEST_PROJECTS, new Map());
    expect(result.error).toBe('acme/demo-app: GraphQL FORBIDDEN');
    expect(urls[1]).toContain('/repos/acme/demo-app/actions/runs?branch=main');
    expect(result.observations.map((o) => (o.type === 'state' ? o.checkKey : o.type))).toEqual([
      'ci',
    ]);
  });

  it('gets back the failing workflows it stored in the CI check last run', async () => {
    const fetcher: Fetcher = (url) => {
      if (url.endsWith('/graphql')) return Promise.resolve(json(githubGraphqlBody()));
      if (url.includes('/actions/workflows/')) return Promise.resolve(json({ state: 'active' }));
      return Promise.resolve(json(workflowRunsBody([run({ id: 6, at: '2026-11-25T10:00:00Z' })])));
    };
    const failing = [
      { workflowId: 1, name: 'CI', runId: 7, at: '2026-11-26T10:00:00Z', url: 'https://x.test/7' },
    ];
    const previous = new Map([
      [
        'demo|ci',
        {
          projectId: 'demo',
          checkKey: 'ci',
          status: 'problem' as const,
          consecutiveFailures: 1,
          summary: 'Failing: CI',
          linkUrl: null,
          detail: { failing },
          problemSince: '2026-11-26T10:05:00.000Z',
        },
      ],
    ]);
    const result = await fetchGitHub(fetcher, 't', PERSONAL_OWNER, TEST_PROJECTS, previous);
    const ci = result.observations
      .map((o) => (o.type === 'state' ? o : null))
      .find((o) => o?.checkKey === 'ci');
    expect(ci?.status).toBe('problem');
  });

  describe('a workflow held red with no recent runs', () => {
    const failing = [
      { workflowId: 1, name: 'Nightly', runId: 7, at: '2026-11-20T03:00:00Z', url: 'https://x' },
    ];
    const previous = new Map([['demo|ci', storedCheck('ci', { failing })]]);
    // Only another workflow has recent runs.
    const otherRuns = workflowRunsBody([run({ id: 20, workflow: 2, name: 'Deploy' })]);

    async function observeCi(workflowAnswer: () => Response, runs: unknown = otherRuns) {
      const urls: string[] = [];
      const fetcher: Fetcher = (url) => {
        urls.push(url);
        if (url.endsWith('/graphql')) return Promise.resolve(json(githubGraphqlBody()));
        if (url.includes('/actions/workflows/')) return Promise.resolve(workflowAnswer());
        return Promise.resolve(json(runs));
      };
      const result = await fetchGitHub(fetcher, 't', PERSONAL_OWNER, TEST_PROJECTS, previous);
      const ci = result.observations.flatMap((o) =>
        o.type === 'state' && o.checkKey === 'ci' ? [o] : [],
      )[0];
      return { result, ci, lookups: urls.filter((url) => url.includes('/actions/workflows/')) };
    }

    it('stays red while the workflow still exists', async () => {
      const { ci, lookups } = await observeCi(() => json({ id: 1, state: 'active' }));
      expect(lookups).toEqual(['https://api.github.com/repos/acme/demo-app/actions/workflows/1']);
      expect(ci?.status).toBe('problem');
    });

    it('is forgotten when the workflow was deleted', async () => {
      const { result, ci } = await observeCi(() => json({ message: 'Not Found' }, 404));
      expect(result.error).toBeNull();
      expect(ci?.status).toBe('ok');
      expect(ci?.memory).toEqual({ failing: [] });
    });

    it('is forgotten when its file was removed or it was disabled', async () => {
      expect((await observeCi(() => json({ id: 1, state: 'deleted' }))).ci?.status).toBe('ok');
      expect((await observeCi(() => json({ id: 1, state: 'disabled_manually' }))).ci?.status).toBe(
        'ok',
      );
    });

    it('stays red, and the repo is reported, when the lookup itself fails', async () => {
      const { result } = await observeCi(() => json({}, 500));
      expect(result.error).toBe('acme/demo-app: HTTP 500');
      // No CI observation: the stored row, still red, is kept.
      expect(result.observations.some((o) => o.type === 'state' && o.checkKey === 'ci')).toBe(
        false,
      );
    });

    it('is not looked up while it has a run newer than the failure', async () => {
      const inProgress = workflowRunsBody([
        run({ id: 8, status: 'in_progress', conclusion: null }),
      ]);
      const { ci, lookups } = await observeCi(() => json({}, 500), inProgress);
      expect(lookups).toEqual([]);
      expect(ci?.status).toBe('problem');
    });

    // A repo with one workflow: its failed run stays the newest run for as long as nothing runs.
    const failedRunStillListed = workflowRunsBody([
      run({ id: 7, name: 'Nightly', conclusion: 'failure', at: '2026-11-20T03:00:00Z' }),
    ]);

    it('is looked up when its failed run is still the newest, and stays red while active', async () => {
      const { ci, lookups } = await observeCi(
        () => json({ state: 'active' }),
        failedRunStillListed,
      );
      expect(lookups).toHaveLength(1);
      expect(ci?.status).toBe('problem');
    });

    it('is forgotten when deleted, even with its failed run still among the recent runs', async () => {
      const { ci } = await observeCi(() => json({ state: 'deleted' }), failedRunStillListed);
      // Its runs were the only ones. The check stays, to remember that the workflow is gone.
      expect(ci?.status).toBe('ok');
      expect(ci?.memory).toEqual({
        failing: [],
        gone: [{ workflowId: 1, at: '2026-11-20T03:00:00Z' }],
      });
      const withOther = workflowRunsBody([
        run({ id: 7, name: 'Nightly', conclusion: 'failure', at: '2026-11-20T03:00:00Z' }),
        run({ id: 20, workflow: 2, name: 'Deploy' }),
      ]);
      expect((await observeCi(() => json({}, 404), withOther)).ci?.status).toBe('ok');
    });

    describe('once found gone', () => {
      const gone = [{ workflowId: 1, at: '2026-11-20T03:00:00Z' }];
      const failedRun = run({
        id: 7,
        name: 'Nightly',
        conclusion: 'failure',
        at: '2026-11-20T03:00:00Z',
      });
      const otherRun = run({ id: 20, workflow: 2, name: 'Deploy' });

      async function observeStored(runs: Run[]) {
        const lookups: string[] = [];
        const fetcher: Fetcher = (url) => {
          if (url.endsWith('/graphql')) return Promise.resolve(json(githubGraphqlBody()));
          if (url.includes('/actions/workflows/')) {
            lookups.push(url);
            return Promise.resolve(json({ state: 'active' }));
          }
          return Promise.resolve(json(workflowRunsBody(runs)));
        };
        const stored = new Map([['demo|ci', storedCheck('ci', { failing: [], gone })]]);
        const result = await fetchGitHub(fetcher, 't', PERSONAL_OWNER, TEST_PROJECTS, stored);
        const ci = result.observations.flatMap((o) =>
          o.type === 'state' && o.checkKey === 'ci' ? [o] : [],
        )[0];
        return { ci, lookups };
      }

      it('is left out next run without another lookup, its failed run still listed', async () => {
        const { ci, lookups } = await observeStored([failedRun, otherRun]);
        expect(lookups).toEqual([]);
        expect(ci?.status).toBe('ok');
        expect(ci?.memory).toEqual({ failing: [], gone });
      });

      it('is no longer remembered when its runs have left the recent runs', async () => {
        const { ci } = await observeStored([otherRun]);
        expect(ci?.status).toBe('ok');
        expect(ci?.memory).toEqual({ failing: [] });
      });

      it('counts again when it shows up with a new run (re-enabled or recreated)', async () => {
        const again = { id: 30, name: 'Nightly', at: '2026-11-26T03:00:00Z' };
        const failedAgain = await observeStored([
          run({ ...again, conclusion: 'failure' }),
          failedRun,
          otherRun,
        ]);
        expect(failedAgain.ci?.status).toBe('problem');
        expect(failedAgain.ci?.summary).toBe('Failing: Nightly');
        expect(failedAgain.ci?.memory?.['gone']).toBeUndefined();

        const passing = await observeStored([run(again), failedRun, otherRun]);
        expect(passing.ci?.status).toBe('ok');
        expect(passing.ci?.summary).toBe('Passing (2 workflows)');
        expect(passing.ci?.memory).toEqual({ failing: [] });
      });

      it('ignores stored state that is not in the expected shape', () => {
        expect(readGoneWorkflows([{ workflowId: 1 }, 'x', null])).toEqual([]);
        expect(readGoneWorkflows(undefined)).toEqual([]);
      });
    });

    // The two ways out that docs/limits.md gives for a deleted workflow stuck red.
    it('is forgotten once a newer cancelled run of it is no longer among the recent runs', async () => {
      const cancelled = run({ id: 9, name: 'Nightly', conclusion: 'cancelled' });
      const failed = run({
        id: 7,
        name: 'Nightly',
        conclusion: 'failure',
        at: '2026-11-20T03:00:00Z',
      });
      const other = run({ id: 20, workflow: 2, name: 'Deploy' });
      const gone = () => json({}, 404);

      // Stuck: the cancelled run is newer than the failure, so the workflow is not looked up.
      const stuck = await observeCi(gone, workflowRunsBody([cancelled, failed, other]));
      expect(stuck.lookups).toEqual([]);
      expect(stuck.ci?.status).toBe('problem');

      // The cancelled run was deleted in GitHub Actions (or pushed out by newer runs).
      const cleared = await observeCi(gone, workflowRunsBody([failed, other]));
      expect(cleared.lookups).toHaveLength(1);
      expect(cleared.ci?.status).toBe('ok');
    });

    it('is forgotten once few enough workflows are failing for it to get a lookup', async () => {
      const held = (count: number) =>
        Array.from({ length: count }, (_, index) => ({ ...failing[0], workflowId: 100 + index }));
      const observeHeld = async (count: number, deletedId: number) => {
        const stored = new Map([['demo|ci', storedCheck('ci', { failing: held(count) })]]);
        const fetcher: Fetcher = (url) => {
          if (url.endsWith('/graphql')) return Promise.resolve(json(githubGraphqlBody()));
          if (!url.includes('/actions/workflows/')) return Promise.resolve(json(otherRuns));
          return Promise.resolve(
            url.endsWith(`/${deletedId}`) ? json({}, 404) : json({ state: 'active' }),
          );
        };
        const result = await fetchGitHub(fetcher, 't', PERSONAL_OWNER, TEST_PROJECTS, stored);
        const ci = result.observations.flatMap((o) =>
          o.type === 'state' && o.checkKey === 'ci' ? [o] : [],
        )[0];
        return readFailingWorkflows(ci?.memory?.['failing']).map((item) => item.workflowId);
      };
      // Seven failing, the deleted one last in line: past the cap, it stays.
      expect(await observeHeld(7, 106)).toContain(106);
      // Two others fixed: it is now among the five looked up, and goes.
      expect(await observeHeld(5, 104)).not.toContain(104);
    });

    it('makes at most MAX_WORKFLOW_LOOKUPS lookups per token per run', async () => {
      const many = Array.from({ length: MAX_WORKFLOW_LOOKUPS + 3 }, (_, index) => ({
        ...failing[0],
        workflowId: 100 + index,
      }));
      const stored = new Map([['demo|ci', storedCheck('ci', { failing: many })]]);
      let lookups = 0;
      const fetcher: Fetcher = (url) => {
        if (url.endsWith('/graphql')) return Promise.resolve(json(githubGraphqlBody()));
        if (!url.includes('/actions/workflows/')) return Promise.resolve(json(otherRuns));
        lookups += 1;
        return Promise.resolve(json({}, 404));
      };
      const result = await fetchGitHub(fetcher, 't', PERSONAL_OWNER, TEST_PROJECTS, stored);
      expect(lookups).toBe(MAX_WORKFLOW_LOOKUPS);
      // The ones not looked up this run are still held, for a later run.
      const ci = result.observations.flatMap((o) =>
        o.type === 'state' && o.checkKey === 'ci' ? [o] : [],
      )[0];
      expect((ci?.memory?.['failing'] as unknown[]).length).toBe(3);
    });
  });

  describe('a deploy environment held red', () => {
    const failing = [{ environment: 'Production - api', at: '2026-11-20T09:00:00Z', url: null }];
    const previous = new Map([['demo|deploy', storedCheck('deploy', { failing })]]);

    async function observeDeploy(heldNodes: unknown[]) {
      const bodies: { query: string; variables: Record<string, string> }[] = [];
      const graphql = githubGraphqlBody() as { data: { repo0: Record<string, unknown> } };
      graphql.data.repo0['held0'] = { nodes: heldNodes };
      const fetcher: Fetcher = (url, init) => {
        if (!url.endsWith('/graphql')) return Promise.resolve(json(runsBody));
        bodies.push(
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as (typeof bodies)[number],
        );
        return Promise.resolve(json(graphql));
      };
      const result = await fetchGitHub(fetcher, 't', PERSONAL_OWNER, TEST_PROJECTS, previous);
      const deploy = result.observations.flatMap((o) =>
        o.type === 'state' && o.checkKey === 'deploy' ? [o] : [],
      )[0];
      return { deploy, bodies };
    }
    const newest = (state: string) => ({
      environment: 'Production - api',
      createdAt: '2026-11-20T09:00:00Z',
      latestStatus: { state, logUrl: null },
    });

    it('is asked for by name in the same GraphQL call', async () => {
      const { bodies } = await observeDeploy([newest('FAILURE')]);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.query).toContain('held0: deployments(first: 1, environments: [$env0_0]');
      expect(bodies[0]?.variables['env0_0']).toBe('Production - api');
    });

    it('stays red while its newest deployment is the failed one, however old', async () => {
      // The fixture's 30 recent deployments are all of other environments.
      expect((await observeDeploy([newest('FAILURE')])).deploy?.status).toBe('problem');
    });

    it('is forgotten when the environment has no deployments left', async () => {
      const { deploy } = await observeDeploy([]);
      expect(deploy?.status).toBe('ok');
      expect(deploy?.memory).toEqual({ failing: [] });
    });

    it('recovers when its newest deployment succeeded', async () => {
      expect((await observeDeploy([newest('SUCCESS')])).deploy?.status).toBe('ok');
    });
  });

  it('does not follow redirects on calls that carry the token', async () => {
    const modes: (string | undefined)[] = [];
    const fetcher: Fetcher = (url, init) => {
      modes.push(init?.redirect);
      return Promise.resolve(url.endsWith('/graphql') ? json(githubGraphqlBody()) : json(runsBody));
    };
    await fetchGitHub(fetcher, 't', PERSONAL_OWNER, TEST_PROJECTS, new Map());
    await fetchSupabase(fetcher, 't', TEST_PROJECTS);
    await fetchCloudflare(fetcher, 't', MAIN_ACCOUNT, TEST_PROJECTS, new Date(), new Map());
    expect(modes).toHaveLength(5);
    // 'manual', never 'error': the Workers runtime rejects 'error' and the call would throw.
    expect(modes.every((mode) => mode === 'manual')).toBe(true);
  });

  it('reports a redirect answer as a failure instead of following it', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(new Response(null, { status: 302, headers: { Location: 'https://x.test' } }));
    const result = await fetchSupabase(fetcher, 't', TEST_PROJECTS);
    expect(result.error).toBe('HTTP 302');
  });

  it('does not call the API for a token with no repos', async () => {
    const fetcher: Fetcher = () => Promise.reject(new Error('should not be called'));
    const result = await fetchGitHub(fetcher, 't', PERSONAL_OWNER, [OTHER_PROJECT], new Map());
    expect(result.error).toBeNull();
    expect(result.observations).toEqual([]);
  });

  it('reports a repo the token cannot read', async () => {
    const fetcher: Fetcher = () => Promise.resolve(json({ data: { repo0: null } }));
    const result = await fetchGitHub(fetcher, 't', PERSONAL_OWNER, TEST_PROJECTS, new Map());
    expect(result.error).toBe('acme/demo-app: not accessible');
  });

  it('reports a timeout', async () => {
    const fetcher: Fetcher = () => Promise.reject(new DOMException('slow', 'TimeoutError'));
    const result = await fetchGitHub(fetcher, 't', PERSONAL_OWNER, TEST_PROJECTS, new Map());
    expect(result.error).toBe('timed out');
  });
});

describe('supabase', () => {
  it('turns status into problems, ok, and unassigned projects', () => {
    const observations = parseSupabaseProjects(supabaseBody(), TEST_PROJECTS).map(stateOf);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      projectId: 'demo',
      checkKey: 'supabase:abcdefghijklmnopqrst',
      status: 'problem',
      summary: 'INACTIVE (paused)',
      linkUrl: 'https://supabase.com/dashboard/project/abcdefghijklmnopqrst',
    });
    expect(observations[1]).toMatchObject({
      projectId: 'unassigned',
      subject: 'stray-project',
      status: 'ok',
    });
  });

  it('is unknown for a registered project the token cannot see', () => {
    const observations = parseSupabaseProjects([], TEST_PROJECTS).map(stateOf);
    expect(observations[0]?.status).toBe('unknown');
  });

  it('rejects a body that is not a list', () => {
    expect(() => parseSupabaseProjects({ message: 'x' }, TEST_PROJECTS)).toThrow(
      'invalid response',
    );
  });

  it('makes one request with the token, only to Supabase', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = (url, init) => {
      calls.push(`${url} ${new Headers(init?.headers).get('Authorization')}`);
      return Promise.resolve(json(supabaseBody()));
    };
    const result = await fetchSupabase(fetcher, 'sb-token', TEST_PROJECTS);
    expect(calls).toEqual(['https://api.supabase.com/v1/projects Bearer sb-token']);
    expect(result.error).toBeNull();
  });

  it('reports a rejected token', async () => {
    const result = await fetchSupabase(() => Promise.resolve(json({}, 401)), 't', TEST_PROJECTS);
    expect(result.error).toBe('HTTP 401');
  });
});

describe('cloudflare', () => {
  const NOW = new Date('2026-11-26T12:00:00Z');

  it('sums traffic per script and counts non-success statuses as errors', () => {
    const traffic = parseAnalytics(
      analyticsBody([
        { script: 'demo-worker', status: 'success', requests: 90 },
        { script: 'demo-worker', status: 'scriptThrewException', requests: 8 },
        { script: 'demo-worker', status: 'clientDisconnected', requests: 2 },
        { script: 'demo-worker', status: 'exceededResources', requests: 1 },
      ]),
    );
    expect(traffic.get('demo-worker')).toEqual({ requests: 101, errors: 9, resourceErrors: 1 });
  });

  it('reads script modified times', () => {
    expect(parseScriptList(scriptListBody()).get('demo-quiet')).toBe('2026-10-01T08:00:00.000000Z');
  });

  it('skips a script without a modified time instead of failing', () => {
    const times = parseScriptList({ result: [{ id: 'no-time' }, { id: 'x', modified_on: 'T' }] });
    expect([...times.keys()]).toEqual(['x']);
  });

  const stored = (status: 'ok' | 'problem', isOverThreshold: boolean): PreviousCheck => ({
    projectId: 'demo',
    checkKey: 'worker:demo-worker',
    status,
    consecutiveFailures: 0,
    summary: '',
    linkUrl: null,
    detail: { isOverThreshold },
    problemSince: null,
  });
  const judge = (
    previous: PreviousCheck | undefined,
    requests: number,
    errors: number,
    resourceErrors = 0,
  ) =>
    workerObservation(
      DEMO_PROJECT,
      'demo-worker',
      'a'.repeat(32),
      { requests, errors, resourceErrors },
      null,
      previous,
    );

  it('applies the threshold: over 5% with at least 20 requests, or any resource error', () => {
    const reading = (requests: number, errors: number, resourceErrors = 0) =>
      judge(undefined, requests, errors, resourceErrors).memory?.['isOverThreshold'];
    expect(reading(100, 6)).toBe(true);
    expect(reading(100, 5)).toBe(false);
    expect(reading(10, 10)).toBe(false);
    expect(reading(0, 0)).toBe(false);
    expect(reading(3, 1, 1)).toBe(true);
  });

  it('becomes a problem only after two runs in a row over the threshold', () => {
    expect(judge(undefined, 100, 50).status).toBe('ok');
    expect(judge(stored('ok', false), 100, 50).status).toBe('ok');
    expect(judge(stored('ok', true), 100, 50).status).toBe('problem');
  });

  it('recovers only after two runs in a row under the threshold', () => {
    expect(judge(stored('problem', true), 100, 0).status).toBe('problem');
    expect(judge(stored('problem', false), 100, 0).status).toBe('ok');
  });

  it('does not flap when traffic hovers around the 20-request minimum', () => {
    // 20 requests (over), 19 (under), 20, 19, ... with every request failing.
    let previous = stored('ok', false);
    for (const requests of [20, 19, 20, 19, 20, 19]) {
      const observation = judge(previous, requests, requests);
      expect(observation.status).toBe('ok');
      previous = stored('ok', observation.memory?.['isOverThreshold'] === true);
    }
  });

  it('makes two requests per account, only to Cloudflare, one observation per script', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = (url) => {
      calls.push(url);
      return Promise.resolve(
        url.endsWith('/graphql')
          ? json(analyticsBody([{ script: 'demo-worker', status: 'success', requests: 50 }]))
          : json(scriptListBody()),
      );
    };
    const result = await fetchCloudflare(
      fetcher,
      'cf-token',
      MAIN_ACCOUNT,
      TEST_PROJECTS,
      NOW,
      new Map(),
    );
    expect(result.error).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls.every((url) => url.startsWith('https://api.cloudflare.com/client/v4/'))).toBe(
      true,
    );
    const observations = result.observations.map(stateOf);
    expect(observations.map((o) => [o.label, o.status, o.at])).toEqual([
      ['demo-worker', 'ok', '2026-11-20T08:00:00.000000Z'],
      ['demo-quiet', 'ok', '2026-10-01T08:00:00.000000Z'],
    ]);
    expect(observations[1]?.summary).toBe('No requests in 30 min');
  });

  it('fails the source when analytics is rejected, and keeps going when only the list fails', async () => {
    const rejected = await fetchCloudflare(
      () => Promise.resolve(json({}, 403)),
      't',
      MAIN_ACCOUNT,
      TEST_PROJECTS,
      NOW,
      new Map(),
    );
    expect(rejected).toMatchObject({ error: 'HTTP 403', observations: [] });

    const fetcher: Fetcher = (url) =>
      Promise.resolve(url.endsWith('/graphql') ? json(analyticsBody([])) : json({}, 500));
    const partial = await fetchCloudflare(
      fetcher,
      't',
      MAIN_ACCOUNT,
      TEST_PROJECTS,
      NOW,
      new Map(),
    );
    expect(partial.error).toBe('HTTP 500');
    expect(partial.observations).toHaveLength(2);
  });

  it('treats GraphQL errors as a failure', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(json({ data: null, errors: [{ message: 'denied' }] }));
    const result = await fetchCloudflare(fetcher, 't', MAIN_ACCOUNT, TEST_PROJECTS, NOW, new Map());
    expect(result.error).toBe('GraphQL error');
  });

  it('does nothing for an account without scripts', async () => {
    const never: Fetcher = () => Promise.reject(new Error('should not be called'));
    const none = await fetchCloudflare(never, 't', SPARE_ACCOUNT, TEST_PROJECTS, NOW, new Map());
    expect(none).toMatchObject({ source: 'cloudflare:spare', error: null, observations: [] });
  });

  it('asks about the account the scripts are registered on', async () => {
    const urls: string[] = [];
    const fetcher: Fetcher = (url) => {
      urls.push(url);
      return Promise.resolve(
        url.endsWith('/graphql') ? json(analyticsBody([])) : json(scriptListBody()),
      );
    };
    const projects = [{ ...DEMO_PROJECT, cloudflare: { accountKey: 'client', scripts: ['x'] } }];
    await fetchCloudflare(fetcher, 't', CLIENT_ACCOUNT, projects, NOW, new Map());
    expect(urls[1]).toContain('/accounts/22222222222222222222222222222222/workers/scripts');
  });
});
