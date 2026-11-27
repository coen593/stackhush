import type { CheckStatus } from '../../shared/api.ts';
import { OkIcon, ProblemIcon, UnknownIcon } from './icons.tsx';

interface StatusIconProps {
  status: CheckStatus;
}

const STYLES: Record<CheckStatus, { label: string; className: string }> = {
  ok: { label: 'OK', className: 'text-ok' },
  problem: { label: 'Problem', className: 'text-bad' },
  unknown: { label: 'Unknown', className: 'text-muted' },
};

export default function StatusIcon({ status }: StatusIconProps) {
  const { label, className } = STYLES[status];
  return (
    <span className={`inline-flex shrink-0 ${className}`} role="img" aria-label={label}>
      {status === 'ok' && <OkIcon />}
      {status === 'problem' && <ProblemIcon />}
      {status === 'unknown' && <UnknownIcon />}
    </span>
  );
}
