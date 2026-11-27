import type {
  CheckStatus,
  CheckView,
  EventView,
  GroupView,
  ProblemView,
  ProjectView,
  PullRequestView,
  StatusResponse,
} from '../shared/api.ts';
import {
  cloudflareSource,
  githubSource,
  listSources,
  sourceLabel,
  SUPABASE_SOURCE,
  UNASSIGNED_PROJECT_ID,
  type Config,
  type Project,
} from './config.ts';
import { SHORT_KEY, uptimeCheckKey } from './budget.ts';
import { countSubscriptions } from './push.ts';
import { branchCiCheckKey } from './sources/github.ts';
import type { Secrets } from './secrets.ts';
import { parseDetail } from './store.ts';
import {
  NOT_CONFIGURED_ERROR,
  sourceFailingTitle,
  SOURCE_FAILURE_THRESHOLD,
} from './transitions.ts';

const EVENT_LIMIT = 50;

interface CheckRow {
  project_id: string;
  check_key: string;
  status: CheckStatus;
  summary: string;
  link_url: string | null;
  detail_json: string;
  problem_since: string | null;
  /** When the row last changed: unchanged rows are not rewritten. */
  observed_at: string;
}

/** Alerts whose email has failed at least once and is still waiting to be sent. */
interface UnsentRow {
  total: number;
  oldest_occurred_at: string | null;
}

interface SourceRow {
  source: string;
  consecutive_failures: number;
  last_error: string | null;
  last_attempt_at: string;
  last_success_at: string | null;
}

interface EventRow {
  id: string;
  project_id: string | null;
  kind: string;
  title: string;
  link_url: string | null;
  occurred_at: string;
}

