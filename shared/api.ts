// The shapes of GET /api/status and of the push routes, shared by the Worker and the browser. Only types live here:
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
  push: PushStatus;
}

export interface PushStatus {
  /**
   * The key a browser subscribes with (the applicationServerKey of pushManager.subscribe):
   * a P-256 public key, base64url. Null when push is not set up on this installation.
   */
  vapidPublicKey: string | null;
  /**
   * How many browsers get push notifications now: the subscriptions of sessions that are still
   * signed in. One you do not recognise means someone else's browser is signed in.
   */
  devices: number;
}

/**
 * Body of POST /api/push/subscribe: what the browser's PushSubscription.toJSON() gives. Other
 * fields of it (expirationTime) may be sent along and are ignored. 204 when stored (again);
 * 400 for a body that is not a subscription; 409 when push is not set up.
 */
export interface PushSubscribeRequest {
  /** The https URL of the push service for this browser. */
  endpoint: string;
  keys: {
    /** The browser's P-256 public key, 65 bytes as unpadded base64url. */
    p256dh: string;
    /** The browser's auth secret, 16 bytes as unpadded base64url. */
    auth: string;
  };
}

/** Body of POST /api/push/unsubscribe. 204 whether or not the endpoint was stored. */
export interface PushUnsubscribeRequest {
  endpoint: string;
}

/**
 * Body of POST /api/push/test. With an endpoint only that browser gets the notification (410
 * when it is not, or no longer, subscribed: subscribe again); without one, every subscribed
 * browser. 409 when push is not set up, 429 when the hour's tests are used up.
 */
export interface PushTestRequest {
  endpoint?: string;
}

/**
 * What the push service did with one message. `gone`: it no longer knows the subscription
 * (HTTP 404 or 410), which has been deleted here too. `failed`: anything else, including no
 * answer at all.
 */
export type PushOutcome = 'sent' | 'gone' | 'failed';

export interface PushTestResult {
  outcome: PushOutcome;
  /** The push service's HTTP status; null when it did not answer. */
  status: number | null;
}

/** Answer of POST /api/push/test: one result per subscription tried, without its endpoint. */
export interface PushTestResponse {
  results: PushTestResult[];
}

/** The decrypted JSON of a push message, for the service worker's push event. */
export interface PushPayload {
  /** The subject of the alert email sent in the same run. */
  title: string;
  /** One short line, for example '2 current problems'. */
  body: string;
  /** How many problems the dashboard shows right now, for the badge on the app icon. */
  problemCount: number;
  /** The dashboard, to open when the notification is tapped. */
  url: string;
}

/** Body of POST /api/signin. */
export interface SigninRequest {
  code: string;
}
