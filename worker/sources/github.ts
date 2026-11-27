// GitHub, per token. What a read-only fine-grained token can read, from GitHub's permission
// list for fine-grained tokens:
//   Metadata (always), Actions: read, Deployments: read, Pull requests: read.
// There is no "Checks" permission for fine-grained tokens, so check runs (and the GraphQL
// statusCheckRollup, which includes them) are not used. CI state comes from the Actions
// workflow runs instead, which only REST offers: one GraphQL call per token for deployments
// and PRs, then one REST call per repo (plus, rarely, a lookup of a workflow that is held red
// and has no recent runs). The default branch comes from the config: reading it
// from the API needs Contents permission, which the tokens do not have.

import type {
  Observation,
  PullRequestObservation,
  SourceResult,
  StateObservation,
} from '../observations.ts';
import {
  githubLabel,
  githubSource,
  MAX_WORKFLOW_LOOKUPS,
  type GitHubOwner,
  type Project,
} from '../config.ts';
import { checkStateKey, type PreviousCheck } from '../transitions.ts';
import {
  fetchJson,
  isRecord,
  readArray,
  readNumber,
  readRecord,
  readString,
  safeErrorMessage,
  SourceError,
  type Fetcher,
} from './http.ts';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const MAX_DEPLOYMENTS = 30;
const MAX_PULL_REQUESTS = 30;
const MAX_WORKFLOW_RUNS = 15;
const CI_CHECK_KEY = 'ci';
const DEPLOY_CHECK_KEY = 'deploy';

interface WatchedRepo {
  project: Project;
  fullName: string;
  defaultBranch: string;
  watchDeployments: boolean;
  /** What the last run stored: empty unless something was failing. */
  failingWorkflows: FailingWorkflow[];
  goneWorkflows: GoneWorkflow[];
  failingEnvironments: FailingEnvironment[];
  /** Whether a Deploy check is stored for the repo. */
  hasDeployCheck: boolean;
}

export interface Deployment {
  environment: string;
  createdAt: string;
  state: string | null;
  logUrl: string | null;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
}

/**
 * A workflow whose last finished run failed. Remembered in the CI check's detail_json until a
 * newer run of the same workflow succeeds, because the list of recent runs alone forgets it:
 * the failed run scrolls out of the list, or goes back to "in progress" when it is re-run.
 */
export interface FailingWorkflow {
  workflowId: number;
  name: string;
  runId: number;
  at: string;
  url: string;
}

/**
 * A workflow that was looked up and found deleted or switched off, while runs of it are still
 * among the recent ones. Remembered in the CI check's detail_json so those runs are left out
 * from then on without another lookup. `at` is its newest run at that moment: a run newer than
 * that means the workflow is back, and it is forgotten here.
 */
export interface GoneWorkflow {
  workflowId: number;
  at: string;
}

/** A production environment whose last finished deployment failed; remembered the same way. */
export interface FailingEnvironment {
  environment: string;
  at: string;
  url: string | null;
}

interface RepoSnapshot {
  deployments: Deployment[];
  /**
   * The newest deployment of each environment that was failing, asked for by name because it
   * may no longer be among the recent deployments. An environment that has none left is gone.
   */
  heldDeployments: Deployment[];
  pullRequests: PullRequestObservation[];
}

/** What the batched query said about one repo: its data, or a short reason why there is none. */
export type RepoAnswer =
  { snapshot: RepoSnapshot; error: null } | { snapshot: null; error: string };

const NOT_ACCESSIBLE = 'not accessible';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'stackhush',
  };
}

