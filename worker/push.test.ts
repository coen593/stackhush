// Push notifications end to end on the real handler and the real migrations: the routes, the
// run that sends them next to the alert email, the subrequest budget, and what gets deleted.
// The push service is a fake fetcher; every message it receives is decrypted with the
// subscriber's private key, as a browser would.

import type { DatabaseSync } from 'node:sqlite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PushPayload, PushTestResponse, StatusResponse } from '../shared/api.ts';
import { createWorker } from './app.ts';
import { defineConfig, type Config } from './config.ts';
import { MAX_ENDPOINT_LENGTH, MAX_SUBSCRIPTIONS, MAX_TESTS_PER_HOUR } from './push.ts';
import { runChecks } from './run.ts';
import { readSecrets } from './secrets.ts';
import type { Fetcher } from './sources/http.ts';
import { loadStatus } from './status.ts';
import { createTestDatabase } from './testing/fakeD1.ts';
import { decryptPushBody, generateSubscriber, type Subscriber } from './testing/pushReceiver.ts';
import { generateToken, hashToken } from './tokens.ts';
import { base64UrlDecode, generateVapidKeys, type VapidKeys } from './webPush.ts';

const START = Date.parse('2026-11-26T12:00:00.000Z');
const RUN_INTERVAL_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DASHBOARD = 'https://status.example.test';
const PUSH_ORIGIN = 'https://push.example.test';
const SITE = 'https://site.example.test';

/** One site and Supabase: two subrequests planned every run. */
function configWith(subrequestBudget: number): Config {
  return defineConfig({
    dashboardUrl: DASHBOARD,
    alertTo: 'owner@example.test',
    alertFrom: 'stackhush@alerts.example.test',
    subrequestBudget,
    groups: ['All'],
    projects: [{ id: 'site', name: 'Site', group: 'All', productionUrls: [SITE] }],
  });
}

const ROOMY = configWith(45);

interface Device extends Subscriber {
  name: string;
  endpoint: string;
}

interface ReceivedPush {
  device: string;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
  redirect: string | undefined;
}

let vapid: VapidKeys;
let sqlite: DatabaseSync;
let env: Env;
let sessionId: string;
let now: number;
let runIndex: number;
let isSiteDown: boolean;
let emailFails: boolean;
/** In the order things happened: 'check' (a source's request), 'email', 'push:<device>'. */
let log: string[];
/** The subjects of the alert emails, in the order they were sent (accepted or not). */
let subjects: string[];
let received: ReceivedPush[];
/** Device name -> what the push service answers for it; 201 when not named. */
let pushStatus: Map<string, number | 'unreachable'>;

beforeAll(async () => {
  vapid = await generateVapidKeys();
});

const fetcher: Fetcher = (url, init) => {
  if (url.startsWith('https://api.supabase.com/')) {
    log.push('check');
    return Promise.resolve(new Response('[]'));
  }
  if (url.startsWith(SITE)) {
    log.push('check');
    return Promise.resolve(new Response('', { status: isSiteDown ? 503 : 200 }));
  }
  if (!url.startsWith(`${PUSH_ORIGIN}/send/`)) {
    return Promise.reject(new Error(`Unexpected request to ${url}`));
  }
  const device = url.slice(`${PUSH_ORIGIN}/send/`.length);
  log.push(`push:${device}`);
  const answer = pushStatus.get(device) ?? 201;
  if (answer === 'unreachable') return Promise.reject(new TypeError('unreachable'));
  if (init?.method !== 'POST' || !(init.body instanceof Uint8Array)) {
    return Promise.reject(new Error('A push is a POST with a binary body'));
  }
  received.push({
    device,
    headers: new Headers(init.headers),
    body: new Uint8Array(init.body),
    redirect: init.redirect,
  });
  return Promise.resolve(new Response('', { status: answer }));
};

beforeEach(async () => {
  const database = createTestDatabase();
  sqlite = database.sqlite;
  now = START;
  runIndex = 0;
  isSiteDown = false;
  emailFails = false;
  log = [];
  subjects = [];
  received = [];
  pushStatus = new Map();
  env = {
    DB: database.db,
    SUPABASE_TOKEN: 'token',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    ALERT_EMAIL: {
      send: (message: unknown) => {
        log.push('email');
        subjects.push((message as { subject: string }).subject);
        if (emailFails) return Promise.reject(new Error('email service down'));
        return Promise.resolve({ messageId: 'id' });
      },
    },
  };
  sessionId = generateToken();
  sqlite
    .prepare('INSERT INTO sessions (id_hash, expires_at) VALUES (?, ?)')
    .run(await hashToken(sessionId), new Date(Date.now() + HOUR_MS).toISOString());
});

