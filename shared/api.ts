// The shape of GET /api/status, shared by the Worker and the browser. Only types live here:
// anything in shared/ ends up in the static bundle, so it must never hold project names,
// group names, repo names or other private data.

export type CheckStatus = 'ok' | 'problem' | 'unknown';

/** One row on a project card. Rows that do not apply to a project are left out (null). */
export interface CheckView {
  /** What the row is about: a hostname, 'CI', 'Supabase', a Worker script name. */
  label: string;
  status: CheckStatus;
  /** Short line, for example '200 in 312 ms', 'Failed 2 h ago', 'INACTIVE'. */
  summary: string;
  /** When the thing happened (deploy, CI run, Worker change), for "3 h ago"; null if n/a. */
  at: string | null;
  /** Where tapping the row goes (GitHub run, Supabase project, Cloudflare worker, site). */
  linkUrl: string | null;
}

export interface PullRequestView {
  number: number;
  title: string;
  url: string;
  isReviewRequestedFromMe: boolean;
}

export interface ProjectView {
  id: string;
  name: string;
  /** One per production URL. */
  sites: CheckView[];
  deploy: CheckView | null;
  ci: CheckView | null;
  pullRequests: PullRequestView[] | null;
  supabase: CheckView | null;
  /** One per Cloudflare Worker script. */
  workers: CheckView[];
}

export interface GroupView {
  /** A group name from the config. */
  group: string;
  projects: ProjectView[];
}

/** A current problem, for "Needs attention". */
export interface ProblemView {
  /** Null for a problem with a data source rather than a project (a rejected token). */
  projectId: string | null;
  title: string;
  linkUrl: string | null;
  since: string;
}

export interface EventView {
  id: string;
  projectId: string | null;
  kind: string;
  title: string;
  linkUrl: string | null;
  occurredAt: string;
}

export interface StatusResponse {
  /** When the last cron run finished (ISO 8601); null before the first run. */
  checkedAt: string | null;
  /** Newest first. */
  problems: ProblemView[];
  groups: GroupView[];
  /** Supabase projects the token sees that no project in the config names. */
  unassigned: CheckView[];
  /**
   * One row per data source (uptime, each GitHub token, Supabase, each Cloudflare account):
   * working, failing, or not configured because its token is not set.
   */
  sources: CheckView[];
  /** The latest 50 transitions, newest first. */
  events: EventView[];
}

/** Body of POST /api/signin. */
export interface SigninRequest {
  code: string;
}