/** The repos of one owner among the given projects, read with that owner's token. */
export async function fetchGitHub(
  fetcher: Fetcher,
  token: string,
  owner: GitHubOwner,
  projects: readonly Project[],
  previous: ReadonlyMap<string, PreviousCheck>,
): Promise<SourceResult> {
  const source = githubSource(owner.key);
  const label = githubLabel(owner);
  const detailOf = (project: Project, checkKey: string): Record<string, unknown> =>
    previous.get(checkStateKey(project.id, checkKey))?.detail ?? {};
  const repos: WatchedRepo[] = projects.flatMap((project) =>
    project.github?.ownerKey === owner.key
      ? [
          {
            project,
            fullName: project.github.fullName,
            defaultBranch: project.github.defaultBranch,
            watchDeployments: project.github.watchDeployments,
            failingWorkflows: readFailingWorkflows(detailOf(project, CI_CHECK_KEY)['failing']),
            goneWorkflows: readGoneWorkflows(detailOf(project, CI_CHECK_KEY)['gone']),
            failingEnvironments: project.github.watchDeployments
              ? readFailingEnvironments(detailOf(project, DEPLOY_CHECK_KEY)['failing'])
              : [],
            hasDeployCheck: previous.has(checkStateKey(project.id, DEPLOY_CHECK_KEY)),
          },
        ]
      : [],
  );
  const result: SourceResult = { source, label, error: null, observations: [] };
  if (repos.length === 0) return result;

  let answers: RepoAnswer[];
  try {
    const body = await fetchJson(fetcher, GRAPHQL_URL, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: buildQuery(repos),
        variables: buildVariables(repos),
      }),
    });
    answers = parseGitHubGraphql(body, repos, owner.logins);
  } catch (error) {
    return { ...result, error: safeErrorMessage(error) };
  }

  // One failing repo must not hide the others: keep what worked, and name the repos that failed.
  const ciResults = await observeCi(fetcher, token, repos);
  const errors: string[] = [];
  repos.forEach((repo, index) => {
    const answer = answers[index] ?? { snapshot: null, error: NOT_ACCESSIBLE };
    const ci = ciResults[index] ?? { observation: null, error: null };
    result.observations.push(...snapshotObservations(repo, answer.snapshot));
    if (ci.observation) result.observations.push(ci.observation);
    const error = answer.error ?? ci.error;
    if (error !== null) errors.push(`${repo.fullName}: ${error}`);
  });
  result.error = summarizeErrors(errors);
  return result;
}

function summarizeErrors(errors: readonly string[]): string | null {
  const [first] = errors;
  if (first === undefined) return null;
  return errors.length === 1 ? first : `${first} (and ${errors.length - 1} more)`;
}

/** What the GraphQL answer says about one repo: its open PRs and, if watched, its deploys. */
function snapshotObservations(repo: WatchedRepo, snapshot: RepoSnapshot | null): Observation[] {
  if (!snapshot) return [];
  const observations: Observation[] = [
    {
      type: 'pull_requests',
      projectId: repo.project.id,
      projectName: repo.project.name,
      repo: repo.fullName,
      pullRequests: snapshot.pullRequests,
    },
  ];
  if (!repo.watchDeployments) return observations;

  const deployments = [...snapshot.deployments, ...snapshot.heldDeployments];
  // An environment that was failing and has no deployment left was removed: forget it.
  const listed = new Set(deployments.map((item) => item.environment));
  const deploy = deployObservation(
    repo.project,
    repo.fullName,
    deployments,
    repo.failingEnvironments.filter((item) => listed.has(item.environment)),
    // Hold a stored check only when it was healthy. One that was failing and now has nothing
    // listed lost its environment, and goes.
    repo.hasDeployCheck && repo.failingEnvironments.length === 0,
  );
  if (deploy) observations.push(deploy);
  return observations;
}

interface CiResult {
  observation: StateObservation | null;
  /** Why CI could not be checked for this repo; the stored row then stays as it is. */
  error: string | null;
}

/**
 * The CI observation of every repo, in the order of `repos`. The Actions calls do not depend on
 * the GraphQL answer, so CI is checked even for a repo GraphQL had an error for.
 *
 * A failing workflow with no run newer than its failure would stay red for good if it was
 * deleted or switched off, since no newer success can ever come. So those are looked up, and one
 * that is gone (404) or no longer active is left out, together with its runs. It is remembered
 * as gone while its runs are still listed, so it is not judged (or looked up) again next run.
 * Which workflows get one of the few lookups is decided only after every repo's runs are in, in
 * a fixed order (repo name, then workflow id), whichever call answers first.
 */