async function makeDevice(name: string): Promise<Device> {
  return { ...(await generateSubscriber()), name, endpoint: `${PUSH_ORIGIN}/send/${name}` };
}

function subscriptionOf(device: Device): unknown {
  return { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } };
}

/** A signed-in POST as the dashboard's own page sends it. */
function post(path: string, body: unknown, config: Config = ROOMY): Promise<Response> {
  return createWorker(config, fetcher).fetch(
    new Request(`${DASHBOARD}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `__Host-session=${sessionId}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );
}

/** Stores a device's subscription directly, each one a second newer than the one before. */
function store(device: Device): void {
  const created = new Date(now - HOUR_MS + stored().length * 1000).toISOString();
  sqlite
    .prepare(
      'INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(device.endpoint, device.p256dh, device.auth, created, created);
}

async function devices(...names: string[]): Promise<Device[]> {
  const made = await Promise.all(names.map(makeDevice));
  made.forEach(store);
  return made;
}

interface StoredRow {
  endpoint: string;
  consecutive_failures: number;
  last_success_at: string | null;
}

/** In place of a last_success_at that is set: when exactly is not what these tests are about. */
const SENT = 'sent';

function stored(): StoredRow[] {
  const rows = sqlite
    .prepare(
      'SELECT endpoint, consecutive_failures, last_success_at FROM push_subscriptions ORDER BY created_at, endpoint',
    )
    .all() as unknown as StoredRow[];
  return rows.map((row) => ({ ...row, last_success_at: row.last_success_at && SENT }));
}

function storedNames(): string[] {
  return stored().map((row) => row.endpoint.slice(`${PUSH_ORIGIN}/send/`.length));
}

function count(table: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
  return row.total;
}

async function run(config: Config = ROOMY): Promise<void> {
  now = START + runIndex * RUN_INTERVAL_MS;
  runIndex += 1;
  const before = log.length;
  await runChecks(env, new Date(now), config, fetcher);
  // Whatever else a test checks: a run never makes more subrequests than its budget.
  const subrequests = log.slice(before).filter((entry) => entry !== 'email').length;
  expect(subrequests).toBeLessThanOrEqual(config.subrequestBudget);
}

/**
 * Three runs: the first seeds silently, the second sees the site fail once, and the third
 * counts it as down and alerts. Returns what the third run did, in order.
 */
async function runUntilAlert(config: Config = ROOMY): Promise<string[]> {
  await run(config);
  isSiteDown = true;
  await run(config);
  expect(log).not.toContain('email');
  expect(received).toEqual([]);
  const before = log.length;
  await run(config);
  return log.slice(before);
}

/** The last push the push service received for a device (they are sent side by side). */
function pushFor(device: Device): ReceivedPush | undefined {
  return received.findLast((push) => push.device === device.name);
}

async function payloadOf(push: ReceivedPush | undefined, device: Device): Promise<PushPayload> {
  if (!push) throw new Error('No push received');
  const plaintext = await decryptPushBody(push.body, device);
  return JSON.parse(new TextDecoder().decode(plaintext)) as PushPayload;
}

async function problems(config: Config = ROOMY): Promise<string[]> {
  const status = await loadStatus(env.DB, config, readSecrets(env, config));
  return status.problems.map((problem) => problem.title).sort();
}

function lastRunFinished(): string | null {
  const row = sqlite.prepare('SELECT last_run_finished_at FROM run_state').get() as {
    last_run_finished_at: string | null;
  };
  return row.last_run_finished_at;
}

function bytes(text: string | undefined): Uint8Array<ArrayBuffer> {
  const decoded = base64UrlDecode(text ?? '');
  if (decoded === null) throw new Error('Not base64url');
  return decoded;
}

/** Checks a push request's VAPID header as a push service would, and returns its claims. */
async function verifiedClaims(push: ReceivedPush | undefined): Promise<Record<string, unknown>> {
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^.,]+), k=(.+)$/.exec(
    push?.headers.get('Authorization') ?? '',
  );
  if (!match) throw new Error('No vapid Authorization header');
  const [, header, body, signature, key] = match;
  expect(key).toBe(vapid.publicKey);
  const publicKey = await crypto.subtle.importKey(
    'raw',
    bytes(key),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const isValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    bytes(signature),
    new TextEncoder().encode(`${header}.${body}`),
  );
  expect(isValid).toBe(true);
  return JSON.parse(new TextDecoder().decode(bytes(body))) as Record<string, unknown>;
}

