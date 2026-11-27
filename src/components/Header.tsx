import { freshnessOf } from '../lib/freshness.ts';
import { timeAgo } from '../lib/time.ts';
import { OkIcon, ProblemIcon, UnknownIcon } from './icons.tsx';

interface HeaderProps {
  checkedAt: string | null;
  problemCount: number;
  /** The last attempt to load the status failed; what is shown is an older result. */
  refreshFailed: boolean;
  now: number;
}

export default function Header({ checkedAt, problemCount, refreshFailed, now }: HeaderProps) {
  const freshness = freshnessOf(checkedAt, refreshFailed, now);
  const hasProblems = problemCount > 0;

  let heading = 'All good';
  if (hasProblems) heading = problemCount === 1 ? '1 problem' : `${problemCount} problems`;
  if (checkedAt === null) heading = 'Waiting for the first check';

  // Green only when the result is recent and was just loaded; otherwise "All good" is a guess.
  const isConfident = freshness === 'fresh';
  const tone = hasProblems ? 'text-bad' : isConfident ? 'text-ok' : 'text-warn';
  return (
    <header className="pb-2 pt-6">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">stackhush</p>
      {freshness === 'refresh-failed' && (
        <p
          className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-sm font-medium text-bad"
          role="alert"
        >
          Could not refresh.{' '}
          {checkedAt === null
            ? 'Nothing below is current.'
            : `What you see below was checked ${timeAgo(checkedAt, now)}.`}
        </p>
      )}
      <h1 className={`mt-1 flex items-center gap-2 text-3xl font-semibold ${tone}`}>
        {hasProblems && <ProblemIcon className="size-7" />}
        {!hasProblems && isConfident && <OkIcon className="size-7" />}
        {!hasProblems && !isConfident && <UnknownIcon className="size-7" />}
        {heading}
      </h1>
      <p className="mt-1 text-sm text-muted">
        {checkedAt === null ? 'No run yet' : `checked ${timeAgo(checkedAt, now)}`}
      </p>
      {freshness === 'stale' && (
        <p className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-sm text-warn">
          The checks have not run for a while. What you see below may be out of date.
        </p>
      )}
    </header>
  );
}