async function observeCi(
  fetcher: Fetcher,
  token: string,
  repos: readonly WatchedRepo[],
): Promise<CiResult[]> {
  const fetched = await Promise.all(
    repos.map(async (repo) => {
      try {
        return {
          runs: await fetchWorkflowRuns(fetcher, token, repo.fullName, repo.defaultBranch),
          error: null,
        };
      } catch (caught) {
        return { runs: null, error: safeErrorMessage(caught) };
      }
    }),
  );

  // Per repo: the workflows known to be gone. Starts from what was stored, minus the ones that
  // have no listed runs any more (nothing left to leave out) or that ran again (they are back).
  const gone = repos.map((repo, repoIndex) => {
    const runs = fetched[repoIndex]?.runs ?? [];
    return repo.goneWorkflows.filter((workflow) => {
      const own = runs.filter((run) => run.workflowId === workflow.workflowId);
      return own.length > 0 && own.every((run) => run.createdAt <= workflow.at);
    });
  });
  const observe = (repoIndex: number, repo: WatchedRepo, runs: readonly WorkflowRun[]) => {
    const goneIds = new Set((gone[repoIndex] ?? []).map((workflow) => workflow.workflowId));
    return ciObservation(
      repo.project,
      runs.filter((run) => !goneIds.has(run.workflowId)),
      repo.failingWorkflows.filter((workflow) => !goneIds.has(workflow.workflowId)),
    );
  };

  const candidates: { repoIndex: number; fullName: string; workflowId: number }[] = [];
  repos.forEach((repo, repoIndex) => {
    const runs = fetched[repoIndex]?.runs;
    if (!runs) return;
    const observation = observe(repoIndex, repo, runs);
    for (const workflow of readFailingWorkflows(observation?.memory?.['failing'])) {
      const hasNewerRun = runs.some(
        (run) => run.workflowId === workflow.workflowId && run.createdAt > workflow.at,
      );
      if (!hasNewerRun) {
        candidates.push({ repoIndex, fullName: repo.fullName, workflowId: workflow.workflowId });
      }
    }
  });
  candidates.sort(
    (a, b) => a.fullName.localeCompare(b.fullName, 'en') || a.workflowId - b.workflowId,
  );

  const lookupErrors = repos.map((): string | null => null);
  await Promise.all(
    candidates.slice(0, MAX_WORKFLOW_LOOKUPS).map(async ({ repoIndex, fullName, workflowId }) => {
      try {
        if (await isWorkflowActive(fetcher, token, fullName, workflowId)) return;
        const runs = fetched[repoIndex]?.runs ?? [];
        const newest = runs
          .filter((run) => run.workflowId === workflowId)
          .map((run) => run.createdAt)
          .sort()
          .at(-1);
        // Without listed runs there is nothing to leave out later; '' keeps it out this run only.
        gone[repoIndex]?.push({ workflowId, at: newest ?? '' });
      } catch (caught) {
        lookupErrors[repoIndex] ??= safeErrorMessage(caught);
      }
    }),
  );

  return repos.map((repo, repoIndex): CiResult => {
    const runs = fetched[repoIndex]?.runs;
    const error = fetched[repoIndex]?.error ?? lookupErrors[repoIndex] ?? null;
    if (!runs || error !== null) return { observation: null, error };
    const remembered = (gone[repoIndex] ?? [])
      .filter((workflow) => workflow.at !== '')
      .sort((a, b) => a.workflowId - b.workflowId);
    return {
      observation: rememberGone(repo.project, observe(repoIndex, repo, runs), remembered),
      error: null,
    };
  });
}

/**
 * Adds the gone workflows to what the CI check stores. That needs a row that gets written, so
 * when nothing else is left to report (no finished run of a workflow that still exists) the
 * check is reported as ok rather than dropped or left unknown.
 */