/** Builds GET /api/status from D1, the config and which tokens are set. */
export async function loadStatus(
  db: D1Database,
  config: Config,
  secrets: Secrets,
  now: Date,
): Promise<StatusResponse> {
  const { projects } = config;
  const [run, checks, sources, events, failingEvents, unsent, push] = await Promise.all([
    db
      .prepare('SELECT last_run_finished_at FROM run_state WHERE id = 1')
      .first<{ last_run_finished_at: string | null }>(),
    db
      .prepare(
        'SELECT project_id, check_key, status, summary, link_url, detail_json, problem_since, observed_at FROM check_states',
      )
      .all<CheckRow>(),
    db
      .prepare(
        'SELECT source, consecutive_failures, last_error, last_attempt_at, last_success_at FROM source_health',
      )
      .all<SourceRow>(),
    db
      .prepare(
        'SELECT id, project_id, kind, title, link_url, occurred_at FROM events ORDER BY occurred_at DESC, id LIMIT ?',
      )
      .bind(EVENT_LIMIT)
      .all<EventRow>(),
    db
      .prepare(
        "SELECT check_key, MAX(occurred_at) AS occurred_at FROM events WHERE kind = 'source_failing' GROUP BY check_key",
      )
      .all<{ check_key: string; occurred_at: string }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total, MIN(events.occurred_at) AS oldest_occurred_at
         FROM unsent_alerts JOIN events ON events.id = unsent_alerts.event_id
         WHERE unsent_alerts.attempts > 0`,
      )
      .first<UnsentRow>(),
    loadPushState(db, now),
  ]);

  const configured = sources.results.filter((row) => isConfigured(row.source, secrets));
  // The rows of a source without its token are kept in the database but say nothing current:
  // they are left out, and the source is listed as not configured.
  const current = checks.results.filter((row) => {
    const source = parseDetail(row.detail_json)['source'];
    return typeof source !== 'string' || isConfigured(source, secrets);
  });
  const byProject = groupChecks(current);
  const groups = buildGroups(byProject, config);
  return {
    checkedAt: run?.last_run_finished_at ?? null,
    problems: [
      ...checkProblems(current, projects),
      ...budgetProblems(current),
      ...sourceProblems(configured, failingEvents.results, config),
      ...emailProblems(unsent),
      ...pushProblems(secrets, push, run?.last_run_finished_at ?? now.toISOString()),
    ].sort((a, b) => b.since.localeCompare(a.since)),
    groups,
    unassigned: (byProject.get(UNASSIGNED_PROJECT_ID) ?? []).map(toCheckView),
    sources: listSources(config).map(({ source, label }) =>
      toSourceView(
        label,
        isConfigured(source, secrets),
        sources.results.find((row) => row.source === source),
      ),
    ),
    events: events.results.map(toEventView),
    push: {
      vapidPublicKey: secrets.vapid.kind === 'ready' ? secrets.vapid.keys.publicKey : null,
      keys: secrets.vapid.kind,
      devices: push.devices,
    },
  };
}

function groupChecks(rows: readonly CheckRow[]): Map<string, CheckRow[]> {
  const byProject = new Map<string, CheckRow[]>();
  for (const row of rows) {
    const list = byProject.get(row.project_id) ?? [];
    list.push(row);
    byProject.set(row.project_id, list);
  }
  return byProject;
}

function buildGroups(byProject: ReadonlyMap<string, CheckRow[]>, config: Config): GroupView[] {
  return config.groups
    .map((group) => ({
      group,
      projects: config.projects
        // A project with no observations yet (before the first run) has nothing to show.
        .filter((project) => project.group === group && byProject.has(project.id))
        .map((project) => buildProject(project, byProject.get(project.id) ?? [])),
    }))
    .filter((group) => group.projects.length > 0);
}

function buildProject(project: Project, rows: readonly CheckRow[]): ProjectView {
  const byKey = new Map(rows.map((row) => [row.check_key, row]));
  const view = (key: string): CheckView | null => {
    const row = byKey.get(key);
    return row ? toCheckView(row) : null;
  };
  return {
    id: project.id,
    name: project.name,
    sites: project.productionUrls.flatMap((url) => view(uptimeCheckKey(url)) ?? []),
    deploy: view('deploy'),
    ci: view('ci'),
    ...branchCiViews(project, view),
    pullRequests: readPullRequests(byKey.get('prs')),
    supabase: project.supabaseRef ? view(`supabase:${project.supabaseRef}`) : null,
    workers: (project.cloudflare?.scripts ?? []).flatMap(
      (script) => view(`worker:${script}`) ?? [],
    ),
  };
}

/**
 * The CI rows of the extra branches, in the config's order. The field is left out for a repo
 * without any, so the answer for a config that has none is what it always was.
 */
function branchCiViews(
  project: Project,
  view: (key: string) => CheckView | null,
): Pick<ProjectView, 'branchCi'> {
  const branches = project.github?.extraBranches ?? [];
  if (branches.length === 0) return {};
  return { branchCi: branches.flatMap((branch) => view(branchCiCheckKey(branch)) ?? []) };
}

function toCheckView(row: CheckRow): CheckView {
  const detail = parseDetail(row.detail_json);
  return {
    label: typeof detail['label'] === 'string' ? detail['label'] : row.check_key,
    status: row.status,
    summary: row.summary,
    at: typeof detail['at'] === 'string' ? detail['at'] : null,
    linkUrl: row.link_url,
  };
}

function readPullRequests(row: CheckRow | undefined): PullRequestView[] | null {
  if (!row) return null;
  const list = parseDetail(row.detail_json)['pullRequests'];
  return Array.isArray(list) ? (list as PullRequestView[]) : [];
}

function checkProblems(rows: readonly CheckRow[], projects: readonly Project[]): ProblemView[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return rows
    .filter((row) => row.status === 'problem')
    .map((row) => {
      const view = toCheckView(row);
      const owner = names.get(row.project_id) ?? 'Unassigned';
      return {
        projectId: row.project_id,
        title: `${owner}: ${view.label} - ${row.summary}`,
        linkUrl: row.link_url,
        since: row.problem_since ?? row.observed_at,
      };
    });
}

const UPTIME_KEY_PREFIX = uptimeCheckKey('');

/**
 * Uptime checks that could not follow their redirects because the run had no subrequest left
 * (see worker/sources/uptime.ts). Such a site keeps the state it had, so without this nobody
 * would know it is no longer really checked.
 */
function budgetProblems(rows: readonly CheckRow[]): ProblemView[] {
  return rows.flatMap((row) => {
    const short = parseDetail(row.detail_json)[SHORT_KEY];
    if (typeof short !== 'number' || short <= 0) return [];
    const url = row.check_key.slice(UPTIME_KEY_PREFIX.length);
    return [
      {
        projectId: row.project_id,
        title: `Over the subrequest budget: ${url} needs at least ${short} more; raise subrequestBudget or remove checks`,
        linkUrl: null,
        since: row.observed_at,
      },
    ];
  });
}

/** Whether the token a source needs is set. Uptime needs none. */
function isConfigured(source: string, secrets: Secrets): boolean {
  if (source === SUPABASE_SOURCE) return secrets.supabase !== null;
  if (source.startsWith(cloudflareSource(''))) return secrets.cloudflare !== null;
  const githubPrefix = githubSource('');
  if (source.startsWith(githubPrefix)) return secrets.github.has(source.slice(githubPrefix.length));
  return true;
}

/** A source for the dashboard's list. A problem only once it has failed long enough to alert. */
function toSourceView(label: string, isSet: boolean, row: SourceRow | undefined): CheckView {
  const base = { label, at: null, linkUrl: null };
  if (!isSet) return { ...base, status: 'unknown', summary: 'Not configured (no token set)' };
  // A token set since the last run: the row still says what was true then.
  if (!row || row.last_error === NOT_CONFIGURED_ERROR) {
    return { ...base, status: 'unknown', summary: 'Not checked yet' };
  }
  if (row.consecutive_failures === 0) return { ...base, status: 'ok', summary: 'Working' };
  const runs = row.consecutive_failures === 1 ? '1 run' : `${row.consecutive_failures} runs`;
  return {
    ...base,
    status: row.consecutive_failures >= SOURCE_FAILURE_THRESHOLD ? 'problem' : 'unknown',
    summary: `Failing for ${runs} (${row.last_error ?? 'unknown error'})`,
  };
}

function sourceProblems(
  rows: readonly SourceRow[],
  failingEvents: readonly { check_key: string; occurred_at: string }[],
  config: Config,
): ProblemView[] {
  return rows
    .filter((row) => row.consecutive_failures >= SOURCE_FAILURE_THRESHOLD)
    .map((row) => {
      const since = failingEvents.find((event) => event.check_key === `source:${row.source}`);
      return {
        projectId: null,
        title: sourceFailingTitle(sourceLabel(config, row.source), row.last_error ?? 'failing'),
        linkUrl: null,
        since: since?.occurred_at ?? row.last_attempt_at,
      };
    });
}

/**
 * A failing alert email is otherwise invisible: the alerts wait in unsent_alerts and nothing
 * arrives. One problem for the whole queue, since the oldest alert that could not be sent.
 */
function emailProblems(unsent: UnsentRow | null): ProblemView[] {
  if (!unsent || unsent.total === 0 || unsent.oldest_occurred_at === null) return [];
  const since = unsent.oldest_occurred_at;
  // '2026-11-26T12:05:00.000Z' -> '2026-11-26 12:05 UTC'
  const sinceText = `${since.slice(0, 10)} ${since.slice(11, 16)} UTC`;
  return [
    {
      projectId: null,
      title: `Alert email failing: ${unsent.total} unsent since ${sinceText}`,
      linkUrl: null,
      since,
    },
  ];
}

interface PushState {
  /** Subscriptions the last run had no subrequest for. */
  short: number;
  devices: number;
}

/**
 * What the dashboard says about push, read apart from everything else: a database that does
 * not have the push migration yet (a Worker deployed ahead of its schema) must still show its
 * status, with push at nothing.
 */
async function loadPushState(db: D1Database, now: Date): Promise<PushState> {
  try {
    const [run, devices] = await Promise.all([
      db.prepare('SELECT push_short FROM run_state WHERE id = 1').first<{ push_short: number }>(),
      countSubscriptions(db, now),
    ]);
    return { short: run?.push_short ?? 0, devices };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
    console.error(`Reading the push state failed (${code}); shown as none`);
    return { short: 0, devices: 0 };
  }
}

/**
 * Push is optional: without its keys there is nothing to say. Two things are worth a line.
 * Keys that are set but are not a key pair, because then the owner believes push works. And
 * subscriptions the last run had no subrequest left for (worker/run.ts): the email still went
 * out, but that phone stays silent until the budget has room.
 */
function pushProblems(secrets: Secrets, push: PushState, since: string): ProblemView[] {
  if (secrets.vapid.kind === 'invalid') {
    return [
      {
        projectId: null,
        title:
          'Push keys are not valid: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be one pair; run npm run push-keys',
        linkUrl: null,
        since,
      },
    ];
  }
  if (secrets.vapid.kind === 'absent' || push.short === 0) return [];
  const devices = push.short === 1 ? '1 device' : `${push.short} devices`;
  return [
    {
      projectId: null,
      title: `Over the subrequest budget: no push notification for ${devices}; raise subrequestBudget or remove checks`,
      linkUrl: null,
      since,
    },
  ];
}

function toEventView(row: EventRow): EventView {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    linkUrl: row.link_url,
    occurredAt: row.occurred_at,
  };
}
