// Push notifications: the stored subscriptions (one per browser that turned them on), checking
// what a browser sends, and sending. A push is a second way to hear about an alert; the email
// stays the record, so nothing here may fail a run, and no failure here becomes an alert.
// Nothing here logs an endpoint, a key or a payload.

import type { PushOutcome, PushPayload, PushTestResult } from '../shared/api.ts';
import type { Config } from './config.ts';
import { isRecord, REQUEST_TIMEOUT_MS, type Fetcher } from './sources/http.ts';
import {
  AUTH_SECRET_BYTES,
  base64UrlDecode,
  encryptPayload,
  generateFreshSecrets,
  importSubscriberKey,
  P256_PUBLIC_KEY_BYTES,
  vapidAuthorization,
  type VapidKeys,
} from './webPush.ts';

/** When one more subscribes, the least recently active is dropped. One owner has a handful. */
export const MAX_SUBSCRIPTIONS = 10;
export const MAX_TESTS_PER_HOUR = 5;
/** Real endpoints are a few hundred characters. */
export const MAX_ENDPOINT_LENGTH = 2048;
/** base64url of 65 and of 16 bytes. */
const P256DH_LENGTH = 87;
const AUTH_LENGTH = 22;

// How long a push service keeps a message for a phone that is off or out of reach. After half
// a day the dashboard and the email say more than a late notification would.
const TTL_SECONDS = 12 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;

export interface Subscription {
  /** The push service URL the browser was given. */
  endpoint: string;
  /** The browser's public key and auth secret, base64url as the browser gave them. */
  p256dh: string;
  auth: string;
}

/**
 * Reads an endpoint from a request: an https URL of a sane length without credentials. Which
 * push service it belongs to is not checked: there is no complete list of them. Returns the
 * URL in its normal form, so two spellings of one endpoint are one row, and subscribing and
 * unsubscribing always mean the same one.
 */
export function parseEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT_LENGTH) return null;
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  return url.href.length > MAX_ENDPOINT_LENGTH ? null : url.href;
}

/**
 * Reads a subscription in the shape of the browser's PushSubscription.toJSON():
 * { endpoint, keys: { p256dh, auth } }. Null for anything that could never be sent to: a wrong
 * type or length, or a public key that is not a point on the curve. Other fields are ignored.
 */
export async function parseSubscription(body: unknown): Promise<Subscription | null> {
  if (!isRecord(body) || !isRecord(body['keys'])) return null;
  const endpoint = parseEndpoint(body['endpoint']);
  const { p256dh, auth } = body['keys'];
  if (endpoint === null || typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (p256dh.length !== P256DH_LENGTH || auth.length !== AUTH_LENGTH) return null;
  const publicKey = base64UrlDecode(p256dh);
  if (publicKey?.byteLength !== P256_PUBLIC_KEY_BYTES) return null;
  if (base64UrlDecode(auth)?.byteLength !== AUTH_SECRET_BYTES) return null;
  try {
    await importSubscriberKey(publicKey);
  } catch {
    return null;
  }
  return { endpoint, p256dh, auth };
}

// A subscription only counts while the session that made it does: a browser that was signed
// out (or whose session expired, or a stolen session that was cut off with DELETE FROM sessions)
// must not go on receiving alerts. Every read below has this condition; binds one value, now.
const HAS_LIVE_SESSION = 'session_hash IN (SELECT id_hash FROM sessions WHERE expires_at > ?)';

/**
 * Stores a subscription for the session that asks. Subscribing again with the same endpoint
 * replaces its keys, hands it to the session that asks now and forgets its failures, so the
 * page can simply repeat it. Past MAX_SUBSCRIPTIONS the least recently active of the others
 * are deleted, in the same transaction.
 */
export async function saveSubscription(
  db: D1Database,
  subscription: Subscription,
  sessionHash: string,
  now: Date,
): Promise<void> {
  const nowText = now.toISOString();
  const { endpoint, p256dh, auth } = subscription;
  await db.batch([
    db
      .prepare(
        `INSERT INTO push_subscriptions
           (endpoint, p256dh, auth, session_hash, last_active_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET
           p256dh = excluded.p256dh, auth = excluded.auth, session_hash = excluded.session_hash,
           last_active_at = excluded.last_active_at, consecutive_failures = 0,
           updated_at = excluded.updated_at`,
      )
      .bind(endpoint, p256dh, auth, sessionHash, nowText, nowText, nowText),
    db
      .prepare(
        `DELETE FROM push_subscriptions
         WHERE endpoint <> ? AND endpoint NOT IN (
           SELECT endpoint FROM push_subscriptions WHERE endpoint <> ?
           ORDER BY last_active_at DESC, endpoint LIMIT ?
         )`,
      )
      .bind(endpoint, endpoint, MAX_SUBSCRIPTIONS - 1),
  ]);
}

/**
 * Deletes the subscriptions whose session is gone or expired. The cron run does this, and so
 * does every send before it reads them.
 */
export async function deleteOrphanedSubscriptions(db: D1Database, now: Date): Promise<void> {
  await db
    .prepare(`DELETE FROM push_subscriptions WHERE NOT ${HAS_LIVE_SESSION}`)
    .bind(now.toISOString())
    .run();
}

/** Deletes one subscription. Deleting one that is not there is not an error. */
export async function deleteSubscription(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
}

export async function countSubscriptions(db: D1Database, now: Date): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM push_subscriptions WHERE ${HAS_LIVE_SESSION}`)
    .bind(now.toISOString())
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** The oldest `limit` subscriptions: when a run cannot pay for all, the newest ones wait. */
export async function loadSubscriptions(
  db: D1Database,
  limit: number,
  now: Date,
): Promise<Subscription[]> {
  const { results } = await db
    .prepare(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE ${HAS_LIVE_SESSION}
       ORDER BY created_at, endpoint LIMIT ?`,
    )
    .bind(now.toISOString(), limit)
    .all<Subscription>();
  return results;
}

