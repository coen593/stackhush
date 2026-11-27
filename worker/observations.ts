// What the sources report each run. Pure data: sources produce it, the transition core turns it
// into state changes.

import type { CheckStatus, PullRequestChecks } from '../shared/api.ts';

export type CheckKind = 'uptime' | 'deploy' | 'ci' | 'supabase' | 'worker';

/** One check of one project, as seen this run. */
export interface StateObservation {
  type: 'state';
  /** A project id from the config, or 'unassigned'. */
  projectId: string;
  /** Names the check within the project, for example 'uptime:https://example.com' or 'ci'. */
  checkKey: string;
  kind: CheckKind;
  /** Names the thing in alert titles, for example a hostname or a project name. */
  subject: string;
  /** What the dashboard row is about. */
  label: string;
  /** CI only: the branch, when it is not the default one. Alert titles name it. */
  branch?: string;
  /** 'unknown' means "could not tell this run": the previous state is kept. */
  status: CheckStatus;
  summary: string;
  linkUrl: string | null;
  /** When the thing happened (deploy time, run time, last Worker change). */
  at: string | null;
  /** Failed observations in a row before the check counts as a problem (uptime: 2). */
  failuresToProblem: number;
  /**
   * What the source needs to get back next run (for example which workflows are failing). Stored
   * in the check's detail_json next to the label.
   */
  memory?: Record<string, unknown>;
  /**
   * Like memory, but also stored when the status is 'unknown' and the rest of the stored check
   * is kept (uptime: how many redirects the URL takes, and how many subrequests the run was
   * short of to follow them).
   */
  learned?: Record<string, unknown>;
}

export interface PullRequestObservation {
  number: number;
  title: string;
  url: string;
  isReviewRequestedFromMe: boolean;
  /**
   * What the Actions runs on the PR's head commit say; only there for a repo that shows pull
   * request checks, and only when such runs are among the recent ones. Shown, never alerted on.
   */
  checks?: PullRequestChecks;
}

/** The open PRs of one repo. Not a pass/fail check; review requests become transitions. */
export interface PullRequestsObservation {
  type: 'pull_requests';
  projectId: string;
  projectName: string;
  /** 'owner/name'. */
  repo: string;
  pullRequests: PullRequestObservation[];
}

export type Observation = StateObservation | PullRequestsObservation;

/** What one source returned. A failing source can still return the observations it did get. */
export interface SourceResult {
  /** Key in source_health, for example 'github:work'. */
  source: string;
  /** Names the source in alert titles, for example 'GitHub (acme)'. */
  label: string;
  /** Safe-to-show reason ('HTTP 401', 'timed out'); null when the source worked. */
  error: string | null;
  observations: Observation[];
}
