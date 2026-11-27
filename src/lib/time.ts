const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now", "3 min ago", "2 h ago", "5 d ago". An unreadable or future time is "just now". */
export function timeAgo(iso: string, now: number): string {
  const then = Date.parse(iso);
  const elapsed = Number.isNaN(then) ? 0 : Math.max(0, now - then);
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  return `${Math.floor(elapsed / DAY_MS)} d ago`;
}

export function minutesSince(iso: string, now: number): number {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? 0 : Math.max(0, Math.floor((now - then) / MINUTE_MS));
}
