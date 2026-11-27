import type {
  PushStatus,
  PushSubscribeRequest,
  PushTestRequest,
  PushTestResponse,
  PushUnsubscribeRequest,
} from '../../shared/api.ts';
import { errorText, isNetworkError } from './api.ts';

const REQUEST_TIMEOUT_MS = 10_000;
/** How long the page waits for a service worker that is still installing. */
const WORKER_WAIT_MS = 10_000;

/** What the notifications control can be showing, before the subscription is looked at. */
export type NotificationsEnvironment =
  'ios-install' | 'unsupported' | 'not-set-up' | 'invalid-keys' | 'denied' | 'ready';

export interface EnvironmentFacts {
  isIos: boolean;
  /** Running as a Home Screen app. */
  isStandalone: boolean;
  /** Service workers, Push and Notification all exist. */
  isSupported: boolean;
  vapidPublicKey: string | null;
  keys: PushStatus['keys'];
  permission: NotificationPermission | 'unavailable';
}

/**
 * On iOS the Push API only exists in a Home Screen app, so that check comes before "not
 * supported": a Safari tab there lacks it only because it is a tab.
 */
export function environmentOf(facts: EnvironmentFacts): NotificationsEnvironment {
  if (facts.isIos && !facts.isStandalone) return 'ios-install';
  if (!facts.isSupported) return 'unsupported';
  if (facts.keys === 'invalid') return 'invalid-keys';
  if (facts.vapidPublicKey === null) return 'not-set-up';
  if (facts.permission === 'denied') return 'denied';
  return 'ready';
}

export function readEnvironmentFacts(
  push: Pick<PushStatus, 'vapidPublicKey' | 'keys'>,
): EnvironmentFacts {
  const isIos =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return {
    isIos,
    isStandalone:
      standaloneNavigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches,
    isSupported:
      'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    vapidPublicKey: push.vapidPublicKey,
    keys: push.keys,
    permission: 'Notification' in window ? Notification.permission : 'unavailable',
  };
}

/** Unpadded base64url to bytes. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/** Whether the subscription was made with this key; a rotated key makes it useless. */
export function subscriptionUsesKey(
  subscription: PushSubscription,
  vapidPublicKey: string,
): boolean {
  const current = subscription.options.applicationServerKey;
  if (current === null) return false;
  const wanted = base64UrlToBytes(vapidPublicKey);
  const have = new Uint8Array(current);
  return have.length === wanted.length && have.every((byte, index) => byte === wanted[index]);
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Says in plain words why the server did not take a push request. */
function refusal(action: string, status: number): Error {
  if (status === 401) return new Error(`${action} failed: you are signed out. Reload the page.`);
  if (status === 409) {
    return new Error(
      `${action} failed: push is not set up on the server, or its keys are not valid. The alert emails are not affected.`,
    );
  }
  return new Error(`${action} failed: the server answered HTTP ${status}. Try again later.`);
}

/** Stores the subscription on the server; an upsert, so it is safe to repeat. */
export async function storeSubscription(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error('The browser gave an incomplete subscription.');
  }
  const body: PushSubscribeRequest = {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
  const response = await postJson('/api/push/subscribe', body);
  if (!response.ok) throw refusal('Turning on notifications', response.status);
}

/**
 * Removes the subscription from the server (204 even when it was not stored). 401 and 403 mean
 * the session is already gone, and with it the subscription (it belongs to the session), so
 * they count as done. Anything else that is not success, and no answer at all, throws.
 */
export async function forgetSubscription(endpoint: string): Promise<void> {
  const body: PushUnsubscribeRequest = { endpoint };
  const response = await postJson('/api/push/unsubscribe', body);
  if (response.ok || response.status === 401 || response.status === 403) return;
  throw refusal('Turning off notifications', response.status);
}

/** Drops a subscription from the server and then the browser. */
export async function dropSubscription(subscription: PushSubscription): Promise<void> {
  await forgetSubscription(subscription.endpoint);
  await subscription.unsubscribe();
}

/** Subscribes this browser. The permission must already be granted. */
export function subscribeBrowser(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
): Promise<PushSubscription> {
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(vapidPublicKey),
  });
}