function rememberGone(
  project: Project,
  observation: StateObservation | null,
  gone: readonly GoneWorkflow[],
): StateObservation | null {
  if (gone.length === 0) return observation;
  if (observation !== null && observation.status !== 'unknown') {
    return { ...observation, memory: { ...observation.memory, gone } };
  }
  return {
    type: 'state',
    projectId: project.id,
    checkKey: CI_CHECK_KEY,
    kind: 'ci',
    subject: project.name,
    label: 'CI',
    status: 'ok',
    summary: 'No finished runs of an active workflow',
    linkUrl: null,
    at: null,
    failuresToProblem: 1,
    memory: { failing: [], gone },
  };
}

async function isWorkflowActive(
  fetcher: Fetcher,
  token: string,
  repo: string,
  workflowId: number,
): Promise<boolean> {
  try {
    const body = await fetchJson(
      fetcher,
      `https://api.github.com/repos/${repo}/actions/workflows/${workflowId}`,
      { headers: authHeaders(token) },
    );
    // GitHub keeps a workflow whose file was removed, with state 'deleted'; a disabled one has
    // a 'disabled_...' state. Neither will run again.
    return readString(readRecord(body), 'state') === 'active';
  } catch (error) {
    if (error instanceof SourceError && error.message === 'HTTP 404') return false;
    throw error;
  }
}

// GraphQL -------------------------------------------------------------------------------------

const DEPLOYMENT_FIELDS = 'nodes { environment createdAt latestStatus { state logUrl } }';
const NEWEST_FIRST = 'orderBy: { field: CREATED_AT, direction: DESC }';

type QueriedRepo = Pick<WatchedRepo, 'fullName' | 'failingEnvironments'>;

/**
 * One aliased block per repo. Owner, name and environment names travel as variables, never
 * spliced into the query text. A repo with failing environments also gets one extra field per
 * environment for its newest deployment, in this same call.
 */
export function buildQuery(repos: readonly QueriedRepo[]): string {
  const variables: string[] = [];
  const aliases = repos.map((repo, index) => {
    variables.push(`$owner${index}: String!`, `$name${index}: String!`);
    const held = repo.failingEnvironments.map((_, envIndex) => {
      variables.push(`$env${index}_${envIndex}: String!`);
      return ` held${envIndex}: deployments(first: 1, environments: [$env${index}_${envIndex}], ${NEWEST_FIRST}) { ${DEPLOYMENT_FIELDS} }`;
    });
    return `repo${index}: repository(owner: $owner${index}, name: $name${index}) { ...Watched${held.join('')} }`;
  });
  return `query(${variables.join(', ')}) {
  ${aliases.join('\n  ')}
}
fragment Watched on Repository {
  deployments(first: ${MAX_DEPLOYMENTS}, ${NEWEST_FIRST}) {
    ${DEPLOYMENT_FIELDS}
  }
  pullRequests(states: OPEN, first: ${MAX_PULL_REQUESTS}, orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes {
      number title url
      reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } } } }
    }
  }
}`;
}

export function buildVariables(repos: readonly QueriedRepo[]): Record<string, string> {
  const variables: Record<string, string> = {};
  repos.forEach((repo, index) => {
    const [owner = '', name = ''] = repo.fullName.split('/');
    variables[`owner${index}`] = owner;
    variables[`name${index}`] = name;
    repo.failingEnvironments.forEach((item, envIndex) => {
      variables[`env${index}_${envIndex}`] = item.environment;
    });
  });
  return variables;
}

// GitHub's error types are words like NOT_FOUND or FORBIDDEN. Only those are shown; an error
// message is free text and stays out of what is stored.
const ERROR_TYPE_PATTERN = /^[A-Z_]{1,40}$/;
const REPO_ALIAS_PATTERN = /^repo\d+$/;

/**
 * Parses the batched response. GraphQL answers 200 with an `errors` array when something could
 * not be read, and every entry counts: one whose path starts at a repo alias is that repo's
 * error (the token cannot see the repo, or lacks a permission for one of its fields); any other
 * fails the whole call.
 */
