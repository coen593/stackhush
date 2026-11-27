import { useCallback, useEffect, useState } from 'react';
import type { PushStatus } from '../../shared/api.ts';
import { errorText } from '../lib/api.ts';
import {
  checkSubscription,
  dropSubscription,
  environmentOf,
  readEnvironmentFacts,
  sendTest,
  storeSubscription,
  subscribeBrowser,
  workerRegistration,
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
  'not-set-up':
    'Push is not set up on the server, or its keys are not valid. The alert emails are not affected.',
  unreachable: 'Could not reach the server.',
};

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await workerRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * State and actions of the notifications control. On every load it posts an existing
 * subscription again (checkSubscription), so a device that signed in again is tied to its new
 * session. `onChanged` runs after the device was turned on or off (to reload the device count).
 */
export function useNotifications(push: PushStatus, onChanged: () => void) {
  const [mode, setMode] = useState<NotificationsMode>('checking');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const { vapidPublicKey, keys } = push;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const environment = environmentOf(readEnvironmentFacts({ vapidPublicKey, keys }));
      if (environment !== 'ready' || vapidPublicKey === null) {
        if (!cancelled) setMode(environment === 'ready' ? 'not-set-up' : environment);
        return;
      }
      try {
        const result = await checkSubscription(vapidPublicKey);
        if (cancelled) return;
        setMode(result.mode);
        setMessage(result.message);
      } catch (error: unknown) {
        console.error('Checking notifications failed', error);
        if (cancelled) return;
        setMode('unsupported');
        setMessage(errorText(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vapidPublicKey, keys]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error: unknown) {
      console.error('Notifications action failed', error);
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const subscribe = useCallback(async (key: string) => {
    const registration = await workerRegistration();
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
      onChanged();
    });

  const turnOff = () =>
    run(async () => {
      const subscription = await currentSubscription();
      if (subscription) await dropSubscription(subscription);
      setMode('off');
      onChanged();
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
