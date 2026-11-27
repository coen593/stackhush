// The pure core of the alerts: (previous state, new observations) -> (new state, transitions).
// No I/O here, so every rule can be tested without a database or the network.

import type { CheckStatus } from '../shared/api.ts';
import { UNASSIGNED_PROJECT_ID } from './config.ts';
import type {
  CheckKind,
  Observation,
  PullRequestObservation,
  SourceResult,
  StateObservation,
} from './observations.ts';

/** A source that fails this many runs in a row is itself a problem. */
export const SOURCE_FAILURE_THRESHOLD = 3;

export type TransitionKind =
  | 'site_down'
  | 'site_up'
  | 'deploy_failed'
  | 'deploy_ok'
  | 'ci_red'
  | 'ci_green'
  | 'supabase_unhealthy'
  | 'supabase_healthy'
  | 'worker_errors'
  | 'worker_ok'
  | 'review_requested'
  | 'source_failing'
  | 'source_ok';

export interface Transition {
  /** Null for a transition about a source (a rejected token). */
  projectId: string | null;
  checkKey: string;
  kind: TransitionKind;
  title: string;
  linkUrl: string | null;
  occurredAt: string;
}

/** A row of check_states as it was before this run. */
export interface PreviousCheck {
  projectId: string;
  checkKey: string;
  status: CheckStatus;
  consecutiveFailures: number;
  summary: string;
  linkUrl: string | null;
  /** The parsed detail_json: label, the source that reported the check, and its memory. */
  detail: Record<string, unknown>;
  problemSince: string | null;
}

/** A row of check_states to write after this run. */
export interface CheckWrite {
  projectId: string;
  checkKey: string;
  status: CheckStatus;
  consecutiveFailures: number;
  summary: string;
  linkUrl: string | null;
  detail: Record<string, unknown>;
  problemSince: string | null;
  observedAt: string;
}

export interface ReviewRequestKey {
  repo: string;
  prNumber: number;
}

/** A check that is no longer reported: its row is deleted and an event says so, without email. */
export interface Removal {
  projectId: string;
  checkKey: string;
  title: string;
}

export interface EvaluateInput {
  /** Keyed by checkStateKey(). */
  previous: ReadonlyMap<string, PreviousCheck>;
  /** What every source returned this run, failed sources included. */
  results: readonly SourceResult[];
  /** Keyed by reviewRequestKey(): PRs whose review request was already alerted. */
  notifiedReviewRequests: ReadonlySet<string>;
  /** True until a first run has finished: record everything, alert on nothing. */
  isFirstRun: boolean;
  /** Project id -> name, for the titles of removal events. */
  projectNames: ReadonlyMap<string, string>;
  /**
   * Sources whose token is not set. They were not called, which says nothing about their
   * checks: the stored rows stay exactly as they are until the token is back.
   */
  notConfiguredSources: ReadonlySet<string>;
  now: string;
}

export interface EvaluateResult {
  /** Only the rows that differ from what is stored. */
  checks: CheckWrite[];
  transitions: Transition[];
  /** Review requests to remember as alerted (including ones seeded silently). */
  newReviewRequests: ReviewRequestKey[];
  removals: Removal[];
}

export const PULL_REQUESTS_CHECK_KEY = 'prs';

export function checkStateKey(projectId: string, checkKey: string): string {
  return `${projectId}|${checkKey}`;
}

export function reviewRequestKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

interface Phrases {
  problem: TransitionKind;
  recovery: TransitionKind;
  problemTitle: (subject: string, summary: string) => string;
  recoveryTitle: (subject: string) => string;
}