export function parseGitHubGraphql(
  body: unknown,
  repos: readonly QueriedRepo[],
  myLogins: readonly string[],
): RepoAnswer[] {
  const root = readRecord(body);
  const repoErrors = new Map<string, string>();
  const errors = root['errors'];
  for (const item of Array.isArray(errors) ? (errors as unknown[]) : []) {
    const entry = isRecord(item) ? item : {};
    const type = entry['type'];
    const reason = typeof type === 'string' && ERROR_TYPE_PATTERN.test(type) ? type : 'error';
    const path = entry['path'];
    const alias: unknown = Array.isArray(path) ? path[0] : undefined;
    if (typeof alias !== 'string' || !REPO_ALIAS_PATTERN.test(alias)) {
      throw new SourceError(`GraphQL ${reason}`);
    }
    if (!repoErrors.has(alias)) repoErrors.set(alias, `GraphQL ${reason}`);
  }

  const data = root['data'];
  if (!isRecord(data)) throw new SourceError('invalid response');
  return repos.map((queried, index): RepoAnswer => {
    const alias = `repo${index}`;
    const error = repoErrors.get(alias);
    if (error !== undefined) return { snapshot: null, error };
    const repo = data[alias];
    if (!isRecord(repo)) return { snapshot: null, error: NOT_ACCESSIBLE };
    return {
      snapshot: parseRepo(repo, queried.failingEnvironments.length, myLogins),
      error: null,
    };
  });
}

function parseRepo(
  repo: Record<string, unknown>,
  heldCount: number,
  myLogins: readonly string[],
): RepoSnapshot {
  return {
    deployments: nodesOf(repo['deployments']).map(parseDeployment),
    heldDeployments: Array.from({ length: heldCount }, (_, envIndex) =>
      nodesOf(repo[`held${envIndex}`]).map(parseDeployment),
    ).flat(),
    pullRequests: nodesOf(repo['pullRequests']).map((node) => parsePullRequest(node, myLogins)),
  };
}

function nodesOf(connection: unknown): unknown[] {
  return readArray(readRecord(connection), 'nodes');
}

function parseDeployment(node: unknown): Deployment {
  const record = readRecord(node);
  const status = record['latestStatus'];
  return {
    environment: readString(record, 'environment'),
    createdAt: readString(record, 'createdAt'),
    state: isRecord(status) ? readString(status, 'state') : null,
    logUrl: isRecord(status) && typeof status['logUrl'] === 'string' ? status['logUrl'] : null,
  };
}

function parsePullRequest(node: unknown, myLogins: readonly string[]): PullRequestObservation {
  const record = readRecord(node);
  const requested = nodesOf(record['reviewRequests']).some((request) => {
    const reviewer = readRecord(request)['requestedReviewer'];
    return (
      isRecord(reviewer) &&
      reviewer['__typename'] === 'User' &&
      typeof reviewer['login'] === 'string' &&
      myLogins.includes(reviewer['login'])
    );
  });
  return {
    number: readNumber(record, 'number'),
    title: readString(record, 'title'),
    url: readString(record, 'url'),
    isReviewRequestedFromMe: requested,
  };
}

// Deployments ---------------------------------------------------------------------------------

const FAILED_DEPLOY_STATES: readonly string[] = ['FAILURE', 'ERROR'];

/** Reads what a previous run stored; anything malformed is dropped. */
export function readFailingEnvironments(stored: unknown): FailingEnvironment[] {
  if (!Array.isArray(stored)) return [];
  return (stored as unknown[]).flatMap((item) => {
    if (!isRecord(item)) return [];
    const { environment, at, url } = item;
    if (typeof environment !== 'string' || typeof at !== 'string') return [];
    return [{ environment, at, url: typeof url === 'string' ? url : null }];
  });
}

/**
 * Looks at the newest deployment of each production environment (Vercel names them 'Production'
 * or 'Production - <project>'). An environment is failing when that deployment failed, and stays
 * failing until its newest deployment succeeded: while one is still building, the earlier
 * failure stands. (The caller adds the newest deployment of each failing environment to the
 * list, and leaves out failing environments that have no deployment left.)
 * Problem if any environment is failing, ok if all succeeded, otherwise unknown (still
 * building).
 * With no production deployment listed and nothing failing: unknown if a Deploy check is already
 * stored (production deploys merely scrolled out of the recent ones behind previews, so what was
 * known stands), null if the repo never had one.
 */
