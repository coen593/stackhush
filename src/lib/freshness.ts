import { minutesSince } from './time.ts';

// The cron runs every 5 minutes; this many minutes without a run means the checks themselves
// have stopped.
const STALE_AFTER_MINUTES = 15;

/**
 * How far the dashboard can be trusted right now:
 * - 'waiting': no cron run has finished yet.
 * - 'refresh-failed': the page could not load the latest status; it shows an older one.
 * - 'stale': the page is up to date, but the checks have not run for a while.
 * - 'fresh': the last check is recent and was just loaded.
 * Only 'fresh' may show a confident "All good".
 */
export type Freshness = 'waiting' | 'refresh-failed' | 'stale' | 'fresh';

export function freshnessOf(
  checkedAt: string | null,
  refreshFailed: boolean,
  now: number,
): Freshness {
  if (refreshFailed) return 'refresh-failed';
  if (checkedAt === null) return 'waiting';
  return minutesSince(checkedAt, now) >= STALE_AFTER_MINUTES ? 'stale' : 'fresh';
}
