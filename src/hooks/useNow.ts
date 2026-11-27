import { useEffect, useState } from 'react';

const TICK_MS = 60_000;

/**
 * The current time, updated every minute and when the tab becomes visible again (timers are
 * paused in a background tab). Ages on the page are measured against this, not against the
 * moment of the last successful load, so they keep growing when refreshing fails.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = setInterval(update, TICK_MS);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return now;
}