export function deployObservation(
  project: Project,
  repo: string,
  deployments: readonly Deployment[],
  previousFailing: readonly FailingEnvironment[],
  hasDeployCheck: boolean,
): StateObservation | null {
  const newestByEnvironment = new Map<string, Deployment>();
  for (const deployment of deployments) {
    if (!deployment.environment.toLowerCase().startsWith('production')) continue;
    // The list is newest first, so the first one seen per environment is the latest.
    if (!newestByEnvironment.has(deployment.environment)) {
      newestByEnvironment.set(deployment.environment, deployment);
    }
  }
  if (newestByEnvironment.size === 0 && previousFailing.length === 0) {
    if (!hasDeployCheck) return null;
    return {
      type: 'state',
      projectId: project.id,
      checkKey: DEPLOY_CHECK_KEY,
      kind: 'deploy',
      subject: project.name,
      label: 'Deploy',
      status: 'unknown',
      summary: 'No recent production deployments',
      linkUrl: null,
      at: null,
      failuresToProblem: 1,
    };
  }

  const failing: FailingEnvironment[] = [];
  let isSettled = true;
  for (const newest of newestByEnvironment.values()) {
    if (newest.state !== null && FAILED_DEPLOY_STATES.includes(newest.state)) {
      failing.push({
        environment: newest.environment,
        at: newest.createdAt,
        url: newest.logUrl,
      });
    } else if (newest.state !== 'SUCCESS') {
      isSettled = false;
      const before = previousFailing.find((item) => item.environment === newest.environment);
      if (before) failing.push(before);
    }
  }
  for (const before of previousFailing) {
    if (!newestByEnvironment.has(before.environment)) failing.push(before);
  }

  const base = {
    type: 'state' as const,
    projectId: project.id,
    checkKey: DEPLOY_CHECK_KEY,
    kind: 'deploy' as const,
    subject: project.name,
    label: 'Deploy',
    failuresToProblem: 1,
    memory: { failing },
  };
  const deploymentsUrl = `https://github.com/${repo}/deployments`;
  const [firstFailing] = failing;
  if (firstFailing) {
    return {
      ...base,
      status: 'problem',
      summary: 'Failed',
      linkUrl: firstFailing.url ?? deploymentsUrl,
      at: firstFailing.at,
    };
  }
  const [latest] = newestByEnvironment.values();
  return {
    ...base,
    status: isSettled ? 'ok' : 'unknown',
    summary: isSettled ? 'Succeeded' : 'In progress',
    linkUrl: latest?.logUrl ?? deploymentsUrl,
    at: latest?.createdAt ?? null,
  };
}

// CI ------------------------------------------------------------------------------------------

async function fetchWorkflowRuns(
  fetcher: Fetcher,
  token: string,
  repo: string,
  defaultBranch: string,
): Promise<WorkflowRun[]> {
  const query = new URLSearchParams({
    branch: defaultBranch,
    exclude_pull_requests: 'true',
    per_page: String(MAX_WORKFLOW_RUNS),
  });
  const body = await fetchJson(
    fetcher,
    `https://api.github.com/repos/${repo}/actions/runs?${query.toString()}`,
    {
      headers: authHeaders(token),
    },
  );
  return parseWorkflowRuns(body);
}

export function parseWorkflowRuns(body: unknown): WorkflowRun[] {
  return readArray(readRecord(body), 'workflow_runs').map((item) => {
    const run = readRecord(item);
    return {
      id: readNumber(run, 'id'),
      workflowId: readNumber(run, 'workflow_id'),
      name: readString(run, 'name'),
      status: readString(run, 'status'),
      conclusion: typeof run['conclusion'] === 'string' ? run['conclusion'] : null,
      url: readString(run, 'html_url'),
      createdAt: readString(run, 'created_at'),
    };
  });
}

