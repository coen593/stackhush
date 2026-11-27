import type {
  PushSubscribeRequest,
  PushTestRequest,
  PushTestResponse,
  PushUnsubscribeRequest,
} from '../../shared/api.ts';

const REQUEST_TIMEOUT_MS = 10_000;

/** What the notifications control can be showing, before the subscription is looked at. */
export type NotificationsEnvironment =
  'ios-install' | 'unsupported' | 'not-set-up' | 'denied' | 'ready';

export interface EnvironmentFacts {
  isIos: boolean;
  /** Running as a Home Screen app. */
  isStandalone: boolean;
  /** Service workers, Push and Notification all exist. */
  isSupported: boolean;
  vapidPublicKey: string | null;
  permission: NotificationPermission | 'unavailable';
}

/**
 * On iOS the Push API only exists in a Home Screen app, so that check comes before "not
 * supported": a Safari tab there lacks it only because it is a tab.
 */
export function environmentOf(facts: EnvironmentFacts): NotificationsEnvironment {
  if (facts.isIos && !facts.isStandalone) return 'ios-install';
  if (!facts.isSupported) return 'unsupported';
  if (facts.vapidPublicKey === null) return 'not-set-up';
  if (facts.permission === 'denied') return 'denied';
  return 'ready';
}

export function readEnvironmentFacts(vapidPublicKey: string | null): EnvironmentFacts {
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
    vapidPublicKey,
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
  if (!response.ok) throw new Error(`Saving the subscription failed with HTTP ${response.status}`);
}

/** Removes the subscription from the server (204 even when it was not stored). */
export async function forgetSubscription(endpoint: string): Promise<void> {
  const body: PushUnsubscribeRequest = { endpoint };
  const response = await postJson('/api/push/unsubscribe', body);
  if (!response.ok)
    throw new Error(`Removing the subscription failed with HTTP ${response.status}`);
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

/** Before signing out: this device stops getting notifications, on the server and here. */
export async function unsubscribeThisDevice(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) await dropSubscription(subscription);
}

interface BadgeNavigator {
  setAppBadge?: (count: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/** The number on the app icon: the problem count, or nothing at 0. Where unsupported, a no-op. */
export function setBadge(count: number): void {
  const badge = navigator as BadgeNavigator;
  const done = count > 0 ? badge.setAppBadge?.(count) : badge.clearAppBadge?.();
  done?.catch(() => undefined);
}

/** Deletes every cache of the service worker (the shell and the stored status). */
export async function clearCaches(): Promise<void> {
  if (!('caches' in window)) return;
  const names = await caches.keys();
  await Promise.all(names.map((name) => caches.delete(name)));
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.error('Registering the service worker failed', error);
    });
  });
}
