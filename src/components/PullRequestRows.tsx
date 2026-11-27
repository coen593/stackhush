import type { PullRequestView } from '../../shared/api.ts';

interface PullRequestRowsProps {
  pullRequests: PullRequestView[];
}

export default function PullRequestRows({ pullRequests }: PullRequestRowsProps) {
  if (pullRequests.length === 0) return null;
  const requested = pullRequests.filter((pr) => pr.isReviewRequestedFromMe);
  const others = pullRequests.length - requested.length;
  return (
    <div>
      {requested.map((pr) => (
        <a
          key={pr.number}
          className="flex min-h-11 items-center gap-3 bg-accent-soft px-4 py-2 hover:brightness-95"
          href={pr.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          <span className="shrink-0 rounded-full border border-accent px-2 text-xs font-medium text-accent">
            Review
          </span>
          <span className="min-w-0 flex-1 text-sm">
            <span className="text-muted">#{pr.number}</span> {pr.title}
          </span>
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
