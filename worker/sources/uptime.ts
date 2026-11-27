import {
  REDIRECTS_KEY,
  rememberedRedirects,
  rememberedShort,
  SHORT_KEY,
  uptimeCheckKey,
  type RedirectAllowance,
} from '../budget.ts';
import { MAX_UPTIME_REDIRECTS, UPTIME_LABEL, UPTIME_SOURCE, type Project } from '../config.ts';
import type { SourceResult, StateObservation } from '../observations.ts';
import { checkStateKey, type PreviousCheck } from '../transitions.ts';
import { REQUEST_TIMEOUT_MS, type Fetcher } from './http.ts';

// Down only after two failed runs in a row (see the transition core).
const FAILURES_TO_PROBLEM = 2;

/** Redirects beyond what was set aside per URL, shared by all the checks of one run. */
interface SpareRedirects {
  left: number;
}

/**
 * GETs every production URL of the given projects. One request per URL, and one more for every
 * redirect on the way: each is a subrequest, so redirects are followed by hand and counted. A
 * URL may take the redirects set aside for it (the ones it took last time, as far as the budget
 * goes) plus what is spare across all URLs. A redirect beyond that is not followed this run:
 * the check stays as it was and records how many subrequests it was short, which the dashboard
 * shows as a problem with the budget.
 */
export async function fetchUptime(
  fetcher: Fetcher,
  projects: readonly Project[],
  previous: ReadonlyMap<string, PreviousCheck>,
  allowance: RedirectAllowance,
): Promise<SourceResult> {
  const spare: SpareRedirects = { left: allowance.spare };
  const sites = projects.flatMap((project) =>
    project.productionUrls.map((url) => ({ project, url })),
  );
  const observations = await Promise.all(
    sites.map(({ project, url }) => {
      const key = checkStateKey(project.id, uptimeCheckKey(url));
      const redirects: SiteRedirects = {
        remembered: rememberedRedirects(previous.get(key)),
        short: rememberedShort(previous.get(key)),
        reserved: allowance.reserved.get(key) ?? 0,
        spare,
      };
      return checkSite(fetcher, project, url, redirects);
    }),
  );
  // A down site is an observation, not a failure of this source.
  return { source: UPTIME_SOURCE, label: UPTIME_LABEL, error: null, observations };
}

interface SiteRedirects {
  /** How many the URL took when last checked. */
  remembered: number;
  /** How many subrequests it was short of then; null when that chain was followed to the end. */
  short: number | null;
  /** How many of those this run set aside for it. */
  reserved: number;
  spare: SpareRedirects;
}

type Outcome =
  | { kind: 'answered'; status: number; redirects: number }
  /** A redirect the run had no subrequest left for, after following `followed` of them. */
  | { kind: 'not-followed'; followed: number }
  | { kind: 'failed'; reason: string; redirects: number };

async function checkSite(
  fetcher: Fetcher,
  project: Project,
  url: string,
  redirects: SiteRedirects,
): Promise<StateObservation> {
  const startedAt = Date.now();
  let outcome: Outcome;
  // Whether the chain was seen to its end: only then is the remembered count a known chain.
  let isChainKnown = true;
  try {
    outcome = await followRedirects(fetcher, url, redirects);
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'unreachable';
    // How far it got is not known here; what was remembered stands, a guess included.
    outcome = { kind: 'failed', reason, redirects: redirects.remembered };
    isChainKnown = redirects.short === null;
  }
  const hostname = new URL(url).hostname;
  const base = {
    type: 'state' as const,
    projectId: project.id,
    checkKey: uptimeCheckKey(url),
    kind: 'uptime' as const,
    subject: hostname,
    label: hostname,
    linkUrl: url,
    at: null,
    failuresToProblem: FAILURES_TO_PROBLEM,
  };
  if (outcome.kind === 'not-followed') {
    // At least one more than it could follow; as many as last time if that was more.
    const needed = Math.max(redirects.remembered, outcome.followed + 1);
    return {
      ...base,
      status: 'unknown',
      summary: 'Redirect not followed (subrequest budget)',
      learned: { [REDIRECTS_KEY]: needed, [SHORT_KEY]: needed - outcome.followed },
    };
  }
  // Left out when there are none, so a URL without redirects stores nothing extra. A chain that
  // ran short before and could not be reached now is still marked short: an outage must not
  // turn a guess into a chain that is paid for ahead of others.
  const learned =
    outcome.redirects > 0
      ? {
          learned: {
            [REDIRECTS_KEY]: outcome.redirects,
            ...(isChainKnown ? {} : { [SHORT_KEY]: redirects.short }),
          },
        }
      : {};
  if (outcome.kind === 'failed') {
    return { ...base, ...learned, status: 'problem', summary: outcome.reason };
  }
  const isUp = outcome.status >= 200 && outcome.status < 300;
  return {
    ...base,
    ...learned,
    status: isUp ? 'ok' : 'problem',
    summary: describeResponse(outcome.status, Date.now() - startedAt),
  };
}

async function followRedirects(
  fetcher: Fetcher,
  url: string,
  { reserved, spare }: SiteRedirects,
): Promise<Outcome> {
  let current = url;
  let planned = reserved;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetcher(current, {
      method: 'GET',
      // Not 'follow': a followed redirect is a subrequest nobody counted.
      redirect: 'manual',
      headers: { 'User-Agent': 'stackhush-uptime' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Only the status matters; do not download the page.
    await response.body?.cancel();
    const next = redirectTarget(response, current);
    if (next === null) return { kind: 'answered', status: response.status, redirects };
    if (redirects === MAX_UPTIME_REDIRECTS) {
      return { kind: 'failed', reason: 'too many redirects', redirects };
    }
    // Taken in one step, with no await in between, so parallel checks cannot both take the last.
    if (planned > 0) planned -= 1;
    else if (spare.left > 0) spare.left -= 1;
    else return { kind: 'not-followed', followed: redirects };
    current = next;
  }
}

/** Where a redirect answer points; null when the answer is not a redirect to an http(s) URL. */
function redirectTarget(response: Response, from: string): string | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get('Location');
  if (location === null || !URL.canParse(location, from)) return null;
  const target = new URL(location, from);
  return target.protocol === 'https:' || target.protocol === 'http:' ? target.href : null;
}

export function describeResponse(status: number, latencyMs: number): string {
  return `${status >= 200 && status < 300 ? status : `HTTP ${status}`} in ${latencyMs} ms`;
}
