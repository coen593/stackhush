// Sign-in by email: "Email me a sign-in code" makes a request, emails its two codes to the
// owner, and the short one is typed back into the browser that asked. Only hashes are stored.

import { normalizeSigninCode } from '../shared/signinCode.ts';
import { readCookie, SESSION_LIFETIME_SECONDS } from './access.ts';
import { sendAlertEmail } from './alerts.ts';
import type { Config } from './config.ts';
import { composeSigninEmail } from './signinEmail.ts';
import {
  generateShortCode,
  generateToken,
  hashToken,
  SIGNIN_CODE_LIFETIME_MS,
  TOKEN_PATTERN,
} from './tokens.ts';

// The limits that make an 8-character code safe, and keep the button from flooding the inbox.
//
// Brute force over a year: a short code is only accepted together with the cookie of the browser
// that asked for it, so an attacker can only guess at requests of their own. Each request costs
// one email, and emails are capped for everyone together: 20 a day, 5 guesses each, so at most
// 100 guesses a day, 36,500 a year, against 31^8 = 852,891,037,441 equally likely codes. That is
// a chance of about 1 in 23 million per year for an attacker who uses up every email of every
// day (which also means 7,300 emails in the owner's inbox and the button never working for him).
export const MAX_FAILED_ATTEMPTS = 5;
export const MAX_EMAILS_PER_HOUR = 5;
export const MAX_EMAILS_PER_DAY = 20;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// SameSite=Strict: only the dashboard's own pages ever send it, and nothing needs it on a
// navigation from elsewhere. The __Host- prefix is explained in worker/access.ts.
const REQUEST_COOKIE = '__Host-signin-request';
const REQUEST_COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Strict';

export type RequestOutcome =
  | { kind: 'sent'; requestId: string }
  /** The hourly or daily cap is reached; no email was sent. */
  | { kind: 'capped' }
  | { kind: 'send-failed' };

export type VerifyOutcome =
  | { kind: 'signed-in'; sessionId: string }
  /** The request is still open and has tries left. */
  | { kind: 'wrong-code' }
  | { kind: 'too-many-attempts' }
  /** No open request for this browser: no cookie, an unknown one, expired or already used. */
  | { kind: 'closed' };

/**
 * Makes a sign-in request and emails its codes to the owner, unless the email cap is reached.
 * A browser that asks again ("Send a new code") still has the cookie of its earlier request:
 * once the new email is sent, that request and its link are void.
 */
