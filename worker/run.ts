import { composeAlertEmail, sendAlertEmail } from './alerts.ts';
import { deleteExpiredAccess } from './access.ts';
import { allowRedirects } from './budget.ts';
import {
  cloudflareLabel,
  cloudflareSource,
  githubLabel,
  githubSource,
  listSources,
  SUPABASE_LABEL,
  SUPABASE_SOURCE,
  UPTIME_LABEL,
  UPTIME_SOURCE,
  type Config,
} from './config.ts';
import { deleteOldSigninRequests } from './emailSignin.ts';
import type { SourceResult } from './observations.ts';
import { readSecrets, type Secrets } from './secrets.ts';
import { fetchCloudflare } from './sources/cloudflare.ts';
import { fetchGitHub } from './sources/github.ts';
import type { Fetcher } from './sources/http.ts';
import { fetchSupabase } from './sources/supabase.ts';
import { fetchUptime } from './sources/uptime.ts';
import {
  finishRun,
  loadNotifiedReviewRequests,
  loadPreviousChecks,
  loadPreviousSourceHealth,
  loadUnsentAlerts,
  markAlertsFailed,
  markAlertsSent,
  saveRun,
  startRun,
} from './store.ts';
import { evaluate, evaluateSources, type PreviousCheck } from './transitions.ts';

/**
 * One cron run, with its inputs spelled out so tests can give it a config and a fake network.
 * Only the Worker's scheduled handler calls this; no HTTP route leads here, so nobody can
 * trigger checks or emails from outside.
 */
export async function runChecks(
  env: Env,
  now: Date,
  config: Config,
  fetcher: Fetcher,
): Promise<void> {
  const nowText = now.toISOString();
  await cleanUp('codes and sessions', () => deleteExpiredAccess(env.DB, now));
  await cleanUp('sign-in requests', () => deleteOldSigninRequests(env.DB, now));
  const { isFirstRun } = await startRun(env.DB, nowText);

  const [previousChecks, previousHealth, notified] = await Promise.all([
    loadPreviousChecks(env.DB),
    loadPreviousSourceHealth(env.DB),
    loadNotifiedReviewRequests(env.DB),
  ]);
  const secrets = readSecrets(env, config);
  // After the reads: some sources need what they stored last run (failing workflows, ...).
  const { results, notConfigured } = await collectSources(
    { config, secrets, fetcher, now },
    previousChecks,
  );

  const evaluation = evaluate({
    previous: previousChecks,
    results,
    notifiedReviewRequests: notified,
    isFirstRun,
    projectNames: new Map(config.projects.map((project) => [project.id, project.name])),
    notConfiguredSources: new Set(notConfigured),
    now: nowText,
  });
  const sources = evaluateSources({
    previous: previousHealth,
    results,
    notConfigured,
    isFirstRun,
    now: nowText,
  });

  await saveRun(env.DB, {
    checks: evaluation.checks,
    health: sources.health,
    knownSources: listSources(config).map((item) => item.source),
    transitions: [...evaluation.transitions, ...sources.transitions],
    newReviewRequests: evaluation.newReviewRequests,
    removals: evaluation.removals,
    now: nowText,
  });

  await sendUnsentAlerts(env, config, nowText);
  await finishRun(env.DB, nowText);
}

interface RunContext {
  config: Config;
  secrets: Secrets;
  fetcher: Fetcher;
  now: Date;
}

interface Collected {
  results: SourceResult[];
  /** Sources whose token is missing. They are not called and never count as failing. */
  notConfigured: string[];
}

/**
 * Runs every source side by side. One that fails or throws never stops the others. A source
 * without its token is not called.
 */
async function collectSources(
  { config, secrets, fetcher, now }: RunContext,
  previous: ReadonlyMap<string, PreviousCheck>,
): Promise<Collected> {
  const notConfigured: string[] = [];
  const redirects = allowRedirects(config, secrets, previous);
  const calls: Promise<SourceResult>[] = [
    guard(UPTIME_SOURCE, UPTIME_LABEL, () =>
      fetchUptime(fetcher, config.projects, previous, redirects),
    ),
  ];
  for (const owner of config.githubOwners) {
    const source = githubSource(owner.key);
    const token = secrets.github.get(owner.key);
    if (token === undefined) notConfigured.push(source);
    else {
      calls.push(
        guard(source, githubLabel(owner), () =>
          fetchGitHub(fetcher, token, owner, config.projects, previous),
        ),
      );
    }
  }
  const { supabase, cloudflare } = secrets;
  if (supabase === null) notConfigured.push(SUPABASE_SOURCE);
  else {
    calls.push(
      guard(SUPABASE_SOURCE, SUPABASE_LABEL, () =>
        fetchSupabase(fetcher, supabase, config.projects),
      ),
    );
  }
  for (const account of config.cloudflareAccounts) {
    const source = cloudflareSource(account.key);
    if (cloudflare === null) notConfigured.push(source);
    else {
      calls.push(
        guard(source, cloudflareLabel(account), () =>
          fetchCloudflare(fetcher, cloudflare, account, config.projects, now, previous),
        ),
      );
    }
  }
  return { results: await Promise.all(calls), notConfigured };
}

/**
 * Housekeeping must never stop the checks: a cleanup that fails (for example because a
 * migration has not been applied yet) is logged and tried again on the next run.
 */
async function cleanUp(what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    // Only the error code, as everywhere else: a message could carry details of the query.
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
    console.error(`Cleanup of ${what} failed (${code})`);
  }
}

async function guard(
  source: string,
  label: string,
  run: () => Promise<SourceResult>,
): Promise<SourceResult> {
  try {
    return await run();
  } catch {
    // Not the error itself: it could carry request details. The source name is enough to look.
    console.error(`Source ${source} threw`);
    return { source, label, error: 'unexpected error', observations: [] };
  }
}

/**
 * Emails every alert not yet sent (this run's and any left over from failed sends) in one
 * message. They stay unsent until the email service accepts the message.
 */
async function sendUnsentAlerts(env: Env, config: Config, now: string): Promise<void> {
  const unsent = await loadUnsentAlerts(env.DB);
  if (unsent.length === 0) return;
  const ids = unsent.map((alert) => alert.id);
  try {
    await sendAlertEmail(env, config, composeAlertEmail(unsent, config.dashboardUrl));
  } catch (error) {
    // Only the error code: a message could echo parts of the email.
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
    console.error(`Alert email failed (${code}); ${unsent.length} alert(s) stay unsent`);
    await markAlertsFailed(env.DB, ids, now);
    return;
  }
  await markAlertsSent(env.DB, ids);
}
