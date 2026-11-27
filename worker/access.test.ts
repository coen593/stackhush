import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusResponse } from '../shared/api.ts';
import { protectedRoutes, sessionFreeRoutes, SIGNIN_PATH } from './api.ts';
import { createTestEnv, testWorker as worker } from './testing/env.ts';
import { createTestDatabase } from './testing/fakeD1.ts';
import { generateToken, hashToken } from './tokens.ts';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let sqlite: DatabaseSync;
let env: Env;

beforeEach(() => {
  const database = createTestDatabase();
  sqlite = database.sqlite;
  env = createTestEnv(database.db);
});

async function insertCode(expiresInMs: number): Promise<string> {
  const code = generateToken();
  sqlite
    .prepare('INSERT INTO signin_codes (code_hash, expires_at) VALUES (?, ?)')
    .run(await hashToken(code), new Date(Date.now() + expiresInMs).toISOString());
  return code;
}

async function insertSession(expiresInMs: number): Promise<string> {
  const sessionId = generateToken();
  sqlite
    .prepare('INSERT INTO sessions (id_hash, expires_at) VALUES (?, ?)')
    .run(await hashToken(sessionId), new Date(Date.now() + expiresInMs).toISOString());
  return sessionId;
}

/** A request as the dashboard's own page sends it: every POST is JSON, like src/lib/api.ts. */
function call(method: string, path: string, sessionId?: string, body?: string): Promise<Response> {
  const headers = new Headers();
  if (sessionId !== undefined) headers.set('Cookie', `__Host-session=${sessionId}`);
  if (method === 'POST') headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request(`https://stackhush.test${path}`, { method, headers, body }), env);
}

/** A POST with exactly these headers, for requests the page itself would never send. */
function post(path: string, headers: Record<string, string>, body?: BodyInit): Promise<Response> {
  return worker.fetch(
    new Request(`https://stackhush.test${path}`, { method: 'POST', headers, body }),
    env,
  );
}

function postSignin(body: string): Promise<Response> {
  return call('POST', SIGNIN_PATH, undefined, body);
}

/** Signs in with the code and returns the session id from the cookie. */
async function signInWith(code: string): Promise<string> {
  const response = await postSignin(JSON.stringify({ code }));
  expect(response.status).toBe(204);
  const cookie = response.headers.get('Set-Cookie') ?? '';
  const sessionId = /^__Host-session=([0-9a-f]{64});/.exec(cookie)?.[1];
  if (sessionId === undefined) throw new Error(`No session in cookie: ${cookie}`);
  return sessionId;
}

async function expectRefused(response: Response, status = 401): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.text()).toBe('');
  expect(response.headers.get('Set-Cookie')).toBeNull();
}

describe('the session guard', () => {
  it('has routes to check', () => {
    expect(protectedRoutes.length).toBeGreaterThan(0);
  });

  for (const route of protectedRoutes) {
    it(`refuses ${route.method} ${route.path} without a cookie`, async () => {
      await expectRefused(await call(route.method, route.path));
    });

    it(`refuses ${route.method} ${route.path} with an unknown session`, async () => {
      await expectRefused(await call(route.method, route.path, generateToken()));
    });

    it(`refuses ${route.method} ${route.path} with an expired session`, async () => {
      const sessionId = await insertSession(-MINUTE_MS);
      await expectRefused(await call(route.method, route.path, sessionId));
    });

    it(`refuses ${route.method} ${route.path} with a malformed cookie`, async () => {
      await expectRefused(await call(route.method, route.path, 'not-a-session'));
    });

    it(`refuses ${route.method} ${route.path} with a sign-in code as the cookie`, async () => {
      const code = await insertCode(15 * MINUTE_MS);
      await expectRefused(await call(route.method, route.path, code));
    });
  }

  it('refuses unknown API paths without a session, before saying they do not exist', async () => {
    for (const path of ['/api/nope', '/api/scheduled', '/api/', '/api']) {
      await expectRefused(await call('GET', path));
    }
  });

  it('refuses the sign-in path with any method other than POST without a session', async () => {
    await expectRefused(await call('GET', SIGNIN_PATH));
  });

  it('lets a valid session through', async () => {
    const sessionId = await insertSession(DAY_MS);
    const response = await call('GET', '/api/status', sessionId);
    expect(response.status).toBe(200);
  });
});