const PHRASES: Record<CheckKind, Phrases> = {
  uptime: {
    problem: 'site_down',
    recovery: 'site_up',
    problemTitle: (subject, summary) => `${subject} is down (${summary})`,
    recoveryTitle: (subject) => `${subject} is back up`,
  },
  deploy: {
    problem: 'deploy_failed',
    recovery: 'deploy_ok',
    problemTitle: (subject) => `${subject}: production deploy failed`,
    recoveryTitle: (subject) => `${subject}: production deploy succeeded`,
  },
  ci: {
    problem: 'ci_red',
    recovery: 'ci_green',
    problemTitle: (subject) => `${subject}: CI on the default branch went red`,
    recoveryTitle: (subject) => `${subject}: CI on the default branch is green again`,
  },
  supabase: {
    problem: 'supabase_unhealthy',
    recovery: 'supabase_healthy',
    problemTitle: (subject, summary) => `${subject}: Supabase project not healthy (${summary})`,
    recoveryTitle: (subject) => `${subject}: Supabase project is healthy again`,
  },
  worker: {
    problem: 'worker_errors',
    recovery: 'worker_ok',
    problemTitle: (subject, summary) => `${subject}: Worker errors over threshold (${summary})`,
    recoveryTitle: (subject) => `${subject}: Worker errors are back under the threshold`,
  },
};

/** What the per-observation rules need to know about the run and the source they belong to. */
interface SourceContext {
  previous: ReadonlyMap<string, PreviousCheck>;
  notifiedReviewRequests: ReadonlySet<string>;
  now: string;
  source: string;
  /** Record without alerting: the first run, or the first time this source reports anything. */
  isSeeding: boolean;
}

export function evaluate(input: EvaluateInput): EvaluateResult {
  const result: EvaluateResult = {
    checks: [],
    transitions: [],
    newReviewRequests: [],
    removals: [],
  };
  const sourcesWithState = new Set<unknown>();
  for (const check of input.previous.values()) sourcesWithState.add(check.detail['source']);

  const reported = new Set<string>();
  for (const { source, observations } of input.results) {
    const context: SourceContext = {
      previous: input.previous,
      notifiedReviewRequests: input.notifiedReviewRequests,
      now: input.now,
      source,
      // A source that only starts working after the first run (a token fixed later) has a
      // backlog of existing problems and review requests. That is its starting point, not news.
      isSeeding: input.isFirstRun || !sourcesWithState.has(source),
    };
    for (const observation of observations) {
      if (observation.type === 'state') {
        reported.add(checkStateKey(observation.projectId, observation.checkKey));
        evaluateState(context, observation, result);
      } else {
        reported.add(checkStateKey(observation.projectId, PULL_REQUESTS_CHECK_KEY));
        evaluatePullRequests(context, observation, result);
      }
    }
  }

  result.checks = result.checks.filter((check) =>
    isChanged(input.previous.get(checkStateKey(check.projectId, check.checkKey)), check),
  );
  result.removals = findRemovals(input, reported);
  return result;
}

/** Unchanged rows are not written again: D1's free plan counts every row written. */
function isChanged(previous: PreviousCheck | undefined, check: CheckWrite): boolean {
  if (!previous) return true;
  return (
    previous.status !== check.status ||
    previous.consecutiveFailures !== check.consecutiveFailures ||
    previous.summary !== check.summary ||
    previous.linkUrl !== check.linkUrl ||
    previous.problemSince !== check.problemSince ||
    JSON.stringify(previous.detail) !== JSON.stringify(check.detail)
  );
}

/**
 * Stored checks that nothing reported this run (a URL taken out of the config, a deleted
 * Supabase project, a renamed source). They go, unless the source they came from failed this
 * run or has no token set: such a source says nothing about what still exists.
 */
function findRemovals(input: EvaluateInput, reported: ReadonlySet<string>): Removal[] {
  const silentSources = new Set<unknown>([
    ...input.results.filter((result) => result.error !== null).map((result) => result.source),
    ...input.notConfiguredSources,
  ]);
  const removals: Removal[] = [];
  for (const [key, check] of input.previous) {
    if (reported.has(key) || silentSources.has(check.detail['source'])) continue;
    removals.push({
      projectId: check.projectId,
      checkKey: check.checkKey,
      title: `${ownerName(input, check.projectId)}: ${checkLabel(check)} no longer watched`,
    });
  }
  return removals;
}

// A project that left the config has no name any more; its id is all that is known.
function ownerName(input: EvaluateInput, projectId: string): string {
  if (projectId === UNASSIGNED_PROJECT_ID) return 'Unassigned';
  return input.projectNames.get(projectId) ?? projectId;
}

