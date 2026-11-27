// GitHub, per token. What a read-only fine-grained token can read, from GitHub's permission
// list for fine-grained tokens:
//   Metadata (always), Actions: read, Deployments: read, Pull requests: read.
// There is no "Checks" permission for fine-grained tokens, so check runs (and the GraphQL
// statusCheckRollup, which includes them) are not used. CI state comes from the Actions
// workflow runs instead, which only REST offers: one GraphQL call per token for deployments
// and PRs, then one REST call per repo (plus, rarely, a lookup of a workflow that is held red
// and has no recent runs). The default branch comes from the config: reading it
// from the API needs Contents permission, which the tokens do not have.
// A repo that watches extra branches or shows the checks of its pull requests gets one more
// REST call: its recent runs on every branch, which answers both.

import type { PullRequestChecks } from '../../shared/api.ts';
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
  needsRecentRuns,
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
/**
 * Half of what one call may return: every run in the answer is about 12 kB of JSON, and parsing
 * it counts against the 10 ms of CPU a run has on Workers Free. See docs/limits.md for what
 * happens to runs beyond it.
 */
const MAX_RECENT_RUNS = 50;
const CI_CHECK_KEY = 'ci';
const DEPLOY_CHECK_KEY = 'deploy';

/** The check key of an extra branch's CI. The default branch keeps 'ci'. */
export function branchCiCheckKey(branch: string): string {
  return `${CI_CHECK_KEY}:${branch}`;
}

/** Which CI check an observation is for. */
export interface CiCheck {
  checkKey: string;
  label: string;
  /** Only for an extra branch. */
  branch?: string;
}

const DEFAULT_BRANCH_CI: CiCheck = { checkKey: CI_CHECK_KEY, label: 'CI' };

/** A branch whose CI is watched, with what the last run stored for it. */
interface WatchedBranch {
  name: string;
  check: CiCheck;
  /** Empty unless something was failing. */
  failingWorkflows: FailingWorkflow[];
  goneWorkflows: GoneWorkflow[];
}