/** Reads what a previous run stored; anything malformed is dropped. */
export function readFailingWorkflows(stored: unknown): FailingWorkflow[] {
  if (!Array.isArray(stored)) return [];
  return (stored as unknown[]).flatMap((item) => {
    if (!isRecord(item)) return [];
    const { workflowId, name, runId, at, url } = item;
    if (
      typeof workflowId !== 'number' ||
      typeof name !== 'string' ||
      typeof runId !== 'number' ||
      typeof at !== 'string' ||
      typeof url !== 'string'
    ) {
      return [];
    }
    return [{ workflowId, name, runId, at, url }];
  });
}

/** Reads what a previous run stored; anything malformed is dropped. */
export function readGoneWorkflows(stored: unknown): GoneWorkflow[] {
  if (!Array.isArray(stored)) return [];
  return (stored as unknown[]).flatMap((item) => {
    if (!isRecord(item)) return [];
    const { workflowId, at } = item;
    if (typeof workflowId !== 'number' || typeof at !== 'string') return [];
    return [{ workflowId, at }];
  });
}

const RED_CONCLUSIONS: readonly string[] = ['failure', 'timed_out', 'startup_failure'];

/**
 * CI is red while any workflow on the default branch is failing. A workflow is failing when its
 * latest finished run failed; cancelled, skipped and neutral runs say nothing either way. It
 * stays failing until a newer run of that same workflow succeeds, or the failed run itself
 * succeeds on a re-run. So a re-run in progress, or a failed run that scrolled out of the recent
 * runs, does not turn CI green. Null when the repo has no runs and nothing was failing.
 */
export function ciObservation(
  project: Project,
  runs: readonly WorkflowRun[],
  previousFailing: readonly FailingWorkflow[],
): StateObservation | null {
  if (runs.length === 0 && previousFailing.length === 0) return null;
  const newestFirst = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestByWorkflow = new Map<number, WorkflowRun>();
  for (const run of newestFirst) {
    const isDecisive =
      run.status === 'completed' && (run.conclusion === 'success' || isRed(run.conclusion));
    if (isDecisive && !latestByWorkflow.has(run.workflowId))
      latestByWorkflow.set(run.workflowId, run);
  }

  const failing: FailingWorkflow[] = [];
  for (const run of latestByWorkflow.values()) {
    if (!isRed(run.conclusion)) continue;
    failing.push({
      workflowId: run.workflowId,
      name: run.name,
      runId: run.id,
      at: run.createdAt,
      url: run.url,
    });
  }
  for (const before of previousFailing) {
    const latest = latestByWorkflow.get(before.workflowId);
    if (latest && isRed(latest.conclusion)) continue;
    // A re-run keeps its run id and creation time, so the failed run succeeding counts too.
    const isFixed =
      latest !== undefined && (latest.createdAt > before.at || latest.id === before.runId);
    if (!isFixed) failing.push(before);
  }

  const base = {
    type: 'state' as const,
    projectId: project.id,
    checkKey: CI_CHECK_KEY,
    kind: 'ci' as const,
    subject: project.name,
    label: 'CI',
    failuresToProblem: 1,
    memory: { failing },
  };
  const [firstFailing] = failing;
  if (firstFailing) {
    const names = failing.map((item) => item.name).join(', ');
    return {
      ...base,
      status: 'problem',
      summary: `Failing: ${names}`,
      linkUrl: firstFailing.url,
      at: firstFailing.at,
    };
  }
  const [latest] = latestByWorkflow.values();
  if (!latest) {
    return { ...base, status: 'unknown', summary: 'No finished runs', linkUrl: null, at: null };
  }
  const count = latestByWorkflow.size;
  const summary = count === 1 ? 'Passing' : `Passing (${count} workflows)`;
  return { ...base, status: 'ok', summary, linkUrl: latest.url, at: latest.createdAt };
}

function isRed(conclusion: string | null): boolean {
  return conclusion !== null && RED_CONCLUSIONS.includes(conclusion);
}