function checkLabel(check: PreviousCheck): string {
  if (check.checkKey === PULL_REQUESTS_CHECK_KEY) return 'Open PRs';
  const label = check.detail['label'];
  return typeof label === 'string' ? label : check.checkKey;
}

function evaluateState(
  context: SourceContext,
  observation: StateObservation,
  result: EvaluateResult,
): void {
  const previous = context.previous.get(checkStateKey(observation.projectId, observation.checkKey));
  const base = {
    projectId: observation.projectId,
    checkKey: observation.checkKey,
    linkUrl: observation.linkUrl,
    detail: {
      label: observation.label,
      at: observation.at,
      source: context.source,
      ...observation.memory,
      ...observation.learned,
    },
    observedAt: context.now,
  };

  // "Could not tell": keep what we knew, plus what the source learnt all the same. A check seen
  // for the first time is recorded as unknown.
  if (observation.status === 'unknown') {
    if (previous) {
      if (observation.learned === undefined) return;
      result.checks.push({
        projectId: previous.projectId,
        checkKey: previous.checkKey,
        status: previous.status,
        consecutiveFailures: previous.consecutiveFailures,
        summary: previous.summary,
        linkUrl: previous.linkUrl,
        detail: { ...previous.detail, ...observation.learned },
        problemSince: previous.problemSince,
        observedAt: context.now,
      });
      return;
    }
    result.checks.push({
      ...base,
      status: 'unknown',
      consecutiveFailures: 0,
      summary: observation.summary,
      problemSince: null,
    });
    return;
  }

  const phrases = PHRASES[observation.kind];

  if (observation.status === 'ok') {
    result.checks.push({
      ...base,
      status: 'ok',
      consecutiveFailures: 0,
      summary: observation.summary,
      problemSince: null,
    });
    if (previous?.status === 'problem') {
      addTransition(context, result, {
        projectId: observation.projectId,
        checkKey: observation.checkKey,
        kind: phrases.recovery,
        title: phrases.recoveryTitle(observation.subject),
        linkUrl: observation.linkUrl,
      });
    }
    return;
  }

  const failures = (previous?.consecutiveFailures ?? 0) + 1;
  if (failures < observation.failuresToProblem) {
    // Debounce: not yet a problem. Keep the old status; a check never seen before stays unknown.
    result.checks.push({
      ...base,
      status: previous?.status ?? 'unknown',
      consecutiveFailures: failures,
      summary: `${observation.summary} (checking again)`,
      problemSince: previous?.problemSince ?? null,
    });
    return;
  }

  result.checks.push({
    ...base,
    status: 'problem',
    consecutiveFailures: failures,
    summary: observation.summary,
    problemSince: previous?.problemSince ?? context.now,
  });
  // News unless it already was a problem. A check that shows up as a problem after the first
  // run (a new Supabase project, a URL added to the config) alerts too.
  if (previous?.status !== 'problem') {
    addTransition(context, result, {
      projectId: observation.projectId,
      checkKey: observation.checkKey,
      kind: phrases.problem,
      title: phrases.problemTitle(observation.subject, observation.summary),
      linkUrl: observation.linkUrl,
    });
  }
}

function evaluatePullRequests(
  context: SourceContext,
  observation: Extract<Observation, { type: 'pull_requests' }>,
  result: EvaluateResult,
): void {
  const requested = observation.pullRequests.filter((pr) => pr.isReviewRequestedFromMe);
  result.checks.push({
    projectId: observation.projectId,
    checkKey: PULL_REQUESTS_CHECK_KEY,
    status: 'ok',
    consecutiveFailures: 0,
    summary: summarizePullRequests(observation.pullRequests.length, requested.length),
    linkUrl: `https://github.com/${observation.repo}/pulls`,
    detail: { pullRequests: observation.pullRequests, source: context.source },
    problemSince: null,
    observedAt: context.now,
  });

  for (const pr of requested) {
    if (context.notifiedReviewRequests.has(reviewRequestKey(observation.repo, pr.number))) continue;
    result.newReviewRequests.push({ repo: observation.repo, prNumber: pr.number });
    addTransition(context, result, {
      projectId: observation.projectId,
      checkKey: `pr:${observation.repo}#${pr.number}`,
      kind: 'review_requested',
      title: reviewTitle(observation.projectName, pr),
      linkUrl: pr.url,
    });
  }
}

