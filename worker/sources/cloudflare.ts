import type { SourceResult, StateObservation } from '../observations.ts';
import {
  cloudflareLabel,
  cloudflareSource,
  type CloudflareAccount,
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

const API_URL = 'https://api.cloudflare.com/client/v4';
const WINDOW_MS = 30 * 60 * 1000;
const MIN_REQUESTS = 20;
const ERROR_RATE_LIMIT = 0.05;

// Statuses of workersInvocationsAdaptive that are not the Worker's fault. Anything else that is
// not 'success' counts as an error; 'exceeded...' statuses are resource errors.
const NEUTRAL_STATUSES: readonly string[] = [
  'success',
  'clientDisconnected',
  'responseStreamDisconnected',
];

const ANALYTICS_QUERY = `query($accountTag: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until }) {
        dimensions { scriptName status }
        sum { requests }
      }
    }
  }
}`;

export interface ScriptTraffic {
  requests: number;
  errors: number;
  resourceErrors: number;
}

/**
 * Two requests per account: invocations of the last 30 minutes, and the scripts' modified times.
 * The one token covers every account; an account without scripts in the config is not called.
 */
export async function fetchCloudflare(
  fetcher: Fetcher,
  token: string,
  account: CloudflareAccount,
  projects: readonly Project[],
  now: Date,
  previous: ReadonlyMap<string, PreviousCheck>,
): Promise<SourceResult> {
  const result: SourceResult = {
    source: cloudflareSource(account.key),
    label: cloudflareLabel(account),
    error: null,
    observations: [],
  };
  const scripts = projects.flatMap((project) =>
    project.cloudflare?.accountKey === account.key
      ? project.cloudflare.scripts.map((script) => ({ project, script }))
      : [],
  );
  if (scripts.length === 0) return result;

  const { accountId } = account;

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const since = new Date(now.getTime() - WINDOW_MS).toISOString();
  const [analytics, modified] = await Promise.allSettled([
    fetchJson(fetcher, `${API_URL}/graphql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: ANALYTICS_QUERY,
        variables: { accountTag: accountId, since, until: now.toISOString() },
      }),
    }).then(parseAnalytics),
    fetchJson(fetcher, `${API_URL}/accounts/${accountId}/workers/scripts`, { headers }).then(
      parseScriptList,
    ),
  ]);

  // Without traffic numbers there is nothing to judge; without modified times only "at" is lost.
  if (analytics.status === 'rejected')
    return { ...result, error: safeErrorMessage(analytics.reason) };
  if (modified.status === 'rejected') result.error = safeErrorMessage(modified.reason);
  const modifiedTimes =
    modified.status === 'fulfilled' ? modified.value : new Map<string, string>();

  result.observations = scripts.map(({ project, script }) =>
    workerObservation(
      project,
      script,
      accountId,
      analytics.value.get(script) ?? { requests: 0, errors: 0, resourceErrors: 0 },
      modifiedTimes.get(script) ?? null,
      previous.get(checkStateKey(project.id, workerCheckKey(script))),
    ),
  );
  return result;
}

export function parseAnalytics(body: unknown): Map<string, ScriptTraffic> {
  const root = readRecord(body);
  const errors = root['errors'];
  if (Array.isArray(errors) && errors.length > 0) throw new SourceError('GraphQL error');
  const data = readRecord(root['data']);
  const viewer = readRecord(data['viewer']);
  const accounts = readArray(viewer, 'accounts');
  const first = accounts[0];
  if (!isRecord(first)) throw new SourceError('invalid response');

  const traffic = new Map<string, ScriptTraffic>();
  for (const row of readArray(first, 'workersInvocationsAdaptive')) {
    const record = readRecord(row);
    const dimensions = readRecord(record['dimensions']);
    const script = readString(dimensions, 'scriptName');
    const status = readString(dimensions, 'status');
    const requests = readNumber(readRecord(record['sum']), 'requests');
    const entry = traffic.get(script) ?? { requests: 0, errors: 0, resourceErrors: 0 };
    entry.requests += requests;
    if (!NEUTRAL_STATUSES.includes(status)) entry.errors += requests;
    if (status.startsWith('exceeded')) entry.resourceErrors += requests;
    traffic.set(script, entry);
  }
  return traffic;
}

/** Script name -> last modified time. A script without one is left out: the time is only shown. */
export function parseScriptList(body: unknown): Map<string, string> {
  const modified = new Map<string, string>();
  for (const item of readArray(readRecord(body), 'result')) {
    const script = readRecord(item);
    const modifiedOn = script['modified_on'];
    if (typeof modifiedOn === 'string') modified.set(readString(script, 'id'), modifiedOn);
  }
  return modified;
}

function workerCheckKey(script: string): string {
  return `worker:${script}`;
}

/**
 * Judges one script. The status only changes after two runs in a row on the other side of the
 * threshold, so traffic that hovers around it (19 requests, then 20) does not alert back and
 * forth. Until then the previous status stands; a script never seen before starts as ok.
 */
export function workerObservation(
  project: Project,
  script: string,
  accountId: string,
  traffic: ScriptTraffic,
  modifiedOn: string | null,
  previous: PreviousCheck | undefined,
): StateObservation {
  const errorRate = traffic.requests === 0 ? 0 : traffic.errors / traffic.requests;
  const isOverThreshold =
    traffic.resourceErrors > 0 ||
    (traffic.requests >= MIN_REQUESTS && errorRate > ERROR_RATE_LIMIT);
  const isConfirmed = previous?.detail['isOverThreshold'] === isOverThreshold;
  const wasProblem = previous?.status === 'problem';
  const isProblem = isConfirmed ? isOverThreshold : wasProblem;
  return {
    type: 'state',
    projectId: project.id,
    checkKey: workerCheckKey(script),
    kind: 'worker',
    subject: `${project.name} (${script})`,
    label: script,
    status: isProblem ? 'problem' : 'ok',
    summary: describeTraffic(traffic, errorRate),
    linkUrl: `https://dash.cloudflare.com/${accountId}/workers/services/view/${script}/production`,
    at: modifiedOn,
    failuresToProblem: 1,
    memory: { isOverThreshold },
  };
}

function describeTraffic(traffic: ScriptTraffic, errorRate: number): string {
  if (traffic.requests === 0) return 'No requests in 30 min';
  const percent = Math.round(errorRate * 1000) / 10;
  const resource = traffic.resourceErrors > 0 ? `, ${traffic.resourceErrors} out of resources` : '';
  return `${traffic.errors} of ${traffic.requests} failed (${percent}%)${resource}`;
}
