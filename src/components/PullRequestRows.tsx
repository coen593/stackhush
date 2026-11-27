import type { PullRequestChecks, PullRequestView } from '../../shared/api.ts';
import { OkIcon, ProblemIcon, UnknownIcon } from './icons.tsx';

interface PullRequestRowsProps {
  pullRequests: PullRequestView[];
}

// Icon and word together, so color is never the only signal.
const CHECKS: Record<PullRequestChecks, { label: string; className: string }> = {
  passing: { label: 'Passing', className: 'text-ok' },
  failing: { label: 'Failing', className: 'text-bad' },
  running: { label: 'Running', className: 'text-muted' },
};

interface ChecksBadgeProps {
  checks: PullRequestChecks;
}

function ChecksBadge({ checks }: ChecksBadgeProps) {
  const { label, className } = CHECKS[checks];
  return (
    <span className={`flex shrink-0 items-center gap-1 text-xs ${className}`}>
      {checks === 'passing' && <OkIcon />}
      {checks === 'failing' && <ProblemIcon />}
      {checks === 'running' && <UnknownIcon />}
      <span>
        <span className="sr-only">Checks: </span>
        {label}
      </span>
    </span>
  );
}

/**
 * A row for every PR there is something to say about: my review is requested, or its checks
 * are known. The rest are only counted.
 */
export default function PullRequestRows({ pullRequests }: PullRequestRowsProps) {
  if (pullRequests.length === 0) return null;
  const listed = pullRequests.filter((pr) => pr.isReviewRequestedFromMe || pr.checks !== undefined);
  const others = pullRequests.length - listed.length;
  return (
    <div>
      {listed.map((pr) => (
        <a
          key={pr.number}
          className={`flex min-h-11 items-center gap-3 px-4 py-2 ${pr.isReviewRequestedFromMe ? 'bg-accent-soft hover:brightness-95' : 'hover:bg-accent-soft'}`}
          href={pr.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          {pr.isReviewRequestedFromMe && (
            <span className="shrink-0 rounded-full border border-accent px-2 text-xs font-medium text-accent">
              Review
            </span>
          )}
          <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
            <span className="text-muted">#{pr.number}</span> {pr.title}
          </span>
          {pr.checks !== undefined && <ChecksBadge checks={pr.checks} />}
        </a>
      ))}
      {others > 0 && (
        <p className="flex min-h-11 items-center px-4 py-2 text-sm text-muted">
          {others} other open {others === 1 ? 'PR' : 'PRs'}
        </p>
      )}
    </div>
  );
}
