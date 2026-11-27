// A run's subrequests: what the plan takes (worker/config.ts), and how what is left of the
// budget is shared among the redirects of uptime checks and the push notifications. A run never makes more than the budget.

import { MAX_UPTIME_REDIRECTS, plannedSubrequests, type Config } from './config.ts';
import type { Secrets } from './secrets.ts';
import { checkStateKey, type PreviousCheck } from './transitions.ts';

export function uptimeCheckKey(url: string): string {
  return `uptime:${url}`;
}

/** Key in an uptime check's detail_json: how many redirects the URL took when last checked. */
export const REDIRECTS_KEY = 'redirects';
/**
 * Key in an uptime check's detail_json: how many subrequests the last check was short of to
 * follow the URL's redirects. Only there while the check could not be completed.
 */
export const SHORT_KEY = 'short';

/** The redirects a stored uptime check remembers; 0 when it never had any or was never checked. */
export function rememberedRedirects(check: PreviousCheck | undefined): number {
  const stored = check?.detail[REDIRECTS_KEY];
  if (typeof stored !== 'number' || !Number.isInteger(stored) || stored < 0) return 0;
  return Math.min(stored, MAX_UPTIME_REDIRECTS);
}

/**
 * How many subrequests a stored uptime check was short of when it last got as far as a
 * redirect; null when its chain was followed to the end (or it has none).
 */
export function rememberedShort(check: PreviousCheck | undefined): number | null {
  const stored = check?.detail[SHORT_KEY];
  return typeof stored === 'number' && stored > 0 ? stored : null;
}

export interface RedirectAllowance {
  /** Keyed by checkStateKey(): redirects set aside for that URL, because it took them before. */
  reserved: ReadonlyMap<string, number>;
  /** What is left for redirects nobody knew about, shared by all URLs. */
  spare: number;
}

export interface BudgetShare {
  redirects: RedirectAllowance;
  /** How many push notifications the run may send: at most one per stored subscription. */
  pushes: number;
}

/**
 * Shares what the budget has left after the plan, in this order:
 *
 * 1. URLs whose last check was completed get the redirects it took. A chain that is known to
 *    work is always paid for while it fits, whatever happens to other URLs.
 * 2. URLs whose chain has not been followed to the end since it ran short (a check that could
 *    not reach the site in between changes nothing about that) get what they remember
 *    needing, as far as it goes. They
 *    come second, wherever they are in the config: what they remember is partly a guess (at
 *    least one more than they could follow), and it must not take a subrequest from a chain
 *    that did complete.
 * 3. One push notification per stored subscription, as far as it goes. They are set aside in
 *    every run, also one that turns out to have nothing to say, so the run can never go over.
 *    A check always comes before a notification: the email carries the alert anyway.
 * 4. The rest is spare, for redirects nobody knew about.
 *
 * Within steps 1 and 2 the order of the config decides. A URL that gets fewer than it needs
 * says so in its check (see worker/sources/uptime.ts); subscriptions that do not fit are a
 * problem on the dashboard (worker/push.ts).
 */
export function shareBudget(
  config: Config,
  secrets: Secrets,
  previous: ReadonlyMap<string, PreviousCheck>,
  pushSubscriptions: number,
): BudgetShare {
  const planned = plannedSubrequests(config, {
    github: (ownerKey) => secrets.github.has(ownerKey),
    supabase: secrets.supabase !== null,
    cloudflare: secrets.cloudflare !== null,
  });
  let left = Math.max(0, config.subrequestBudget - planned);
  const keys = config.projects.flatMap((project) =>
    project.productionUrls.map((url) => checkStateKey(project.id, uptimeCheckKey(url))),
  );
  const reserved = new Map(keys.map((key) => [key, 0]));
  const reserve = (key: string) => {
    const granted = Math.min(rememberedRedirects(previous.get(key)), left);
    reserved.set(key, granted);
    left -= granted;
  };
  const ranShort = (key: string) => rememberedShort(previous.get(key)) !== null;
  keys.filter((key) => !ranShort(key)).forEach(reserve);
  keys.filter(ranShort).forEach(reserve);
  const pushes = Math.min(pushSubscriptions, left);
  return { redirects: { reserved, spare: left - pushes }, pushes };
}
