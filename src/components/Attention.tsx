import type { ProblemView } from '../../shared/api.ts';
import { timeAgo } from '../lib/time.ts';
import { ExternalIcon, ProblemIcon } from './icons.tsx';

interface AttentionProps {
  problems: ProblemView[];
  now: number;
}

export default function Attention({ problems, now }: AttentionProps) {
  if (problems.length === 0) {
    return <p className="text-sm text-muted">Nothing needs attention.</p>;
  }
  return (
    <ul className="space-y-2">
      {problems.map((problem) => {
        const content = (
          <>
            <ProblemIcon className="shrink-0 text-bad" />
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-medium">{problem.title}</span>
              <span className="block text-xs text-muted">since {timeAgo(problem.since, now)}</span>
            </span>
            {problem.linkUrl !== null && <ExternalIcon className="shrink-0 text-muted" />}
          </>
        );
        const className =
          'flex min-h-11 items-center gap-3 rounded-xl border border-bad bg-bad-soft px-4 py-2';
        return (
          <li key={`${problem.title}:${problem.since}`}>
            {problem.linkUrl === null ? (
              <div className={className}>{content}</div>
            ) : (
              <a
                className={className}
                href={problem.linkUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {content}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
