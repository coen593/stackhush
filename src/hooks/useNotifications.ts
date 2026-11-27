import { useCallback, useEffect, useState } from 'react';
import {
  dropSubscription,
  environmentOf,
  readEnvironmentFacts,
  sendTest,
  storeSubscription,
  subscribeBrowser,
  subscriptionUsesKey,
  type NotificationsEnvironment,
  type TestOutcome,
} from '../lib/push.ts';

export type NotificationsMode = 'checking' | NotificationsEnvironment | 'off' | 'on';

const TEST_MESSAGES: Record<TestOutcome, string> = {
  sent: 'Test sent. It should arrive in a moment.',
  gone: 'The push service had dropped this device, so it was subscribed again. Send the test once more.',
  failed:
    'The push service did not accept the test. Try again later; the email alerts are not affected.',
  'try-later': 'Too many tests were sent. Try again later.',
  'not-set-up': 'Push is not set up on the server.',
  unreachable: 'Could not reach the server.',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * State and actions of the notifications control. On load it repeats the subscribe call of an
 * existing subscription (an upsert), and replaces one made with a key that has been rotated.
 */
export function useNotifications(vapidPublicKey: string | null) {
  const [mode, setMode] = useState<NotificationsMode>('checking');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    const set = (next: NotificationsMode) => {
      if (!cancelled) setMode(next);
    };
    void (async () => {
      const environment = environmentOf(readEnvironmentFacts(vapidPublicKey));
      if (environment !== 'ready' || vapidPublicKey === null) {
        set(environment === 'ready' ? 'not-set-up' : environment);
        return;
      }
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) {
          set('unsupported');
          return;
        }
        let subscription = await registration.pushManager.getSubscription();
        if (subscription && !subscriptionUsesKey(subscription, vapidPublicKey)) {
          await dropSubscription(subscription);
          subscription =
            Notification.permission === 'granted'
              ? await subscribeBrowser(registration, vapidPublicKey)
              : null;
        }
        if (subscription) await storeSubscription(subscription);
        set(subscription ? 'on' : 'off');
      } catch (error: unknown) {
        console.error('Checking notifications failed', error);
        if (!cancelled) setMessage(errorMessage(error));
        set('off');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vapidPublicKey]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error: unknown) {
      console.error('Notifications action failed', error);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const subscribe = useCallback(async (key: string) => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('The service worker is not running. Reload the page.');
    const subscription = await subscribeBrowser(registration, key);
    try {
      await storeSubscription(subscription);
    } catch (error: unknown) {
      await subscription.unsubscribe();
      throw error;
    }
  }, []);

  const turnOn = () =>
    run(async () => {
      if (vapidPublicKey === null) return;
      // Asked here, on the tap, and nowhere else.
      const permission = await Notification.requestPermission();
      if (permission === 'denied') {
        setMode('denied');
        return;
      }
      if (permission !== 'granted') {
        setMessage('Permission was not given, so notifications stay off.');
        return;
      }
      await subscribe(vapidPublicKey);
      setMode('on');
    });

  const turnOff = () =>
    run(async () => {
      const subscription = await currentSubscription();
      if (subscription) await dropSubscription(subscription);
      setMode('off');
    });

  const test = () =>
    run(async () => {
      const subscription = await currentSubscription();
      if (!subscription) {
        setMode('off');
        return;
      }
      const outcome = await sendTest(subscription.endpoint);
      if (outcome === 'gone' && vapidPublicKey !== null) {
        await subscription.unsubscribe();
        await subscribe(vapidPublicKey);
      }
      setMessage(TEST_MESSAGES[outcome]);
    });

  return { mode, busy, message, turnOn, turnOff, test };
}