function reviewTitle(projectName: string, pr: PullRequestObservation): string {
  return `${projectName}: review requested on PR #${pr.number} (${pr.title})`;
}

function summarizePullRequests(open: number, requested: number): string {
  if (open === 0) return 'No open PRs';
  const openText = `${open} open`;
  return requested === 0 ? openText : `${openText}, ${requested} need your review`;
}

type NewTransition = Omit<Transition, 'occurredAt'>;

// While seeding, state is only recorded. Everything seen then is the starting point, not news.
function addTransition(context: SourceContext, result: EvaluateResult, transition: NewTransition) {
  if (context.isSeeding) return;
  result.transitions.push({ ...transition, occurredAt: context.now });
}

// Sources ----------------------------------------------------------------------------------

/** A row of source_health as it was before this run. */
export interface PreviousSourceHealth {
  consecutiveFailures: number;
  lastSuccessAt: string | null;
}

export interface SourceHealthWrite {
  source: string;
  consecutiveFailures: number;
  lastError: string | null;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
}

export interface EvaluateSourcesResult {
  health: SourceHealthWrite[];
  transitions: Transition[];
}

/** What source_health says about a source whose token is missing. Never counted as a failure. */
export const NOT_CONFIGURED_ERROR = 'not configured';

export interface EvaluateSourcesInput {
  previous: ReadonlyMap<string, PreviousSourceHealth>;
  /** What the sources that were called returned. */
  results: readonly SourceResult[];
  /** Sources whose token is not set. */
  notConfigured: readonly string[];
  isFirstRun: boolean;
  now: string;
}

/** The health rows of the sources that were called and of the ones without a token. */
export function evaluateSources(input: EvaluateSourcesInput): EvaluateSourcesResult {
  const { previous, results, notConfigured, isFirstRun, now } = input;
  const output: EvaluateSourcesResult = { health: [], transitions: [] };
  for (const source of notConfigured) {
    output.health.push({
      source,
      consecutiveFailures: 0,
      lastError: NOT_CONFIGURED_ERROR,
      lastAttemptAt: now,
      lastSuccessAt: previous.get(source)?.lastSuccessAt ?? null,
    });
  }
  for (const result of results) {
    const before = previous.get(result.source);
    const failuresBefore = before?.consecutiveFailures ?? 0;
    const failures = result.error === null ? 0 : failuresBefore + 1;
    output.health.push({
      source: result.source,
      consecutiveFailures: failures,
      lastError: result.error,
      lastAttemptAt: now,
      lastSuccessAt: result.error === null ? now : (before?.lastSuccessAt ?? null),
    });
    if (isFirstRun) continue;

    const transition = { projectId: null, checkKey: `source:${result.source}`, linkUrl: null };
    // Exactly at the threshold, so it fires once and not on every run after.
    if (result.error !== null && failures === SOURCE_FAILURE_THRESHOLD) {
      output.transitions.push({
        ...transition,
        kind: 'source_failing',
        title: sourceFailingTitle(result.label, result.error),
        occurredAt: now,
      });
    }
    if (result.error === null && failuresBefore >= SOURCE_FAILURE_THRESHOLD) {
      output.transitions.push({
        ...transition,
        kind: 'source_ok',
        title: `${result.label} is working again`,
        occurredAt: now,
      });
    }
  }
  return output;
}

const REJECTED_ERRORS: readonly string[] = ['HTTP 401', 'HTTP 403'];

export function sourceFailingTitle(label: string, error: string): string {
  if (REJECTED_ERRORS.includes(error)) return `${label} token was rejected (${error})`;
  return `${label} has failed ${SOURCE_FAILURE_THRESHOLD} runs in a row (${error})`;
}