describe('the push routes', () => {
  const PUSH_PATHS = ['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test'];
  // A body each of them would act on with a session: a well-formed subscription.
  const SUBSCRIPTION = JSON.stringify({
    endpoint: 'https://push.example.test/send/phone',
    keys: {
      // The subscriber's public key and auth secret of the example in RFC 8291.
      p256dh:
        'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    },
  });

  function seedSubscription(): void {
    sqlite
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, session_hash, last_active_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('https://push.example.test/send/phone', 'p256dh', 'auth', 'a-session', 'earlier');
  }

  function pushRows(): unknown {
    return {
      subscriptions: sqlite.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get(),
      tests: sqlite.prepare('SELECT COUNT(*) AS count FROM push_test_sends').get(),
    };
  }

  it('are all behind the session check, and only as POST', () => {
    const push = protectedRoutes.filter((route) => route.path.startsWith('/api/push'));
    expect(push.map((route) => `${route.method} ${route.path}`)).toEqual(
      PUSH_PATHS.map((path) => `POST ${path}`),
    );
    expect(sessionFreeRoutes.filter((route) => route.path.includes('push'))).toEqual([]);
  });

  for (const path of PUSH_PATHS) {
    it(`does nothing for POST ${path} with a real body and no session`, async () => {
      seedSubscription();
      await expectRefused(await call('POST', path, undefined, SUBSCRIPTION));
      await expectRefused(await call('POST', path, generateToken(), SUBSCRIPTION));
      await expectRefused(await call('POST', path, await insertSession(-MINUTE_MS), SUBSCRIPTION));
      // Nothing stored, nothing deleted, no test counted. The test Worker has no network, so a
      // send would also have thrown.
      expect(pushRows()).toEqual({ subscriptions: { count: 1 }, tests: { count: 0 } });
    });

    it(`refuses POST ${path} from another site or as a form, even with a session`, async () => {
      seedSubscription();
      const sessionId = await insertSession(DAY_MS);
      const cookie = { Cookie: `__Host-session=${sessionId}` };
      const json = { ...cookie, 'Content-Type': 'application/json' };
      const attempts: Record<string, string>[] = [
        cookie,
        { ...cookie, 'Content-Type': 'text/plain' },
        { ...cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        { ...json, 'Sec-Fetch-Site': 'cross-site' },
        { ...json, 'Sec-Fetch-Site': 'same-site' },
        { ...json, 'Sec-Fetch-Site': 'none' },
      ];
      for (const headers of attempts) {
        await expectRefused(await post(path, headers, SUBSCRIPTION), 403);
      }
      expect(pushRows()).toEqual({ subscriptions: { count: 1 }, tests: { count: 0 } });
    });

    it(`keeps every other method on ${path} behind the session check, and 404 with one`, async () => {
      const sessionId = await insertSession(DAY_MS);
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
        await expectRefused(await call(method, path));
        expect((await call(method, path, sessionId)).status).toBe(404);
      }
    });
  }
});

describe('the routes that need no session', () => {
  it('are exactly the three ways to sign in', () => {
    // Pinned on purpose: a route added to sessionFreeRoutes is reachable by anyone.
    expect(sessionFreeRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /api/signin',
      'POST /api/signin/request',
      'POST /api/signin/verify',
    ]);
  });

  it('are not also in the list behind the session check', () => {
    const open = new Set(sessionFreeRoutes.map((route) => route.path));
    expect(protectedRoutes.filter((route) => open.has(route.path))).toEqual([]);
  });

  for (const route of sessionFreeRoutes) {
    it(`answers POST ${route.path} without a session, with something other than the guard's 401 or 403`, async () => {
      // An empty JSON object is a valid body for none of them and harmless for all.
      const response = await call('POST', route.path, undefined, '{}');
      expect([204, 401, 410]).toContain(response.status);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    });

    it(`refuses POST ${route.path} that is not JSON from the page itself`, async () => {
      const json = { 'Content-Type': 'application/json' };
      const attempts: Record<string, string>[] = [
        {},
        { 'Content-Type': 'text/plain' },
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        { ...json, 'Sec-Fetch-Site': 'cross-site' },
        { ...json, 'Sec-Fetch-Site': 'same-site' },
        { ...json, 'Sec-Fetch-Site': 'none' },
      ];
      for (const headers of attempts) {
        await expectRefused(await post(route.path, headers, '{}'), 403);
      }
      // Nothing happened: no email was counted, no request was made.
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM signin_email_sends').get()).toEqual({
        count: 0,
      });
    });

    it(`keeps every other method on ${route.path} behind the session check`, async () => {
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
        const response = await call(method, route.path);
        expect(response.status).toBe(401);
        expect(response.headers.get('Set-Cookie')).toBeNull();
      }
    });
  }

  it('keeps paths next to them behind the session check', async () => {
    const paths = ['/api/signin/', '/api/signin/request/', '/api/signin/verify/x', '/api/signin/x'];
    for (const path of paths) {
      await expectRefused(await call('POST', path, undefined, '{}'));
    }
  });
});