export async function findSubscription(
  db: D1Database,
  endpoint: string,
  now: Date,
): Promise<Subscription | null> {
  return db
    .prepare(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions
       WHERE endpoint = ? AND ${HAS_LIVE_SESSION}`,
    )
    .bind(endpoint, now.toISOString())
    .first<Subscription>();
}

/** What the notification says. The count is for the badge on the app icon. */
export function composePayload(title: string, problemCount: number, config: Config): PushPayload {
  let body = 'No current problems';
  if (problemCount === 1) body = '1 current problem';
  if (problemCount > 1) body = `${problemCount} current problems`;
  return { title, body, problemCount, url: config.dashboardUrl };
}

export interface PushSender {
  db: D1Database;
  fetcher: Fetcher;
  keys: VapidKeys;
  config: Config;
  now: Date;
}

/**
 * Sends one message to each of the subscriptions, side by side: one subrequest each, no
 * retries, no redirects followed. Then stores what happened: a subscription the push service
 * no longer knows (404 or 410) is deleted, any other failure is counted, an accepted message
 * resets the count. Returns one result per subscription, in the order given.
 */
export async function sendPushes(
  sender: PushSender,
  subscriptions: readonly Subscription[],
  payload: PushPayload,
): Promise<PushTestResult[]> {
  const message = new TextEncoder().encode(JSON.stringify(payload));
  const results = await Promise.all(
    subscriptions.map((subscription) => sendPush(sender, subscription, message)),
  );
  await storeResults(sender.db, subscriptions, results, sender.now.toISOString());
  return results;
}

/** Never throws: whatever goes wrong with one subscription is that subscription's failure. */
async function sendPush(
  { fetcher, keys, config, now }: PushSender,
  subscription: Subscription,
  message: Uint8Array,
): Promise<PushTestResult> {
  let response: Response;
  try {
    const p256dh = base64UrlDecode(subscription.p256dh);
    const auth = base64UrlDecode(subscription.auth);
    if (p256dh === null || auth === null) return { outcome: 'failed', status: null };
    const body = await encryptPayload(message, { p256dh, auth }, await generateFreshSecrets());
    const authorization = await vapidAuthorization(keys, {
      audience: new URL(subscription.endpoint).origin,
      // The dashboard URL, never an email address: a push service may log it.
      subject: config.dashboardUrl,
      now,
    });
    response = await fetcher(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_SECONDS),
        // An alert is worth waking a phone for.
        Urgency: 'high',
      },
      body,
      // A redirect would be a second subrequest, and no push service answers with one.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
  } catch {
    // Not the error itself: it could carry the endpoint.
    return { outcome: 'failed', status: null };
  }
  return { outcome: outcomeOf(response.status), status: response.status };
}

function outcomeOf(status: number): PushOutcome {
  if (status >= 200 && status < 300) return 'sent';
  // RFC 8030 section 7.3 (410) and what push services answer for an unknown subscription (404).
  if (status === 404 || status === 410) return 'gone';
  return 'failed';
}

async function storeResults(
  db: D1Database,
  subscriptions: readonly Subscription[],
  results: readonly PushTestResult[],
  now: string,
): Promise<void> {
  const statements = subscriptions.map(({ endpoint }, index) => {
    const outcome = results[index]?.outcome;
    if (outcome === 'gone') {
      return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint);
    }
    if (outcome === 'sent') {
      return db
        .prepare(
          'UPDATE push_subscriptions SET consecutive_failures = 0, last_success_at = ?, last_active_at = ?, updated_at = ? WHERE endpoint = ?',
        )
        .bind(now, now, now, endpoint);
    }
    return db
      .prepare(
        'UPDATE push_subscriptions SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE endpoint = ?',
      )
      .bind(now, endpoint);
  });
  if (statements.length > 0) await db.batch(statements);
}

/**
 * Takes one of the hour's test sends; false when they are used up. One statement, so requests
 * racing each other cannot pass the cap together. Rows older than the hour are deleted here:
 * the table never holds more than a few.
 */
export async function reserveTestSend(db: D1Database, now: Date): Promise<boolean> {
  const nowText = now.toISOString();
  const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString();
  const [, reservation] = await db.batch([
    db.prepare('DELETE FROM push_test_sends WHERE created_at <= ?').bind(hourAgo),
    db
      .prepare(
        `INSERT INTO push_test_sends (id, created_at, updated_at)
         SELECT ?, ?, ?
         WHERE (SELECT COUNT(*) FROM push_test_sends WHERE created_at > ?) < ?`,
      )
      .bind(crypto.randomUUID(), nowText, nowText, hourAgo, MAX_TESTS_PER_HOUR),
  ]);
  return reservation?.meta.changes === 1;
}

/**
 * Stores how many subscriptions the run had no subrequest for, for the dashboard's problem.
 * Written only when it changes.
 */
export async function storePushShort(db: D1Database, short: number): Promise<void> {
  await db
    .prepare('UPDATE run_state SET push_short = ? WHERE id = 1 AND push_short <> ?')
    .bind(short, short)
    .run();
}