interface WatchedRepo {
  project: Project;
  fullName: string;
  defaultBranch: WatchedBranch;
  /** The extra branches of the config, in its order. */
  extraBranches: WatchedBranch[];
  pullRequestChecks: boolean;
  /** Whether the call for the recent runs on every branch is made. */
  needsRecentRuns: boolean;
  watchDeployments: boolean;
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

/** A run from the list of every branch, with what tells the branches and commits apart. */
export interface RecentRun extends WorkflowRun {
  /** Null when the run's branch is not known (GitHub's schema allows it). */
  headBranch: string | null;
  headSha: string;
  /** False for a run of a pull request from a fork, whose branch may share a name with ours. */
  isOwnRepo: boolean;
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
  /** PR number -> head commit, for a repo that shows pull request checks; otherwise empty. */
  headShas: ReadonlyMap<number, string>;
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
  const watchBranch = (project: Project, name: string, check: CiCheck): WatchedBranch => ({
    name,
    check,
    failingWorkflows: readFailingWorkflows(detailOf(project, check.checkKey)['failing']),
    goneWorkflows: readGoneWorkflows(detailOf(project, check.checkKey)['gone']),
  });
  const repos: WatchedRepo[] = projects.flatMap((project) => {
    const repo = project.github;
    if (repo?.ownerKey !== owner.key) return [];
    return [
      {
        project,
        fullName: repo.fullName,
        defaultBranch: watchBranch(project, repo.defaultBranch, DEFAULT_BRANCH_CI),
        extraBranches: repo.extraBranches.map((branch) =>
          watchBranch(project, branch, {
            checkKey: branchCiCheckKey(branch),
            label: `CI (${branch})`,
            branch,
          }),
        ),
        pullRequestChecks: repo.pullRequestChecks,
        needsRecentRuns: needsRecentRuns(repo),
        watchDeployments: repo.watchDeployments,
        failingEnvironments: repo.watchDeployments
          ? readFailingEnvironments(detailOf(project, DEPLOY_CHECK_KEY)['failing'])
          : [],
        hasDeployCheck: previous.has(checkStateKey(project.id, DEPLOY_CHECK_KEY)),
      },
    ];
  });
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
    const ci = ciResults[index] ?? { observations: [], error: null, recentRuns: null };
    result.observations.push(...snapshotObservations(repo, answer.snapshot, ci.recentRuns));
    result.observations.push(...ci.observations);
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

/**
 * What the GraphQL answer says about one repo: its open PRs and, if watched, its deploys.
 * `recentRuns` (null when they were not asked for or could not be read) adds to each PR what
 * the runs on its head commit say.
 */
function snapshotObservations(
  repo: WatchedRepo,
  snapshot: RepoSnapshot | null,
  recentRuns: readonly RecentRun[] | null,
): Observation[] {
  if (!snapshot) return [];
  const observations: Observation[] = [
    {
      type: 'pull_requests',
      projectId: repo.project.id,
      projectName: repo.project.name,
      repo: repo.fullName,
      pullRequests: withChecks(snapshot.pullRequests, snapshot.headShas, recentRuns ?? []),
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
  /** The default branch's CI and that of each extra branch, as far as they could be checked. */
  observations: StateObservation[];
  /** Why CI could not be checked for this repo; the stored rows then stay as they are. */
  error: string | null;
  /** The repo's recent runs on every branch; null when not asked for or not readable. */
  recentRuns: RecentRun[] | null;
}

/** One watched branch of one repo with the runs listed for it this run. */
interface CiTarget {
  repoIndex: number;
  repo: WatchedRepo;
  branch: WatchedBranch;
  /** 0 for the default branch, then the extra branches in the config's order. */
  position: number;
  /** Null when the call that lists them failed. */
  runs: readonly WorkflowRun[] | null;
  error: string | null;
}

type Fetched<T> = { runs: T[]; error: null } | { runs: null; error: string };

async function attempt<T>(fetchRuns: () => Promise<T[]>): Promise<Fetched<T>> {
  try {
    return { runs: await fetchRuns(), error: null };
  } catch (caught) {
    return { runs: null, error: safeErrorMessage(caught) };
  }
}

/**
 * The CI observations of every repo, in the order of `repos`. The Actions calls do not depend on
 * the GraphQL answer, so CI is checked even for a repo GraphQL had an error for.
 *
 * The default branch has a call of its own, filtered to that branch. Extra branches are read
 * from one more call, the repo's recent runs on every branch, and judged by the same rules. On a
 * busy repo an extra branch's runs can scroll out of that list: what was failing is held (it is
 * remembered per branch), and a branch with nothing listed is reported as unknown, which keeps
 * its stored state. So scrolling out never turns a branch green and never removes its row.
 *
 * A failing workflow with no run newer than its failure would stay red for good if it was
 * deleted or switched off, since no newer success can ever come. So those are looked up, and one
 * that is gone (404) or no longer active is left out, together with its runs. It is remembered
 * as gone while its runs are still listed, so it is not judged (or looked up) again next run.
 * Which workflows get one of the few lookups is decided only after every repo's runs are in, in
 * a fixed order (default branches first, by repo name, then workflow id; then extra branches),
 * whichever call answers first. A workflow failing on several branches of a repo is looked up
 * once.
 */
async function observeCi(
  fetcher: Fetcher,
  token: string,
  repos: readonly WatchedRepo[],
): Promise<CiResult[]> {
  const fetched = await Promise.all(
    repos.map(async (repo) => {
      const [defaultBranch, recent] = await Promise.all([
        attempt(() => fetchWorkflowRuns(fetcher, token, repo.fullName, repo.defaultBranch.name)),
        repo.needsRecentRuns ? attempt(() => fetchRecentRuns(fetcher, token, repo.fullName)) : null,
      ]);
      return { defaultBranch, recent };
    }),
  );

  const targets: CiTarget[] = repos.flatMap((repo, repoIndex) => {
    const answer = fetched[repoIndex];
    if (!answer) return [];
    const { defaultBranch, recent } = answer;
    return [
      { repoIndex, repo, branch: repo.defaultBranch, position: 0, ...defaultBranch },
      ...repo.extraBranches.map((branch, index) => ({
        repoIndex,
        repo,
        branch,
        position: index + 1,
        runs:
          recent?.runs?.filter((run) => run.isOwnRepo && run.headBranch === branch.name) ?? null,
        error: recent?.error ?? null,
      })),
    ];
  });

  // Per target: the workflows known to be gone. Starts from what was stored, minus the ones that
  // have no listed runs any more (nothing left to leave out) or that ran again (they are back).
  const gone = targets.map((target) => {
    const runs = target.runs ?? [];
    return target.branch.goneWorkflows.filter((workflow) => {
      const own = runs.filter((run) => run.workflowId === workflow.workflowId);
      return own.length > 0 && own.every((run) => run.createdAt <= workflow.at);
    });
  });
  const observe = (targetIndex: number, target: CiTarget, runs: readonly WorkflowRun[]) => {
    const goneIds = new Set((gone[targetIndex] ?? []).map((workflow) => workflow.workflowId));
    return ciObservation(
      target.repo.project,
      runs.filter((run) => !goneIds.has(run.workflowId)),
      target.branch.failingWorkflows.filter((workflow) => !goneIds.has(workflow.workflowId)),
      target.branch.check,
    );
  };

  const candidates: { targetIndex: number; target: CiTarget; workflowId: number }[] = [];
  targets.forEach((target, targetIndex) => {
    const { runs } = target;
    if (!runs) return;
    const observation = observe(targetIndex, target, runs);
    for (const workflow of readFailingWorkflows(observation?.memory?.['failing'])) {
      const hasNewerRun = runs.some(
        (run) => run.workflowId === workflow.workflowId && run.createdAt > workflow.at,
      );
      if (!hasNewerRun) candidates.push({ targetIndex, target, workflowId: workflow.workflowId });
    }
  });
  const isExtra = (target: CiTarget) => (target.position > 0 ? 1 : 0);
  candidates.sort(
    (a, b) =>
      isExtra(a.target) - isExtra(b.target) ||
      a.target.repo.fullName.localeCompare(b.target.repo.fullName, 'en') ||
      a.target.position - b.target.position ||
      a.workflowId - b.workflowId,
  );
  // One lookup answers for every branch of the repo that asks about the workflow.
  const lookups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = `${candidate.target.repo.fullName}#${candidate.workflowId}`;
    lookups.set(key, [...(lookups.get(key) ?? []), candidate]);
  }

  const lookupErrors = targets.map((): string | null => null);
  await Promise.all(
    [...lookups.values()].slice(0, MAX_WORKFLOW_LOOKUPS).map(async (askers) => {
      const [first] = askers;
      if (!first) return;
      const { workflowId } = first;
      try {
        if (await isWorkflowActive(fetcher, token, first.target.repo.fullName, workflowId)) return;
        for (const { targetIndex, target } of askers) {
          const newest = (target.runs ?? [])
            .filter((run) => run.workflowId === workflowId)
            .map((run) => run.createdAt)
            .sort()
            .at(-1);
          // Without listed runs there is nothing to leave out later; '' keeps it out this run
          // only.
          gone[targetIndex]?.push({ workflowId, at: newest ?? '' });
        }
      } catch (caught) {
        for (const { targetIndex } of askers) {
          lookupErrors[targetIndex] ??= safeErrorMessage(caught);
        }
      }
    }),
  );

  const results = repos.map((_, repoIndex): CiResult => {
    const recent = fetched[repoIndex]?.recent;
    return { observations: [], error: null, recentRuns: recent?.runs ?? null };
  });
  repos.forEach((repo, repoIndex) => {
    // Never an error of the source: nothing about pull request checks may raise an alert.
    if (repo.extraBranches.length === 0 && typeof fetched[repoIndex]?.recent?.error === 'string') {
      console.error('Recent runs could not be read; pull request checks left out this run');
    }
  });
  targets.forEach((target, targetIndex) => {
    const result = results[target.repoIndex];
    if (!result) return;
    const error = target.error ?? lookupErrors[targetIndex] ?? null;
    if (!target.runs || error !== null) {
      result.error ??= error;
      return;
    }
    const remembered = (gone[targetIndex] ?? [])
      .filter((workflow) => workflow.at !== '')
      .sort((a, b) => a.workflowId - b.workflowId);
    const observation =
      rememberGone(target, observe(targetIndex, target, target.runs), remembered) ??
      noRecentRuns(target);
    if (observation) result.observations.push(observation);
  });
  return results;
}

/**
 * What an extra branch reports when none of its runs are among the repo's recent ones and
 * nothing is failing: unknown, so a stored row keeps its state and is not taken for a branch
 * that left the config. Except when it was red and every failing workflow was just found gone:
 * then nothing holds it red any more, and it is ok.
 * The default branch reports nothing in either case, as it always has: its own call lists its
 * runs however busy the repo is, so an empty list means it has none.
 */
function noRecentRuns({ repo, branch }: CiTarget): StateObservation | null {
  if (branch.check.branch === undefined) return null;
  const base = {
    type: 'state' as const,
    projectId: repo.project.id,
    ...branch.check,
    kind: 'ci' as const,
    subject: repo.project.name,
    linkUrl: null,
    at: null,
    failuresToProblem: 1,
  };
  if (branch.failingWorkflows.length > 0) {
    return {
      ...base,
      status: 'ok',
      summary: 'No finished runs of an active workflow',
      memory: { failing: [] },
    };
  }
  return { ...base, status: 'unknown', summary: 'No recent runs' };
}

/**
 * Adds the gone workflows to what the CI check stores. That needs a row that gets written, so
 * when nothing else is left to report (no finished run of a workflow that still exists) the
 * check is reported as ok rather than dropped or left unknown.
 */
function rememberGone(
  { repo, branch }: CiTarget,
  observation: StateObservation | null,
  gone: readonly GoneWorkflow[],
): StateObservation | null {
  if (gone.length === 0) return observation;
  if (observation !== null && observation.status !== 'unknown') {
    return { ...observation, memory: { ...observation.memory, gone } };
  }
  return {
    type: 'state',
    projectId: repo.project.id,
    ...branch.check,
    kind: 'ci',
    subject: repo.project.name,
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

type QueriedRepo = Pick<WatchedRepo, 'fullName' | 'failingEnvironments'> &
  Partial<Pick<WatchedRepo, 'pullRequestChecks'>>;

/**
 * The head commits of a repo's open PRs are asked for under a root alias of their own, next to
 * the repo's: GraphQL answers an error inside a repo's block by returning null for the whole
 * block, and that must never happen to the PRs because of the checks.
 */
function headsAlias(index: number): string {
  return `heads${index}`;
}
const HEADS_ALIAS_PATTERN = /^heads\d+$/;
const OPEN_PULL_REQUESTS = `pullRequests(states: OPEN, first: ${MAX_PULL_REQUESTS}, orderBy: { field: UPDATED_AT, direction: DESC })`;

/**
 * One aliased block per repo. Owner, name and environment names travel as variables, never
 * spliced into the query text. A repo with failing environments also gets one extra field per
 * environment for its newest deployment, in this same call. A repo that shows pull request
 * checks gets a second block for the head commits of its open PRs (see headsAlias).
 */
export function buildQuery(repos: readonly QueriedRepo[]): string {
  const variables: string[] = [];
  const aliases = repos.map((repo, index) => {
    variables.push(`$owner${index}: String!`, `$name${index}: String!`);
    const held = repo.failingEnvironments.map((_, envIndex) => {
      variables.push(`$env${index}_${envIndex}: String!`);
      return ` held${envIndex}: deployments(first: 1, environments: [$env${index}_${envIndex}], ${NEWEST_FIRST}) { ${DEPLOYMENT_FIELDS} }`;
    });
    const repository = `repository(owner: $owner${index}, name: $name${index})`;
    const heads = repo.pullRequestChecks
      ? `\n  ${headsAlias(index)}: ${repository} { ${OPEN_PULL_REQUESTS} { nodes { number headRefOid } } }`
      : '';
    return `repo${index}: ${repository} { ...Watched${held.join('')} }${heads}`;
  });
  return `query(${variables.join(', ')}) {
  ${aliases.join('\n  ')}
}
fragment Watched on Repository {
  deployments(first: ${MAX_DEPLOYMENTS}, ${NEWEST_FIRST}) {
    ${DEPLOYMENT_FIELDS}
  }
  ${OPEN_PULL_REQUESTS} {
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
 * fails the whole call. The one exception is the block for pull request checks: an error there
 * only means no checks are shown, because nothing about those may ever raise an alert.
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
    if (typeof alias === 'string' && HEADS_ALIAS_PATTERN.test(alias)) continue;
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
      snapshot: {
        ...parseRepo(repo, queried.failingEnvironments.length, myLogins),
        headShas: parseHeadShas(data[headsAlias(index)]),
      },
      error: null,
    };
  });
}

function parseRepo(
  repo: Record<string, unknown>,
  heldCount: number,
  myLogins: readonly string[],
): Omit<RepoSnapshot, 'headShas'> {
  return {
    deployments: nodesOf(repo['deployments']).map(parseDeployment),
    heldDeployments: Array.from({ length: heldCount }, (_, envIndex) =>
      nodesOf(repo[`held${envIndex}`]).map(parseDeployment),
    ).flat(),
    pullRequests: nodesOf(repo['pullRequests']).map((node) => parsePullRequest(node, myLogins)),
  };
}

/** Lenient on purpose: whatever is missing or malformed only means no checks for that PR. */
function parseHeadShas(repository: unknown): Map<number, string> {
  const headShas = new Map<number, string>();
  const connection = isRecord(repository) ? repository['pullRequests'] : null;
  const nodes = isRecord(connection) ? connection['nodes'] : null;
  for (const node of Array.isArray(nodes) ? (nodes as unknown[]) : []) {
    if (!isRecord(node)) continue;
    const { number, headRefOid } = node;
    if (typeof number === 'number' && typeof headRefOid === 'string') {
      headShas.set(number, headRefOid);
    }
  }
  return headShas;
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
  return parseWorkflowRuns(body, repo);
}

/**
 * The runs of the branch in this repo. GitHub's `branch` filter goes by the name of a run's head
 * branch alone, so it also returns the runs of pull requests from forks whose branch has that
 * name ('main' more often than not). Those say nothing about this repo's branch and are left
 * out.
 */
export function parseWorkflowRuns(body: unknown, repo: string): WorkflowRun[] {
  return readArray(readRecord(body), 'workflow_runs')
    .map(readRecord)
    .filter((run) => isOwnRun(run, repo))
    .map(parseWorkflowRun);
}

/**
 * Whether a run's head branch is a branch of this repo: false for a pull request from a fork,
 * and for one from a repo that no longer exists (GitHub then sends null). A run without the
 * field at all is kept, so that an answer that leaves it out is read as it always was rather
 * than emptied.
 */
function isOwnRun(run: Record<string, unknown>, repo: string): boolean {
  const headRepository = run['head_repository'];
  if (headRepository === undefined) return true;
  const fullName = isRecord(headRepository) ? headRepository['full_name'] : null;
  // GitHub names do not differ by case.
  return typeof fullName === 'string' && fullName.toLowerCase() === repo.toLowerCase();
}

function parseWorkflowRun(run: Record<string, unknown>): WorkflowRun {
  return {
    id: readNumber(run, 'id'),
    workflowId: readNumber(run, 'workflow_id'),
    name: readString(run, 'name'),
    status: readString(run, 'status'),
    conclusion: typeof run['conclusion'] === 'string' ? run['conclusion'] : null,
    url: readString(run, 'html_url'),
    createdAt: readString(run, 'created_at'),
  };
}

/**
 * The repo's most recent runs whatever their branch or trigger, newest first: one call that
 * serves every extra branch and every pull request. `exclude_pull_requests` only leaves the
 * list of pull requests out of each run (a smaller answer); runs of pull requests are included.
 */
async function fetchRecentRuns(
  fetcher: Fetcher,
  token: string,
  repo: string,
): Promise<RecentRun[]> {
  const query = new URLSearchParams({
    exclude_pull_requests: 'true',
    per_page: String(MAX_RECENT_RUNS),
  });
  const body = await fetchJson(
    fetcher,
    `https://api.github.com/repos/${repo}/actions/runs?${query.toString()}`,
    { headers: authHeaders(token) },
  );
  return parseRecentRuns(body, repo);
}

/**
 * A run that cannot be read (GitHub sends `name: null` for some) is skipped rather than failing
 * the whole list: this one answer serves every extra branch and every pull request of the repo.
 */
export function parseRecentRuns(body: unknown, repo: string): RecentRun[] {
  return readArray(readRecord(body), 'workflow_runs').flatMap((item) => {
    try {
      const run = readRecord(item);
      return [
        {
          ...parseWorkflowRun(run),
          headBranch: typeof run['head_branch'] === 'string' ? run['head_branch'] : null,
          headSha: readString(run, 'head_sha'),
          isOwnRepo: isOwnRun(run, repo),
        },
      ];
    } catch (error) {
      if (error instanceof SourceError) return [];
      throw error;
    }
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
 * CI is red while any workflow on the branch is failing. A workflow is failing when its
 * latest finished run failed; cancelled, skipped and neutral runs say nothing either way. It
 * stays failing until a newer run of that same workflow succeeds, or the failed run itself
 * succeeds on a re-run. So a re-run in progress, or a failed run that scrolled out of the recent
 * runs, does not turn CI green. Null when no runs are listed and nothing was failing.
 * `check` says which branch's check this is; the default branch's when left out.
 */
export function ciObservation(
  project: Project,
  runs: readonly WorkflowRun[],
  previousFailing: readonly FailingWorkflow[],
  check: CiCheck = DEFAULT_BRANCH_CI,
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
    ...check,
    kind: 'ci' as const,
    subject: project.name,
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

// Pull request checks -------------------------------------------------------------------------

/**
 * What the Actions runs on one commit say, by the newest run of each workflow there: failing if
 * any failed, else running if any has not finished, else passing if any succeeded. Null when
 * there is nothing to say: no run on the commit among the recent ones, or only cancelled,
 * skipped and neutral ones.
 */
export function commitChecks(
  headSha: string,
  recentRuns: readonly RecentRun[],
): PullRequestChecks | null {
  const newestFirst = recentRuns
    .filter((run) => run.headSha === headSha)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestByWorkflow = new Map<number, RecentRun>();
  for (const run of newestFirst) {
    if (!latestByWorkflow.has(run.workflowId)) latestByWorkflow.set(run.workflowId, run);
  }
  const latest = [...latestByWorkflow.values()];
  if (latest.some((run) => run.status === 'completed' && isRed(run.conclusion))) return 'failing';
  if (latest.some((run) => run.status !== 'completed')) return 'running';
  if (latest.some((run) => run.conclusion === 'success')) return 'passing';
  return null;
}

/** Adds `checks` to the PRs it is known for. The others are returned exactly as they came. */
function withChecks(
  pullRequests: PullRequestObservation[],
  headShas: ReadonlyMap<number, string>,
  recentRuns: readonly RecentRun[],
): PullRequestObservation[] {
  if (headShas.size === 0 || recentRuns.length === 0) return pullRequests;
  return pullRequests.map((pullRequest) => {
    const headSha = headShas.get(pullRequest.number);
    const checks = headSha === undefined ? null : commitChecks(headSha, recentRuns);
    return checks === null ? pullRequest : { ...pullRequest, checks };
  });
}