describe('signing in', () => {
  it('swaps a valid code for a session cookie with the required attributes', async () => {
    const code = await insertCode(15 * MINUTE_MS);
    const response = await postSignin(JSON.stringify({ code }));
    expect(response.status).toBe(204);
    const cookie = response.headers.get('Set-Cookie') ?? '';
    expect(cookie).toMatch(/^__Host-session=[0-9a-f]{64}; /);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${180 * 24 * 60 * 60}`);
  });

  it('gives a session that loads an empty but valid status', async () => {
    const sessionId = await signInWith(await insertCode(15 * MINUTE_MS));
    const response = await call('GET', '/api/status', sessionId);
    expect(response.status).toBe(200);
    const status: StatusResponse = await response.json();
    expect(status).toEqual({
      checkedAt: null,
      problems: [],
      groups: [],
      unassigned: [],
      events: [],
      sources: expect.any(Array) as unknown,
      // The test env has no push keys.
      push: { vapidPublicKey: null, keys: 'absent', devices: 0 },
    });
  });

  it('stores neither the code nor the session id, only their hashes', async () => {
    const code = await insertCode(15 * MINUTE_MS);
    const sessionId = await signInWith(code);
    const stored = JSON.stringify([
      sqlite.prepare('SELECT * FROM signin_codes').all(),
      sqlite.prepare('SELECT * FROM sessions').all(),
    ]);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(sessionId);
    expect(stored).toContain(await hashToken(sessionId));
  });

  it('refuses a code the second time', async () => {
    const code = await insertCode(15 * MINUTE_MS);
    await signInWith(code);
    await expectRefused(await postSignin(JSON.stringify({ code })));
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
  });

  it('gives one session when the same code is sent twice at once', async () => {
    const code = await insertCode(15 * MINUTE_MS);
    const body = JSON.stringify({ code });
    const responses = await Promise.all([postSignin(body), postSignin(body)]);
    expect(responses.map((response) => response.status).sort()).toEqual([204, 401]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
  });

  it('refuses an expired code', async () => {
    const code = await insertCode(-1);
    await expectRefused(await postSignin(JSON.stringify({ code })));
  });

  it('refuses a well-formed code that was never issued', async () => {
    await insertCode(15 * MINUTE_MS);
    await expectRefused(await postSignin(JSON.stringify({ code: generateToken() })));
  });

  it('refuses the stored hash of a code in place of the code', async () => {
    const code = await insertCode(15 * MINUTE_MS);
    await expectRefused(await postSignin(JSON.stringify({ code: await hashToken(code) })));
  });

  it('refuses malformed requests', async () => {
    const code = await insertCode(15 * MINUTE_MS);
    const bodies = [
      '',
      'not json',
      'null',
      '[]',
      JSON.stringify({}),
      JSON.stringify({ code: 42 }),
      JSON.stringify({ code: code.toUpperCase() }),
      JSON.stringify({ code: `${code} ` }),
      JSON.stringify({ code: code.slice(1) }),
      JSON.stringify({ code, padding: 'x'.repeat(500) }),
    ];
    for (const body of bodies) {
      await expectRefused(await postSignin(body));
    }
    // None of those used the code up.
    await signInWith(code);
  });
});

describe('requests from other sites', () => {
  const json = { 'Content-Type': 'application/json' };

  async function expectSigninRefused(headers: Record<string, string>): Promise<void> {
    const code = await insertCode(15 * MINUTE_MS);
    const countSessions = () => sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get();
    const before = countSessions();
    await expectRefused(await post(SIGNIN_PATH, headers, JSON.stringify({ code })), 403);
    // No session was made, and the code was not used up.
    expect(countSessions()).toEqual(before);
    await signInWith(code);
  }

  it('cannot sign a browser in with a form post or a body without a JSON content type', async () => {
    await expectSigninRefused({});
    await expectSigninRefused({ 'Content-Type': 'text/plain' });
    await expectSigninRefused({ 'Content-Type': 'application/x-www-form-urlencoded' });
    await expectSigninRefused({ 'Content-Type': 'multipart/form-data; boundary=x' });
  });

  it('cannot sign a browser in from another site or another origin', async () => {
    await expectSigninRefused({ ...json, 'Sec-Fetch-Site': 'cross-site' });
    await expectSigninRefused({ ...json, 'Sec-Fetch-Site': 'same-site' });
    await expectSigninRefused({ ...json, 'Sec-Fetch-Site': 'none' });
  });

  it('cannot sign the owner out', async () => {
    const sessionId = await signInWith(await insertCode(15 * MINUTE_MS));
    const cookie = { Cookie: `__Host-session=${sessionId}` };
    const attempts = [
      cookie,
      { ...cookie, 'Content-Type': 'text/plain' },
      { ...cookie, ...json, 'Sec-Fetch-Site': 'cross-site' },
      { ...cookie, ...json, 'Sec-Fetch-Site': 'same-site' },
    ];
    for (const headers of attempts) {
      await expectRefused(await post('/api/signout', headers), 403);
    }
    expect((await call('GET', '/api/status', sessionId)).status).toBe(200);
  });

  it('accepts the page itself: JSON, same-origin, with or without a charset', async () => {
    const code = await insertCode(15 * MINUTE_MS);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Sec-Fetch-Site': 'same-origin',
    };
    const response = await post(SIGNIN_PATH, headers, JSON.stringify({ code }));
    expect(response.status).toBe(204);
    const sessionId = /^__Host-session=([0-9a-f]{64});/.exec(
      response.headers.get('Set-Cookie') ?? '',
    )?.[1];
    const signout = await post('/api/signout', {
      ...headers,
      Cookie: `__Host-session=${sessionId}`,
    });
    expect(signout.status).toBe(204);
  });
});

describe('the sign-in body', () => {
  const json = { 'Content-Type': 'application/json' };

  it('is not read when its declared length is over the limit', async () => {
    let wasRead = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          wasRead = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(`https://stackhush.test${SIGNIN_PATH}`, {
      method: 'POST',
      headers: { ...json, 'Content-Length': '100000' },
      body,
      duplex: 'half',
    } as RequestInit);
    await expectRefused(await worker.fetch(request, env));
    expect(wasRead).toBe(false);
  });

  it('stops being read once it passes the limit, when no length was declared', async () => {
    let chunksRead = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          chunksRead += 1;
          controller.enqueue(new TextEncoder().encode('x'.repeat(100)));
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(`https://stackhush.test${SIGNIN_PATH}`, {
      method: 'POST',
      headers: json,
      body,
      duplex: 'half',
    } as RequestInit);
    await expectRefused(await worker.fetch(request, env));
    // An endless body: three 100-byte chunks pass the 200-byte limit.
    expect(chunksRead).toBeLessThanOrEqual(4);
  });

  it('refuses a malformed declared length', async () => {
    const code = await insertCode(15 * MINUTE_MS);
    const request = new Request(`https://stackhush.test${SIGNIN_PATH}`, {
      method: 'POST',
      headers: { ...json, 'Content-Length': 'lots' },
      body: JSON.stringify({ code }),
    });
    await expectRefused(await worker.fetch(request, env));
  });
});