describe('POST /api/push/subscribe', () => {
  it('stores what the browser gives, and extra fields of toJSON() do not matter', async () => {
    const phone = await makeDevice('phone');
    const body = { ...(subscriptionOf(phone) as object), expirationTime: null };
    const response = await post('/api/push/subscribe', body);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(sqlite.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all()).toEqual([
      { endpoint: phone.endpoint, p256dh: phone.p256dh, auth: phone.auth },
    ]);
  });

  it('replaces the keys and forgets the failures when the same endpoint subscribes again', async () => {
    const [phone] = await devices('phone', 'tablet');
    if (!phone) throw new Error('No device');
    sqlite.exec('UPDATE push_subscriptions SET consecutive_failures = 4');
    const renewed = { ...(await generateSubscriber()), name: 'phone', endpoint: phone.endpoint };

    expect((await post('/api/push/subscribe', subscriptionOf(renewed))).status).toBe(204);

    expect(storedNames()).toEqual(['phone', 'tablet']);
    expect(stored().map((row) => row.consecutive_failures)).toEqual([0, 4]);
    expect(
      sqlite
        .prepare('SELECT p256dh FROM push_subscriptions WHERE endpoint = ?')
        .get(phone.endpoint),
    ).toEqual({ p256dh: renewed.p256dh });
  });

  it('refuses everything that is not a subscription, and stores nothing', async () => {
    const phone = await makeDevice('phone');
    const keys = { p256dh: phone.p256dh, auth: phone.auth };
    const notAPoint = `B${'A'.repeat(86)}`;
    const bad: unknown[] = [
      'not json',
      'null',
      [],
      {},
      { endpoint: phone.endpoint },
      { endpoint: phone.endpoint, keys: 'keys' },
      { keys },
      { endpoint: 7, keys },
      { endpoint: 'push.example.test/send/phone', keys },
      { endpoint: 'http://push.example.test/send/phone', keys },
      { endpoint: 'ftp://push.example.test/send/phone', keys },
      { endpoint: 'https://user:secret@push.example.test/send/phone', keys },
      { endpoint: `${PUSH_ORIGIN}/${'a'.repeat(MAX_ENDPOINT_LENGTH)}`, keys },
      { endpoint: phone.endpoint, keys: { p256dh: phone.p256dh } },
      { endpoint: phone.endpoint, keys: { ...keys, auth: 5 } },
      { endpoint: phone.endpoint, keys: { ...keys, auth: phone.auth.slice(1) } },
      { endpoint: phone.endpoint, keys: { ...keys, auth: `${phone.auth}A` } },
      { endpoint: phone.endpoint, keys: { ...keys, auth: `${phone.auth.slice(0, 21)}=` } },
      { endpoint: phone.endpoint, keys: { ...keys, p256dh: phone.p256dh.slice(1) } },
      { endpoint: phone.endpoint, keys: { ...keys, p256dh: `${phone.p256dh.slice(0, 86)}+` } },
      // The right length and alphabet, but not a point on the curve.
      { endpoint: phone.endpoint, keys: { ...keys, p256dh: notAPoint } },
      // The auth secret where the public key belongs.
      { endpoint: phone.endpoint, keys: { p256dh: phone.auth, auth: phone.p256dh } },
      // Valid, but padded past the size any subscription has.
      { ...(subscriptionOf(phone) as object), padding: 'x'.repeat(5000) },
    ];
    for (const body of bad) {
      const response = await post('/api/push/subscribe', body);
      expect(response.status, JSON.stringify(body).slice(0, 120)).toBe(400);
      expect(await response.text()).toBe('');
    }
    expect(count('push_subscriptions')).toBe(0);
  });

  it(`keeps at most ${MAX_SUBSCRIPTIONS}: one more drops the oldest`, async () => {
    const names = Array.from({ length: MAX_SUBSCRIPTIONS }, (_, index) => `device-${index}`);
    for (const name of names) {
      // The route stamps rows with the real clock; the order is what matters here.
      expect(
        (await post('/api/push/subscribe', subscriptionOf(await makeDevice(name)))).status,
      ).toBe(204);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(storedNames()).toEqual(names);

    // Subscribing again with a stored endpoint drops nobody.
    await post('/api/push/subscribe', subscriptionOf(await makeDevice('device-3')));
    expect(storedNames()).toEqual(names);

    await post('/api/push/subscribe', subscriptionOf(await makeDevice('newest')));
    expect(storedNames()).toEqual([...names.slice(1), 'newest']);
  });

  it('answers 409 without push keys, or with keys that are not a pair, and stores nothing', async () => {
    const phone = await makeDevice('phone');
    const withoutKeys: Partial<Env>[] = [
      { VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined },
      { VAPID_PRIVATE_KEY: undefined },
      { VAPID_PUBLIC_KEY: '' },
      { VAPID_PRIVATE_KEY: vapid.publicKey },
    ];
    for (const change of withoutKeys) {
      env = { ...env, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey };
      env = { ...env, ...change };
      expect((await post('/api/push/subscribe', subscriptionOf(phone))).status).toBe(409);
      expect((await post('/api/push/test', {})).status).toBe(409);
    }
    expect(count('push_subscriptions')).toBe(0);
    expect(count('push_test_sends')).toBe(0);
  });
});

describe('POST /api/push/unsubscribe', () => {
  it('deletes the subscription of that endpoint and no other', async () => {
    const [phone] = await devices('phone', 'tablet', 'laptop');
    const response = await post('/api/push/unsubscribe', { endpoint: phone?.endpoint });
    expect(response.status).toBe(204);
    expect(storedNames()).toEqual(['tablet', 'laptop']);
  });

  it('answers 204 for an endpoint that is not stored, and works without push keys', async () => {
    const [phone] = await devices('phone', 'tablet');
    env = { ...env, VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined };
    const unknown = await post('/api/push/unsubscribe', { endpoint: `${PUSH_ORIGIN}/send/nobody` });
    expect(unknown.status).toBe(204);
    expect(storedNames()).toEqual(['phone', 'tablet']);
    expect((await post('/api/push/unsubscribe', { endpoint: phone?.endpoint })).status).toBe(204);
    expect(storedNames()).toEqual(['tablet']);
  });

  it('refuses a body without a usable endpoint, and deletes nothing', async () => {
    await devices('phone');
    for (const body of ['{', 'null', {}, { endpoint: 3 }, { endpoint: 'http://x.test/' }, []]) {
      expect((await post('/api/push/unsubscribe', body)).status).toBe(400);
    }
    // Not a prefix or pattern match either.
    expect((await post('/api/push/unsubscribe', { endpoint: `${PUSH_ORIGIN}/send/` })).status).toBe(
      204,
    );
    expect(
      (await post('/api/push/unsubscribe', { endpoint: `${PUSH_ORIGIN}/send/%` })).status,
    ).toBe(204);
    expect(storedNames()).toEqual(['phone']);
  });
});

describe('POST /api/push/test', () => {
  it('sends an encrypted, signed message that only the named device can read', async () => {
    const [phone, tablet] = await devices('phone', 'tablet');
    if (!phone || !tablet) throw new Error('No devices');

    const response = await post('/api/push/test', { endpoint: phone.endpoint });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ results: [{ outcome: 'sent', status: 201 }] });
    expect(text).not.toContain('push.example.test');
    expect(received.map((push) => push.device)).toEqual(['phone']);

    const [push] = received;
    expect(push?.headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(push?.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(push?.headers.get('TTL')).toBe('43200');
    expect(push?.headers.get('Urgency')).toBe('high');
    expect(push?.redirect).toBe('manual');
    expect(await payloadOf(push, phone)).toEqual({
      title: 'Test notification from stackhush',
      body: 'No current problems',
      problemCount: 0,
      url: DASHBOARD,
    });
    await expect(payloadOf(push, tablet)).rejects.toThrow();

    const claims = await verifiedClaims(push);
    expect(claims['aud']).toBe(PUSH_ORIGIN);
    expect(claims['sub']).toBe(DASHBOARD);
    const expiresIn = Number(claims['exp']) - Date.now() / 1000;
    expect(expiresIn).toBeGreaterThan(11 * 3600);
    expect(expiresIn).toBeLessThanOrEqual(12 * 3600);
  });

  it('sends to every device without an endpoint, and says what each push service answered', async () => {
    const all = await devices('phone', 'gone-410', 'gone-404', 'broken', 'offline');
    pushStatus = new Map<string, number | 'unreachable'>([
      ['gone-410', 410],
      ['gone-404', 404],
      ['broken', 500],
      ['offline', 'unreachable'],
    ]);
    sqlite.exec(
      "UPDATE push_subscriptions SET consecutive_failures = 2 WHERE endpoint LIKE '%phone'",
    );

    const response = await post('/api/push/test', {});

    expect(response.status).toBe(200);
    const text = await response.text();
    expect((JSON.parse(text) as PushTestResponse).results).toEqual([
      { outcome: 'sent', status: 201 },
      { outcome: 'gone', status: 410 },
      { outcome: 'gone', status: 404 },
      { outcome: 'failed', status: 500 },
      { outcome: 'failed', status: null },
    ]);
    for (const device of all) expect(text).not.toContain(device.name);
    // Deleted: exactly the two the push service no longer knows. Kept: the rest, with counts.
    expect(stored()).toEqual([
      { endpoint: all[0]?.endpoint, consecutive_failures: 0, last_success_at: SENT },
      { endpoint: all[3]?.endpoint, consecutive_failures: 1, last_success_at: null },
      { endpoint: all[4]?.endpoint, consecutive_failures: 1, last_success_at: null },
    ]);
    expect(await problems()).toEqual([]);
    expect(count('events')).toBe(0);
  });

  it('answers 410 for an endpoint that is not subscribed and 400 for one that is none', async () => {
    await devices('phone');
    const unknown = await post('/api/push/test', { endpoint: `${PUSH_ORIGIN}/send/nobody` });
    expect(unknown.status).toBe(410);
    for (const body of ['{', 'null', [], { endpoint: 5 }, { endpoint: 'http://x.test/' }]) {
      expect((await post('/api/push/test', body)).status).toBe(400);
    }
    expect(received).toEqual([]);
    // None of these used up one of the hour's tests.
    expect(count('push_test_sends')).toBe(0);
  });

  it(`sends at most ${MAX_TESTS_PER_HOUR} an hour`, async () => {
    await devices('phone');
    const realNow = Date.now();
    for (let attempt = 0; attempt < MAX_TESTS_PER_HOUR; attempt += 1) {
      expect((await post('/api/push/test', {})).status).toBe(200);
    }
    const capped = await post('/api/push/test', {});
    expect(capped.status).toBe(429);
    expect(await capped.text()).toBe('');
    expect(received).toHaveLength(MAX_TESTS_PER_HOUR);

    // An hour later the old ones no longer count, and are deleted.
    const old = new Date(realNow - HOUR_MS - 1000).toISOString();
    sqlite.prepare('UPDATE push_test_sends SET created_at = ?').run(old);
    expect((await post('/api/push/test', {})).status).toBe(200);
    expect(received).toHaveLength(MAX_TESTS_PER_HOUR + 1);
    expect(count('push_test_sends')).toBe(1);
  });

  it('counts the current problems for the badge', async () => {
    const [phone] = await devices('phone');
    if (!phone) throw new Error('No device');
    await runUntilAlert();
    received = [];
    await post('/api/push/test', { endpoint: phone.endpoint });
    expect(await payloadOf(pushFor(phone), phone)).toMatchObject({
      body: '1 current problem',
      problemCount: 1,
    });
  });
});

describe('GET /api/status', () => {
  async function status(): Promise<StatusResponse> {
    const response = await createWorker(ROOMY, fetcher).fetch(
      new Request(`${DASHBOARD}/api/status`, {
        headers: { Cookie: `__Host-session=${sessionId}` },
      }),
      env,
    );
    const body: StatusResponse = await response.json();
    return body;
  }

  it('gives the public key to subscribe with, and never the private one', async () => {
    const response = await status();
    expect(response.push).toEqual({ vapidPublicKey: vapid.publicKey });
    expect(JSON.stringify(response)).not.toContain(vapid.privateKey);
    expect(response.problems).toEqual([]);
  });

  it('says push is not set up without keys, which is not a problem', async () => {
    env = { ...env, VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined };
    const response = await status();
    expect(response.push).toEqual({ vapidPublicKey: null });
    expect(response.problems).toEqual([]);
  });

  it('shows a problem for keys that are not a pair', async () => {
    env = { ...env, VAPID_PRIVATE_KEY: 'not-a-key' };
    const response = await status();
    expect(response.push).toEqual({ vapidPublicKey: null });
    expect(response.problems.map((problem) => problem.title)).toEqual([
      'Push keys are not valid: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together; run npm run push-keys',
    ]);
  });
});

describe('a run that alerts', () => {
  it('pushes once per device after the email, with the subject as the title', async () => {
    const [phone, tablet] = await devices('phone', 'tablet');
    if (!phone || !tablet) throw new Error('No devices');

    const alertingRun = await runUntilAlert();

    expect(alertingRun.slice(0, 3)).toEqual(['check', 'check', 'email']);
    expect(alertingRun.slice(3).sort()).toEqual(['push:phone', 'push:tablet']);
    expect(subjects).toEqual([expect.stringMatching(/^site\.example\.test is down \(HTTP 503/)]);
    const expected = {
      title: subjects[0],
      body: '1 current problem',
      problemCount: 1,
      url: DASHBOARD,
    };
    expect(await payloadOf(pushFor(phone), phone)).toEqual(expected);
    expect(await payloadOf(pushFor(tablet), tablet)).toEqual(expected);
    expect((await verifiedClaims(pushFor(phone)))['exp']).toBe(now / 1000 + 12 * 3600);
    expect(sqlite.prepare('SELECT DISTINCT last_success_at FROM push_subscriptions').all()).toEqual(
      [{ last_success_at: new Date(now).toISOString() }],
    );

    // Nothing changed in the next run: no email, so no push.
    received = [];
    await run();
    expect(received).toEqual([]);

    // The recovery is an alert too, and the badge goes back to none.
    isSiteDown = false;
    await run();
    expect(await payloadOf(pushFor(phone), phone)).toMatchObject({
      title: subjects[1],
      body: 'No current problems',
      problemCount: 0,
    });
  });

  it('does not push while the email fails, and pushes once it is accepted', async () => {
    const [phone] = await devices('phone');
    if (!phone) throw new Error('No device');
    emailFails = true;
    expect(await runUntilAlert()).toEqual(['check', 'check', 'email']);
    await run();
    expect(received).toEqual([]);
    expect(count('unsent_alerts')).toBe(1);

    emailFails = false;
    await run();
    expect(received).toHaveLength(1);
    expect(await payloadOf(pushFor(phone), phone)).toMatchObject({ title: subjects.at(-1) });
    expect(subjects.at(-1)).toContain('is down');
    expect(count('unsent_alerts')).toBe(0);
  });

  it('is not held up or changed by push services that fail, and they never become alerts', async () => {
    const all = await devices('phone', 'gone', 'broken', 'offline');
    pushStatus = new Map<string, number | 'unreachable'>([
      ['gone', 410],
      ['broken', 503],
      ['offline', 'unreachable'],
    ]);

    const alertingRun = await runUntilAlert();

    expect(alertingRun.filter((entry) => entry === 'email')).toHaveLength(1);
    expect(count('unsent_alerts')).toBe(0);
    expect(lastRunFinished()).toBe(new Date(now).toISOString());
    // The one event is the site going down; the dashboard has that problem and no other.
    expect(sqlite.prepare('SELECT kind FROM events').all()).toEqual([{ kind: 'site_down' }]);
    expect(await problems()).toEqual([expect.stringContaining('HTTP 503')]);
    expect(stored()).toEqual([
      { endpoint: all[0]?.endpoint, consecutive_failures: 0, last_success_at: SENT },
      { endpoint: all[2]?.endpoint, consecutive_failures: 1, last_success_at: null },
      { endpoint: all[3]?.endpoint, consecutive_failures: 1, last_success_at: null },
    ]);

    // The next alert goes to the three that are left; failures keep counting, without email.
    isSiteDown = false;
    const before = log.length;
    await run();
    expect(
      log
        .slice(before)
        .filter((entry) => entry.startsWith('push:'))
        .sort(),
    ).toEqual(['push:broken', 'push:offline', 'push:phone']);
    expect(stored().map((row) => row.consecutive_failures)).toEqual([0, 2, 2]);
    expect(log.filter((entry) => entry === 'email')).toHaveLength(2);
    expect(await problems()).toEqual([]);
  });

  it('finishes and emails even when the push tables cannot be read', async () => {
    await devices('phone');
    sqlite.exec('DROP TABLE push_subscriptions');
    const alertingRun = await runUntilAlert();
    expect(alertingRun).toEqual(['check', 'check', 'email']);
    expect(count('unsent_alerts')).toBe(0);
    expect(lastRunFinished()).toBe(new Date(now).toISOString());
  });

  it('pushes nothing without push keys, and says nothing about it', async () => {
    await devices('phone', 'tablet');
    env = { ...env, VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined };
    expect(await runUntilAlert(configWith(2))).toEqual(['check', 'check', 'email']);
    expect(storedNames()).toEqual(['phone', 'tablet']);
    expect(await problems(configWith(2))).toEqual([expect.stringContaining('HTTP 503')]);
  });
});

describe('pushes and the subrequest budget', () => {
  function overBudget(devicesShort: string): string {
    return `Over the subrequest budget: no push notification for ${devicesShort}; raise subrequestBudget or remove checks`;
  }

  it('sends all of them when the budget has exactly that much left', async () => {
    await devices('phone', 'tablet', 'laptop');
    const config = configWith(5);
    const alertingRun = await runUntilAlert(config);
    expect(alertingRun.filter((entry) => entry.startsWith('push:'))).toHaveLength(3);
    expect(await problems(config)).toEqual([expect.stringContaining('HTTP 503')]);
  });

  it('sends the ones that fit, oldest first, keeps the email and shows a problem', async () => {
    await devices('phone', 'tablet', 'laptop');
    const config = configWith(4);

    // The problem shows from the first run, before any alert was missed.
    await run(config);
    expect(await problems(config)).toEqual([overBudget('1 device')]);

    isSiteDown = true;
    await run(config);
    const before = log.length;
    await run(config);

    expect(log.slice(before).slice(0, 3)).toEqual(['check', 'check', 'email']);
    expect(log.slice(before).slice(3).sort()).toEqual(['push:phone', 'push:tablet']);
    expect(count('unsent_alerts')).toBe(0);
    expect(await problems(config)).toEqual([
      overBudget('1 device'),
      expect.stringContaining('HTTP 503'),
    ]);
    // Skipped is not failed: the one that did not fit has no failure counted.
    expect(stored().map((row) => row.consecutive_failures)).toEqual([0, 0, 0]);
    expect(stored().map((row) => row.last_success_at === null)).toEqual([false, false, true]);
  });

  it('sends none when nothing is left, and the problem goes when there is room again', async () => {
    await devices('phone', 'tablet');
    const tight = configWith(2);
    expect(await runUntilAlert(tight)).toEqual(['check', 'check', 'email']);
    expect(await problems(tight)).toEqual([
      overBudget('2 devices'),
      expect.stringContaining('HTTP 503'),
    ]);

    // A raised budget: the next run has room, and the next alert is pushed.
    const raised = configWith(4);
    await run(raised);
    expect(await problems(raised)).toEqual([expect.stringContaining('HTTP 503')]);
    isSiteDown = false;
    await run(raised);
    expect(received.map((push) => push.device).sort()).toEqual(['phone', 'tablet']);
  });

  it('pays for a redirect that is known before a push', async () => {
    await devices('phone');
    const config = configWith(3);
    // The site is remembered to take one redirect: with the two checks that is the budget.
    await run(config);
    sqlite.exec(`UPDATE check_states SET detail_json = json_set(detail_json, '$.redirects', 1)`);
    await run(config);
    expect(await problems(config)).toEqual([overBudget('1 device')]);
  });

  it('has no problem to show when turning notifications off made room', async () => {
    const [phone] = await devices('phone');
    const config = configWith(2);
    await run(config);
    expect(await problems(config)).toEqual([overBudget('1 device')]);
    await post('/api/push/unsubscribe', { endpoint: phone?.endpoint }, config);
    await run(config);
    expect(await problems(config)).toEqual([]);
  });
});
