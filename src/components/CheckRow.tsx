import type { CheckView } from '../../shared/api.ts';
import { timeAgo } from '../lib/time.ts';
import { ExternalIcon } from './icons.tsx';
import StatusIcon from './StatusIcon.tsx';

interface CheckRowProps {
  check: CheckView;
  now: number;
}

const ROW_CLASS = 'flex min-h-11 items-center gap-3 px-4 py-2 text-left';

export default function CheckRow({ check, now }: CheckRowProps) {
  const content = (
    <>
      <StatusIcon status={check.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{check.label}</span>
        <span
          className={`block break-words text-sm ${check.status === 'problem' ? 'text-bad' : 'text-muted'}`}
        >
          {check.summary}
        </span>
      </span>
      {check.at !== null && (
        <span className="shrink-0 text-xs text-muted">{timeAgo(check.at, now)}</span>
      )}
      {check.linkUrl !== null && <ExternalIcon className="shrink-0 text-muted" />}
    </>
  );

  if (check.linkUrl === null) return <div className={ROW_CLASS}>{content}</div>;
  return (
    <a
      className={`${ROW_CLASS} hover:bg-accent-soft`}
      href={check.linkUrl}
      target="_blank"
      rel="noreferrer noopener"
    >
      {content}
    </a>
  );
}
