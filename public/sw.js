// stackhush service worker: the app shell for offline use, the last good /api/status for the
// offline view, and push notifications. Plain JavaScript, served as is with Cache-Control:
// no-cache (public/_headers). It caches nothing else: no other API route, no error response.
//
// Bump VERSION when the rules below change; activate deletes every older stackhush cache.

const VERSION = 'v2';
const SHELL_CACHE = `stackhush-shell-${VERSION}`;
const STATUS_CACHE = `stackhush-status-${VERSION}`;
const PREFIX = 'stackhush-';

const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/apple-touch-icon.png',
];
const STATUS_PATH = '/api/status';
// Set on the copy of /api/status that is served when the network is down; the page reads it.
const CACHED_AT_HEADER = 'X-Stackhush-Cached-At';
// A stored status older than this is refused and deleted: after "sign out everywhere", a lost
// device must not keep showing the dashboard offline for good.
const STATUS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NOTIFICATION_TAG = 'stackhush-alert';

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
  void self.skipWaiting();
});

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  const page = await fetch('/', { cache: 'reload' });
  if (!page.ok) throw new Error(`The page answered HTTP ${page.status}`);
  // The page's own scripts and styles are hashed files under /assets/ that were loaded before
  // this worker existed, so they are fetched here too.
  const html = await page.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  await cache.put('/', page);
  await Promise.all(
    [...SHELL_URLS.slice(1), ...assets].map(async (url) => {
      const response = await fetch(url, { cache: 'reload' });
      if (response.ok) await cache.put(url, response);
    }),
  );
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL_CACHE, STATUS_CACHE];
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(PREFIX) && !keep.includes(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === STATUS_PATH) {
    event.respondWith(statusResponse(request));
  } else if (request.mode === 'navigate') {
    event.respondWith(pageResponse(request));
  } else if (url.pathname.startsWith('/assets/') || SHELL_URLS.includes(url.pathname)) {
    event.respondWith(shellResponse(request, url.pathname.startsWith('/assets/')));
  }
});

/**
 * Network first; the last good status when the network fails, if it is at most 7 days old.
 * Never stores an error.
 */
async function statusResponse(request) {
  const cache = await caches.open(STATUS_CACHE);
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const cached = await cache.match(STATUS_PATH);
    if (!cached) throw error;
    const cachedAt = Number(cached.headers.get(CACHED_AT_HEADER));
    const age = Date.now() - cachedAt;
    if (Number.isFinite(cachedAt) && cachedAt > 0 && age >= 0 && age <= STATUS_MAX_AGE_MS) {
      return cached;
    }
    await cache.delete(STATUS_PATH);
    throw error;
  }
  if (response.ok) {
    const headers = new Headers({
      'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
      [CACHED_AT_HEADER]: String(Date.now()),
    });
    await cache.put(STATUS_PATH, new Response(await response.clone().arrayBuffer(), { headers }));
  } else if (response.status === 401) {
    // Signed out: neither the stored status nor the problem count may outlive the session.
    await cache.delete(STATUS_PATH);
    await setBadge(0);
  }
  return response;
}

/** Network first; the stored page when the network fails. Only a good HTML page is stored. */
async function pageResponse(request) {
  try {
    const response = await fetch(request);
    const isPage =
      response.ok && (response.headers.get('Content-Type') ?? '').includes('text/html');
    if (isPage) await (await caches.open(SHELL_CACHE)).put('/', response.clone());
    return response;
  } catch (error) {
    const cached = await (await caches.open(SHELL_CACHE)).match('/');
    if (cached) return cached;
    throw error;
  }
}

/** Stored copy first. Only the hashed files under /assets/ are added when missing. */
async function shellResponse(request, mayStore) {
  const cache = await caches.open(SHELL_CACHE);
  // Stored and looked up by path, as install stores them.
  const path = new URL(request.url).pathname;
  const cached = await cache.match(path);
  if (cached) return cached;
  const response = await fetch(request);
  if (mayStore && response.ok) await cache.put(path, response.clone());
  return response;
}

self.addEventListener('push', (event) => {
  event.waitUntil(showAlert(event.data));
});

async function showAlert(data) {
  let payload = {};
  try {
    // A push without data, `null`, or anything that is not an object: the generic notification.
    const parsed = data ? data.json() : null;
    if (parsed !== null && typeof parsed === 'object') payload = parsed;
  } catch {
    // Not JSON: show the generic notification below.
  }
  const title =
    typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'stackhush';
  const body = typeof payload.body === 'string' ? payload.body : 'Something changed.';
  const count =
    Number.isInteger(payload.problemCount) && payload.problemCount >= 0
      ? payload.problemCount
      : null;
  // Only an address on this origin is opened; anything else falls back to the dashboard.
  let target = '/';
  try {
    if (typeof payload.url === 'string') {
      const url = new URL(payload.url, self.location.origin);
      if (url.origin === self.location.origin) target = url.href;
    }
  } catch {
    // Keep the dashboard.
  }
  // A new alert replaces the earlier one (same tag) and still makes a sound (renotify).
  await self.registration.showNotification(title, {
    body,
    tag: NOTIFICATION_TAG,
    renotify: true,
    icon: '/icon-192.png',
    data: { url: target },
  });
  if (count !== null) await setBadge(count);
}

async function setBadge(count) {
  try {
    if (count > 0 && 'setAppBadge' in self.navigator) await self.navigator.setAppBadge(count);
    else if ('clearAppBadge' in self.navigator) await self.navigator.clearAppBadge();
  } catch {
    // A badge is a nicety; the notification is already shown.
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows[0];
      if (open) {
        await open.focus();
      } else {
        await self.clients.openWindow(target);
      }
    })(),
  );
});