describe('signing out', () => {
  it('revokes the session and clears the cookie', async () => {
    const sessionId = await signInWith(await insertCode(15 * MINUTE_MS));
    const response = await call('POST', '/api/signout', sessionId);
    expect(response.status).toBe(204);
    expect(response.headers.get('Set-Cookie')).toMatch(/^__Host-session=; Max-Age=0; /);
    await expectRefused(await call('GET', '/api/status', sessionId));
  });

  it('leaves other sessions signed in', async () => {
    const phone = await signInWith(await insertCode(15 * MINUTE_MS));
    const laptop = await signInWith(await insertCode(15 * MINUTE_MS));
    await call('POST', '/api/signout', phone);
    expect((await call('GET', '/api/status', laptop)).status).toBe(200);
  });
});

describe('the cron run', () => {
  // The cron run also checks the watched projects. Tests must never reach the real network.
  beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('unavailable', { status: 503 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function countRows(table: 'signin_codes' | 'sessions'): unknown {
    return sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  }

  it('deletes expired codes and sessions and keeps live ones', async () => {
    await insertCode(-1);
    await insertCode(15 * MINUTE_MS);
    await insertSession(-1);
    await insertSession(DAY_MS);
    const controller = { scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} };
    await worker.scheduled(controller, env);
    expect(countRows('signin_codes')).toEqual({ count: 1 });
    expect(countRows('sessions')).toEqual({ count: 1 });
  });

  it('cannot be started over HTTP, even when signed in', async () => {
    await insertCode(-1);
    const sessionId = await insertSession(DAY_MS);
    const paths = ['/__scheduled', '/cdn-cgi/handler/scheduled', '/api/scheduled', '/api/run'];
    for (const path of paths) {
      for (const method of ['GET', 'POST']) {
        await expectRefused(await call(method, path, sessionId), 404);
      }
    }
    // The expired code is still there, so no request ran the cron work.
    expect(countRows('signin_codes')).toEqual({ count: 1 });
  });
});
