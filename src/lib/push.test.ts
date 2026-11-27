import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorText } from './api.ts';
import {
  base64UrlToBytes,
  checkSubscription,
  clearCaches,
  environmentOf,
  unsubscribeThisDevice,
  type EnvironmentFacts,
} from './push.ts';

const READY: EnvironmentFacts = {
  isIos: false,
  isStandalone: false,
  isSupported: true,
  vapidPublicKey: 'key',
  keys: 'ready',
  permission: 'default',
};

describe('environmentOf', () => {
  it('is ready when everything is there', () => {
    expect(environmentOf(READY)).toBe('ready');
  });

  it('asks for the Home Screen app on iOS before anything else', () => {
    expect(environmentOf({ ...READY, isIos: true, isSupported: false })).toBe('ios-install');
    expect(environmentOf({ ...READY, isIos: true, isStandalone: true })).toBe('ready');
  });

  it('reports unsupported, not set up and denied in that order', () => {
    expect(environmentOf({ ...READY, isSupported: false, vapidPublicKey: null })).toBe(
      'unsupported',
    );
    expect(environmentOf({ ...READY, vapidPublicKey: null, permission: 'denied' })).toBe(
      'not-set-up',
    );
    expect(environmentOf({ ...READY, permission: 'denied' })).toBe('denied');
  });

  it('says when the keys on the server are not valid', () => {
    expect(environmentOf({ ...READY, vapidPublicKey: null, keys: 'invalid' })).toBe('invalid-keys');
    expect(environmentOf({ ...READY, vapidPublicKey: null, keys: 'absent' })).toBe('not-set-up');
  });
});

describe('base64UrlToBytes', () => {
  it('decodes unpadded base64url', () => {
    expect([...base64UrlToBytes('-_8')]).toEqual([251, 255]);
    expect([...base64UrlToBytes('AQID')]).toEqual([1, 2, 3]);
  });
});

// The browser side, stubbed: a fake subscription with an endpoint that is never contacted, and a
// fake fetch that records what the page posts. Nothing here reaches a push service.

const KEY = 'AQID';
const ENDPOINT = 'https://push.invalid/device-1';

interface Posted {
  path: string;
  body: unknown;
}

function fakeSubscription(key = KEY) {
  const subscription = {
    endpoint: ENDPOINT,
    options: { applicationServerKey: base64UrlToBytes(key).buffer },
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p256dh', auth: 'auth' } }),
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  };
  return subscription;
}

function stubBrowser(options: {
  subscription: ReturnType<typeof fakeSubscription> | null;
  answer: (path: string) => Promise<Response>;
  getRegistration?: () => Promise<unknown>;
}) {
  const posted: Posted[] = [];
  const registration = {
    pushManager: {
      getSubscription: () => Promise.resolve(options.subscription),
      subscribe: vi.fn(() => Promise.resolve(fakeSubscription())),
    },
  };
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistration: options.getRegistration ?? (() => Promise.resolve(registration)),
      ready: new Promise(() => undefined),
    },
  });
  vi.stubGlobal('Notification', { permission: 'granted' });
  vi.stubGlobal('fetch', (path: string, init: RequestInit) => {
    posted.push({ path, body: JSON.parse(init.body as string) as unknown });
    return options.answer(path);
  });
  return { posted, registration };
}

