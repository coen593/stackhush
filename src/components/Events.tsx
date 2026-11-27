import { useState } from 'react';
import type { EventView } from '../../shared/api.ts';
import { timeAgo } from '../lib/time.ts';
import { ChevronIcon } from './icons.tsx';

interface EventsProps {
  events: EventView[];
  now: number;
}

const COLLAPSED_COUNT = 8;

export default function Events({ events, now }: EventsProps) {
  const [showAll, setShowAll] = useState(false);
  if (events.length === 0) return <p className="text-sm text-muted">No changes recorded yet.</p>;

  const shown = showAll ? events : events.slice(0, COLLAPSED_COUNT);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <ul className="divide-y divide-line">
        {shown.map((event) => {
          const content = (
            <>
              <span className="block break-words text-sm">{event.title}</span>
              <span className="block text-xs text-muted">{timeAgo(event.occurredAt, now)}</span>
            </>
          );
          const className = 'block min-h-11 px-4 py-2';
          return (
            <li key={event.id}>
              {event.linkUrl === null ? (
                <div className={className}>{content}</div>
              ) : (
                <a
                  className={`${className} hover:bg-accent-soft`}
                  href={event.linkUrl}
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
      {events.length > COLLAPSED_COUNT && (
        <button
          type="button"
          className="flex min-h-11 w-full items-center justify-center gap-1 border-t border-line text-sm text-accent"
          onClick={() => setShowAll(!showAll)}
          aria-expanded={showAll}
        >
          {showAll ? 'Show fewer' : `Show all ${events.length}`}
          <ChevronIcon className={showAll ? 'rotate-180' : ''} />
        </button>
      )}
    </div>
  );
}
