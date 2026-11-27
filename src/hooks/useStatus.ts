import { useCallback, useEffect, useState } from 'react';
import type { StatusResponse } from '../../shared/api.ts';
import { fetchStatus } from '../lib/api.ts';

const REFRESH_INTERVAL_MS = 60_000;

export type StatusState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: StatusResponse; refreshFailed: boolean };

/** Loads /api/status and reloads it every 60 s while the tab is visible. */
export function useStatus(): {
  state: StatusState;
  reload: () => Promise<void>;
  markSignedOut: () => void;
} {
  const [state, setState] = useState<StatusState>({ kind: 'loading' });

  const load = useCallback(async () => {
    try {
      const result = await fetchStatus();
      if (result.kind === 'signed-out') {
        setState({ kind: 'signed-out' });
        return;
      }
      setState({ kind: 'ready', status: result.status, refreshFailed: false });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Something went wrong';
      // Keep showing the last good data; the header says that it could not be refreshed.
      setState((current) =>
        current.kind === 'ready' ? { ...current, refreshFailed: true } : { kind: 'error', message },
      );
    }
  }, []);

  useEffect(() => {
    // Through a timer so the first load is not a synchronous state update inside the effect.
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  return { state, reload: load, markSignedOut: () => setState({ kind: 'signed-out' }) };
}