const answer = (status: number) => () => Promise.resolve(new Response(null, { status }));
const offline = () => Promise.reject(new TypeError('Failed to fetch'));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('unsubscribeThisDevice (before signing out)', () => {
  it('drops the browser subscription after the server removed it', async () => {
    const subscription = fakeSubscription();
    const { posted } = stubBrowser({ subscription, answer: answer(204) });
    await unsubscribeThisDevice();
    expect(posted).toEqual([{ path: '/api/push/unsubscribe', body: { endpoint: ENDPOINT } }]);
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  });

  it('carries on when the session is already gone (401 or 403)', async () => {
    for (const status of [401, 403]) {
      const subscription = fakeSubscription();
      stubBrowser({ subscription, answer: answer(status) });
      await expect(unsubscribeThisDevice()).resolves.toBeUndefined();
      expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    }
  });

  it('stops on a server failure of a live session, keeping the subscription', async () => {
    const subscription = fakeSubscription();
    stubBrowser({ subscription, answer: answer(500) });
    await expect(unsubscribeThisDevice()).rejects.toThrow('HTTP 500');
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it('stops without a network, in plain words', async () => {
    const subscription = fakeSubscription();
    stubBrowser({ subscription, answer: offline });
    const error: unknown = await unsubscribeThisDevice().catch((caught: unknown) => caught);
    expect(errorText(error)).toBe(
      'Could not reach the server. Check the connection and try again.',
    );
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it('treats local lookups and browser cleanup as best effort', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { posted } = stubBrowser({
      subscription: null,
      answer: answer(204),
      getRegistration: () => Promise.reject(new Error('broken')),
    });
    await expect(unsubscribeThisDevice()).resolves.toBeUndefined();
    expect(posted).toEqual([]);

    const subscription = fakeSubscription();
    subscription.unsubscribe.mockRejectedValue(new Error('browser said no'));
    stubBrowser({ subscription, answer: answer(204) });
    await expect(unsubscribeThisDevice()).resolves.toBeUndefined();
  });
});

describe('clearCaches', () => {
  it('deletes every cache, and never throws', async () => {
    const deleted: string[] = [];
    vi.stubGlobal('caches', {
      keys: () => Promise.resolve(['stackhush-shell-v2', 'stackhush-status-v2']),
      delete: (name: string) => {
        deleted.push(name);
        return Promise.resolve(true);
      },
    });
    await clearCaches();
    expect(deleted).toEqual(['stackhush-shell-v2', 'stackhush-status-v2']);

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('caches', { keys: () => Promise.reject(new Error('SecurityError')) });
    await expect(clearCaches()).resolves.toBeUndefined();
  });
});

describe('checkSubscription (every load of the control)', () => {
  it('posts an existing subscription again, so a new session takes the device over', async () => {
    const { posted } = stubBrowser({ subscription: fakeSubscription(), answer: answer(204) });
    expect(await checkSubscription(KEY)).toEqual({ mode: 'on', message: '' });
    expect(await checkSubscription(KEY)).toEqual({ mode: 'on', message: '' });
    expect(posted).toEqual([
      {
        path: '/api/push/subscribe',
        body: { endpoint: ENDPOINT, keys: { p256dh: 'p256dh', auth: 'auth' } },
      },
      {
        path: '/api/push/subscribe',
        body: { endpoint: ENDPOINT, keys: { p256dh: 'p256dh', auth: 'auth' } },
      },
    ]);
  });

  it('posts nothing without a subscription', async () => {
    const { posted } = stubBrowser({ subscription: null, answer: answer(204) });
    expect(await checkSubscription(KEY)).toEqual({ mode: 'off', message: '' });
    expect(posted).toEqual([]);
  });

  it('replaces a subscription made with an older key', async () => {
    const old = fakeSubscription('BAUG');
    const { posted, registration } = stubBrowser({ subscription: old, answer: answer(204) });
    expect(await checkSubscription(KEY)).toEqual({ mode: 'on', message: '' });
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(registration.pushManager.subscribe).toHaveBeenCalledOnce();
    expect(posted.map((entry) => entry.path)).toEqual([
      '/api/push/unsubscribe',
      '/api/push/subscribe',
    ]);
  });

  it('offline, keeps showing what this browser has, without an error', async () => {
    stubBrowser({ subscription: fakeSubscription(), answer: offline });
    expect(await checkSubscription(KEY)).toEqual({ mode: 'on', message: '' });
  });

  it('says in plain words when the server has no valid keys', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubBrowser({ subscription: fakeSubscription(), answer: answer(409) });
    const result = await checkSubscription(KEY);
    expect(result.mode).toBe('on');
    expect(result.message).toContain('its keys are not valid');
  });
});