export async function requestSigninEmail(
  env: Env,
  config: Config,
  request: Request,
  now: Date,
): Promise<RequestOutcome> {
  const db = env.DB;
  const nowText = now.toISOString();

  // One statement, so presses racing each other cannot pass the cap together. The slot is
  // taken before sending and never given back.
  const reservation = await db
    .prepare(
      `INSERT INTO signin_email_sends (id, created_at, updated_at)
       SELECT ?, ?, ?
       WHERE (SELECT COUNT(*) FROM signin_email_sends WHERE created_at > ?) < ?
         AND (SELECT COUNT(*) FROM signin_email_sends WHERE created_at > ?) < ?`,
    )
    .bind(
      crypto.randomUUID(),
      nowText,
      nowText,
      new Date(now.getTime() - HOUR_MS).toISOString(),
      MAX_EMAILS_PER_HOUR,
      new Date(now.getTime() - DAY_MS).toISOString(),
      MAX_EMAILS_PER_DAY,
    )
    .run();
  if (reservation.meta.changes !== 1) return { kind: 'capped' };

  const requestId = generateToken();
  const shortCode = generateShortCode();
  const linkCode = generateToken();
  const requestHash = await hashToken(requestId);
  const linkCodeHash = await hashToken(linkCode);
  const expiresAt = new Date(now.getTime() + SIGNIN_CODE_LIFETIME_MS).toISOString();
  await db.batch([
    db
      .prepare(
        'INSERT INTO signin_codes (code_hash, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .bind(linkCodeHash, expiresAt, nowText, nowText),
    db
      .prepare(
        `INSERT INTO signin_requests
           (request_hash, short_code_hash, link_code_hash, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        requestHash,
        await hashShortCode(requestId, shortCode),
        linkCodeHash,
        expiresAt,
        nowText,
        nowText,
      ),
  ]);

  // Always the configured address, never the Host of the request.
  const link = new URL('/signin', config.dashboardUrl);
  link.hash = `code=${linkCode}`;
  try {
    await sendAlertEmail(env, config, composeSigninEmail(shortCode, link.href));
  } catch (error) {
    // Only the error code: a message could echo parts of the email, which holds both codes.
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
    console.error(`Sign-in email failed (${code})`);
    // Nobody received these codes; remove them rather than leave a request nobody can use.
    await db.batch([
      db.prepare('DELETE FROM signin_requests WHERE request_hash = ?').bind(requestHash),
      db.prepare('DELETE FROM signin_codes WHERE code_hash = ?').bind(linkCodeHash),
    ]);
    return { kind: 'send-failed' };
  }

  // Only after the send: when no new email went out, the earlier code keeps working.
  const earlierId = readCookie(request, REQUEST_COOKIE);
  if (earlierId !== null && TOKEN_PATTERN.test(earlierId)) {
    await voidRequest(db, await hashToken(earlierId), nowText);
  }
  return { kind: 'sent', requestId };
}

/** Uses up an open request and its link code together, without making a session. */
async function voidRequest(db: D1Database, requestHash: string, nowText: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE signin_codes SET used_at = ?, updated_at = ?
         WHERE used_at IS NULL
           AND code_hash = (SELECT link_code_hash FROM signin_requests
                            WHERE request_hash = ? AND used_at IS NULL)`,
      )
      .bind(nowText, nowText, requestHash),
    db
      .prepare(
        `UPDATE signin_requests SET used_at = ?, updated_at = ?
         WHERE request_hash = ? AND used_at IS NULL`,
      )
      .bind(nowText, nowText, requestHash),
  ]);
}

/**
 * Swaps the typed short code for a session. It only works from the browser that asked: the
 * request is found by its cookie, and the code is checked against that request alone.
 */
export async function verifySigninCode(
  db: D1Database,
  request: Request,
  typedCode: string,
  now: Date,
): Promise<VerifyOutcome> {
  const requestId = readCookie(request, REQUEST_COOKIE);
  if (requestId === null || !TOKEN_PATTERN.test(requestId)) return { kind: 'closed' };
  // Something that cannot be a code is not a guess, so it does not use up a try.
  const shortCode = normalizeSigninCode(typedCode);
  if (shortCode === null) return { kind: 'wrong-code' };

  const requestHash = await hashToken(requestId);
  const shortCodeHash = await hashShortCode(requestId, shortCode);
  const sessionId = generateToken();
  const sessionHash = await hashToken(sessionId);
  const nowText = now.toISOString();
  const sessionExpiresAt = new Date(now.getTime() + SESSION_LIFETIME_SECONDS * 1000).toISOString();

  // "This browser's request, still open, and this is its code."
  const matches = `request_hash = ? AND short_code_hash = ? AND used_at IS NULL
    AND expires_at > ? AND failed_attempts < ?`;
  const matchValues = [requestHash, shortCodeHash, nowText, MAX_FAILED_ATTEMPTS] as const;

  // One transaction, like exchangeCode: the session exists only if the code matched, and in the
  // same step the request and its link are used up, or the wrong guess is counted. Requests
  // racing with the right code get one session; racing wrong guesses are all counted.
  const [insertResult] = await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (id_hash, expires_at, created_at, updated_at)
         SELECT ?, ?, ?, ? FROM signin_requests WHERE ${matches}`,
      )
      .bind(sessionHash, sessionExpiresAt, nowText, nowText, ...matchValues),
    db
      .prepare(
        `UPDATE signin_codes SET used_at = ?, updated_at = ?
         WHERE used_at IS NULL
           AND code_hash = (SELECT link_code_hash FROM signin_requests WHERE ${matches})`,
      )
      .bind(nowText, nowText, ...matchValues),
    db
      .prepare(
        `UPDATE signin_requests SET failed_attempts = failed_attempts + 1, updated_at = ?
         WHERE request_hash = ? AND short_code_hash <> ? AND used_at IS NULL
           AND expires_at > ? AND failed_attempts < ?`,
      )
      .bind(nowText, ...matchValues),
    db
      .prepare(`UPDATE signin_requests SET used_at = ?, updated_at = ? WHERE ${matches}`)
      .bind(nowText, nowText, ...matchValues),
  ]);
  if (insertResult?.meta.changes === 1) return { kind: 'signed-in', sessionId };

  // Only to pick the message; whoever holds the cookie may know which it is.
  const open = await db
    .prepare(
      `SELECT failed_attempts FROM signin_requests
       WHERE request_hash = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .bind(requestHash, nowText)
    .first<{ failed_attempts: number }>();
  if (!open) return { kind: 'closed' };
  if (open.failed_attempts >= MAX_FAILED_ATTEMPTS) return { kind: 'too-many-attempts' };
  return { kind: 'wrong-code' };
}

/**
 * Used and expired requests are useless, and an email older than a day no longer counts
 * towards the caps; the cron run deletes them.
 */
export async function deleteOldSigninRequests(db: D1Database, now: Date): Promise<void> {
  await db.batch([
    db
      .prepare('DELETE FROM signin_requests WHERE expires_at <= ? OR used_at IS NOT NULL')
      .bind(now.toISOString()),
    db
      .prepare('DELETE FROM signin_email_sends WHERE created_at <= ?')
      .bind(new Date(now.getTime() - DAY_MS).toISOString()),
  ]);
}

export function requestCookie(requestId: string): string {
  const maxAge = SIGNIN_CODE_LIFETIME_MS / 1000;
  return `${REQUEST_COOKIE}=${requestId}; Max-Age=${maxAge}; ${REQUEST_COOKIE_ATTRIBUTES}`;
}

export function clearedRequestCookie(): string {
  return `${REQUEST_COOKIE}=; Max-Age=0; ${REQUEST_COOKIE_ATTRIBUTES}`;
}

/**
 * The short code is hashed together with its request id. Hashed alone, its 40 bits could be
 * tried out against a copy of the table in minutes; the request id is 256 bits that exist only
 * in the browser's cookie.
 */
function hashShortCode(requestId: string, shortCode: string): Promise<string> {
  return hashToken(`${requestId}:${shortCode}`);
}
