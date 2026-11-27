import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/sw.js run against a fake worker scope: handlers get synthetic events, the network and
// the Cache API are in-memory. Nothing here reaches a push service.

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://dash.test';

type Handler = (event: Record<string, unknown>) => void;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The time the worker sees; tests move it forward. */
const clock = { now: Date.UTC(2026, 0, 1) };
const FakeDate = { now: () => clock.now };

function createScope(network: (request: Request) => Promise<Response>) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  // Like the Cache API: the full URL (with its query) is the key; the tests show the path, and
  // the query when there is one.
  const key = (input: Request | string) => {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
    return url.pathname + url.search;
  };
  const caches = {
    open: (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return Promise.resolve({
        match: (input: Request | string) => Promise.resolve(store.get(key(input))?.clone()),
        put: (input: Request | string, response: Response) => {
          store.set(key(input), response);
          return Promise.resolve();
        },
        delete: (input: string) => Promise.resolve(store.delete(key(input))),
      });
    },
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name: string) => Promise.resolve(stores.delete(name)),
  };
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const badge: (number | 'clear')[] = [];
  const opened: string[] = [];
  const focused: string[] = [];
  let windows: { focus: () => Promise<void> }[] = [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: () => Promise.resolve(),
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    navigator: {
      setAppBadge: (count: number) => {
        badge.push(count);
        return Promise.resolve();
      },
      clearAppBadge: () => {
        badge.push('clear');
        return Promise.resolve();
      },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(windows),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
  };
  runInNewContext(SOURCE, {
    self,
    caches,
    fetch: (input: Request | string) =>
      network(typeof input === 'string' ? new Request(new URL(input, ORIGIN)) : input),
    URL,
    Headers,
    Response,
    Date: FakeDate,
    Number,
    String,
    Error,
  });

  /** Dispatches an event and returns what was passed to waitUntil or respondWith. */
  async function dispatch(type: string, event: Record<string, unknown>): Promise<unknown> {
    let result: unknown;
    let intercepted = false;
    handlers.get(type)?.({
      ...event,
      waitUntil: (promise: unknown) => (result = promise),
      respondWith: (promise: unknown) => {
        intercepted = true;
        result = promise;
      },
    });
    const value: unknown = await result;
    return type === 'fetch' && !intercepted ? 'passed-through' : value;
  }

  return {
    dispatch,
    stores,
    shown,
    badge,
    opened,
    focused,
    setWindows: (count: number) => {
      windows = Array.from({ length: count }, (_, index) => ({
        focus: () => {
          focused.push(String(index));
          return Promise.resolve();
        },
      }));
    },
  };
}