export type TestOutcome =
  | 'sent'
  /** The push service no longer knows this device. */
  | 'gone'
  /** The push service did not accept the message. */
  | 'failed'
  | 'try-later'
  | 'not-set-up'
  | 'unreachable';

/** Asks the server to send a test notification to one device. */
export async function sendTest(endpoint: string): Promise<TestOutcome> {
  const body: PushTestRequest = { endpoint };
  let response: Response;
  try {
    response = await postJson('/api/push/test', body);
  } catch (error: unknown) {
    console.error('Sending a test notification failed', error);
    return 'unreachable';
  }
  if (response.status === 410) return 'gone';
  if (response.status === 429) return 'try-later';
  if (response.status === 409) return 'not-set-up';
  if (!response.ok) return 'unreachable';
  const { results } = (await response.json()) as PushTestResponse;
  const outcome = results[0]?.outcome;
  if (outcome === 'sent') return 'sent';
  if (outcome === 'gone') return 'gone';
  return 'failed';
}

/**
 * The service worker's registration. A worker that is still installing (the first visit) is
 * waited for, up to 10 s; null when there is none.
 */
export async function workerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration) return registration;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), WORKER_WAIT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SubscriptionCheck {
  mode: 'on' | 'off' | 'unsupported';
  /** Plain words for the page; empty when there is nothing to say. */
  message: string;
}

/**
 * Run on every load of the control. An existing subscription is posted again (an upsert), so a
 * device that signed in again is tied to its new session, and one made with a rotated key is
 * replaced. Offline the server is not asked: the control shows what this browser has.
 */
export async function checkSubscription(vapidPublicKey: string): Promise<SubscriptionCheck> {
  const registration = await workerRegistration();
  if (!registration) return { mode: 'unsupported', message: '' };
  let subscription = await registration.pushManager.getSubscription();
  try {
    if (subscription && !subscriptionUsesKey(subscription, vapidPublicKey)) {
      await dropSubscription(subscription);
      subscription = null;
      if (Notification.permission === 'granted') {
        subscription = await subscribeBrowser(registration, vapidPublicKey);
      }
    }
    if (subscription) await storeSubscription(subscription);
    return { mode: subscription ? 'on' : 'off', message: '' };
  } catch (error: unknown) {
    const mode = subscription ? 'on' : 'off';
    if (isNetworkError(error)) return { mode, message: '' };
    console.error('Checking notifications failed', error);
    return { mode, message: errorText(error) };
  }
}

/**
 * Before signing out: this device stops getting notifications, on the server and here. Looking
 * the subscription up and dropping it from the browser are best effort; only a server that is
 * unreachable or fails on a live session throws, because then the device would keep getting
 * notifications after signing out.
 */
export async function unsubscribeThisDevice(): Promise<void> {
  let subscription: PushSubscription | null = null;
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      subscription = (await registration?.pushManager.getSubscription()) ?? null;
    }
  } catch (error: unknown) {
    console.error('Looking up the push subscription failed', error);
  }
  if (!subscription) return;
  await forgetSubscription(subscription.endpoint);
  try {
    await subscription.unsubscribe();
  } catch (error: unknown) {
    console.error('Removing the push subscription from the browser failed', error);
  }
}

interface BadgeNavigator {
  setAppBadge?: (count: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/** The number on the app icon: the problem count, or nothing at 0. Where unsupported, a no-op. */
export function setBadge(count: number): void {
  const badge = navigator as BadgeNavigator;
  try {
    const done = count > 0 ? badge.setAppBadge?.(count) : badge.clearAppBadge?.();
    done?.catch(() => undefined);
  } catch {
    // A badge is a nicety.
  }
}

/** Deletes every cache of the service worker (the shell and the stored status). Best effort. */
export async function clearCaches(): Promise<void> {
  try {
    if (!('caches' in globalThis)) return;
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
  } catch (error: unknown) {
    console.error('Clearing the caches failed', error);
  }
}

/**
 * Registers public/sw.js once the page has loaded. A page that is already loaded (main.tsx
 * awaits the sign-in of a link before it gets here, so `load` may have fired) registers now.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.error('Registering the service worker failed', error);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