const pushEvent = (payload: unknown) => ({
  data: { json: () => payload },
});
const json = (status: number, body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('push event', () => {
  it('shows one notification under a fixed tag and sets the badge', async () => {
    const scope = createScope(() => Promise.reject(new Error('offline')));
    await scope.dispatch(
      'push',
      pushEvent({ title: 'Alert', body: '2 current problems', problemCount: 2, url: `${ORIGIN}/` }),
    );
    expect(scope.shown).toHaveLength(1);
    expect(scope.shown[0]?.title).toBe('Alert');
    expect(scope.shown[0]?.options).toMatchObject({
      body: '2 current problems',
      tag: 'stackhush-alert',
      renotify: true,
      data: { url: `${ORIGIN}/` },
    });
    expect(scope.badge).toEqual([2]);
  });

  it('clears the badge at 0 problems', async () => {
    const scope = createScope(() => Promise.reject(new Error('offline')));
    await scope.dispatch(
      'push',
      pushEvent({ title: 'Back to normal', body: '', problemCount: 0, url: '/' }),
    );
    expect(scope.badge).toEqual(['clear']);
  });

  it('still shows a notification for a payload it cannot read, and ignores a foreign url', async () => {
    const scope = createScope(() => Promise.reject(new Error('offline')));
    await scope.dispatch('push', {
      data: {
        json: () => {
          throw new Error('not json');
        },
      },
    });
    await scope.dispatch(
      'push',
      pushEvent({ title: 'x', body: 'y', problemCount: 1, url: 'https://evil.test/' }),
    );
    expect(scope.shown[0]?.title).toBe('stackhush');
    expect(scope.shown[1]?.options).toMatchObject({ data: { url: '/' } });
    expect(scope.badge).toEqual([1]);
  });

  it('shows the generic notification for a null or empty payload', async () => {
    const scope = createScope(() => Promise.reject(new Error('offline')));
    await scope.dispatch('push', pushEvent(null));
    await scope.dispatch('push', pushEvent(3));
    await scope.dispatch('push', { data: null });
    expect(scope.shown.map((entry) => entry.title)).toEqual([
      'stackhush',
      'stackhush',
      'stackhush',
    ]);
    expect(scope.shown[0]?.options).toMatchObject({
      body: 'Something changed.',
      data: { url: '/' },
    });
    expect(scope.badge).toEqual([]);
  });
});

describe('notificationclick', () => {
  const click = (url: string) => ({ notification: { close: () => undefined, data: { url } } });

  it('focuses an open window', async () => {
    const scope = createScope(() => Promise.reject(new Error('offline')));
    scope.setWindows(1);
    await scope.dispatch('notificationclick', click(`${ORIGIN}/`));
    expect(scope.focused).toEqual(['0']);
    expect(scope.opened).toEqual([]);
  });

  it('opens the dashboard when no window is open', async () => {
    const scope = createScope(() => Promise.reject(new Error('offline')));
    await scope.dispatch('notificationclick', click(`${ORIGIN}/`));
    expect(scope.opened).toEqual([`${ORIGIN}/`]);
  });
});

describe('caching', () => {
  const fetchEvent = (path: string, method = 'GET') => ({
    request: new Request(`${ORIGIN}${path}`, { method }),
  });

  it('serves the last good status when the network is down, marked with its time', async () => {
    let online = true;
    const scope = createScope(() =>
      online
        ? Promise.resolve(json(200, { checkedAt: 'x' }))
        : Promise.reject(new Error('offline')),
    );
    await scope.dispatch('fetch', fetchEvent('/api/status'));
    online = false;
    const response = (await scope.dispatch('fetch', fetchEvent('/api/status'))) as Response;
    expect(response.status).toBe(200);
    expect(Number(response.headers.get('X-Stackhush-Cached-At'))).toBeGreaterThan(0);
    expect(await response.json()).toEqual({ checkedAt: 'x' });
  });

  it('serves a stored status up to 7 days old, and refuses and deletes an older one', async () => {
    let online = true;
    const scope = createScope(() =>
      online
        ? Promise.resolve(json(200, { checkedAt: 'x' }))
        : Promise.reject(new Error('offline')),
    );
    await scope.dispatch('fetch', fetchEvent('/api/status'));
    online = false;
    clock.now += 7 * DAY_MS;
    const response = (await scope.dispatch('fetch', fetchEvent('/api/status'))) as Response;
    expect(response.status).toBe(200);
    clock.now += 1;
    await expect(scope.dispatch('fetch', fetchEvent('/api/status'))).rejects.toThrow('offline');
    expect(scope.stores.get('stackhush-status-v2')!.size).toBe(0);
  });

  it('refuses a stored status without a readable time or from the future', async () => {
    const scope = createScope(() => Promise.reject(new Error('offline')));
    for (const cachedAt of ['', 'soon', String(clock.now + DAY_MS)]) {
      scope.stores.set(
        'stackhush-status-v2',
        new Map([
          ['/api/status', new Response('{}', { headers: { 'X-Stackhush-Cached-At': cachedAt } })],
        ]),
      );
      await expect(scope.dispatch('fetch', fetchEvent('/api/status'))).rejects.toThrow('offline');
      expect(scope.stores.get('stackhush-status-v2')!.size).toBe(0);
    }
  });

  it('never stores an error answer, and drops the stored status and the badge on 401', async () => {
    let status = 500;
    const scope = createScope(() => Promise.resolve(json(status)));
    await scope.dispatch('fetch', fetchEvent('/api/status'));
    expect([...scope.stores.get('stackhush-status-v2')!.keys()]).toEqual([]);
    status = 200;
    await scope.dispatch('fetch', fetchEvent('/api/status'));
    expect(scope.stores.get('stackhush-status-v2')!.size).toBe(1);
    expect(scope.badge).toEqual([]);
    status = 401;
    await scope.dispatch('fetch', fetchEvent('/api/status'));
    expect(scope.stores.get('stackhush-status-v2')!.size).toBe(0);
    expect(scope.badge).toEqual(['clear']);
  });

  it('leaves every other request alone', async () => {
    const scope = createScope(() => Promise.resolve(json(200)));
    for (const path of ['/api/push/subscribe', '/api/signin', '/api/other', '/anything.json']) {
      expect(await scope.dispatch('fetch', fetchEvent(path))).toBe('passed-through');
    }
    expect(await scope.dispatch('fetch', fetchEvent('/api/status', 'POST'))).toBe('passed-through');
    expect(scope.stores.size).toBe(0);
  });

  it('keeps only hashed assets and good pages in the shell cache', async () => {
    const scope = createScope((request) =>
      Promise.resolve(
        request.url.endsWith('/assets/missing.js')
          ? new Response('nope', { status: 404 })
          : new Response('body', { headers: { 'Content-Type': 'text/javascript' } }),
      ),
    );
    await scope.dispatch('fetch', fetchEvent('/assets/app-1.js'));
    await scope.dispatch('fetch', fetchEvent('/assets/missing.js'));
    expect([...scope.stores.get('stackhush-shell-v2')!.keys()]).toEqual(['/assets/app-1.js']);
  });

  it('stores and finds an asset by its path, also when the request has a query', async () => {
    let online = true;
    const scope = createScope(() =>
      online
        ? Promise.resolve(new Response('code', { headers: { 'Content-Type': 'text/javascript' } }))
        : Promise.reject(new Error('offline')),
    );
    await scope.dispatch('fetch', fetchEvent('/assets/app-1.js?v=1'));
    expect([...scope.stores.get('stackhush-shell-v2')!.keys()]).toEqual(['/assets/app-1.js']);
    online = false;
    const response = (await scope.dispatch(
      'fetch',
      fetchEvent('/assets/app-1.js?v=1'),
    )) as Response;
    expect(await response.text()).toBe('code');
  });

  it('removes only older stackhush caches on activate', async () => {
    const scope = createScope(() => Promise.reject(new Error('offline')));
    for (const name of [
      'stackhush-shell-v0',
      'stackhush-status-v1',
      'stackhush-status-v2',
      'other-app',
    ]) {
      scope.stores.set(name, new Map());
    }
    await scope.dispatch('activate', {});
    expect([...scope.stores.keys()].sort()).toEqual(['other-app', 'stackhush-status-v2']);
  });
});

describe('install', () => {
  it('stores the page and the files it names', async () => {
    const seen: string[] = [];
    const scope = createScope((request) => {
      seen.push(new URL(request.url).pathname);
      const html =
        '<script src="/assets/index-abc.js"></script><link href="/assets/index-abc.css">';
      return Promise.resolve(
        new Response(new URL(request.url).pathname === '/' ? html : 'x', {
          headers: { 'Content-Type': 'text/html' },
        }),
      );
    });
    await scope.dispatch('install', {});
    expect(seen).toContain('/assets/index-abc.js');
    expect(seen).toContain('/assets/index-abc.css');
    expect(scope.stores.get('stackhush-shell-v2')!.has('/')).toBe(true);
  });
});

describe('static headers', () => {
  it('serves /sw.js with Cache-Control: no-cache', () => {
    const file = readFileSync(join(import.meta.dirname, '..', 'public', '_headers'), 'utf8');
    expect(file).toMatch(/\n\/sw\.js\n {2}Cache-Control: no-cache\n/);
  });
});
