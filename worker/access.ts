// Owner-only access. A one-time code (from `npm run signin-link`, or the link in a sign-in email)
// is swapped for a session; the session id lives only in an HttpOnly cookie and is stored hashed.
// Asking for a sign-in email and typing its short code is in worker/emailSignin.ts.

import { hashToken, generateToken, TOKEN_PATTERN } from './tokens.ts';

// The __Host- prefix makes the browser refuse the cookie unless it is Secure, has Path=/ and no
// Domain, so no other site or subdomain can set or overwrite it.
const SESSION_COOKIE = '__Host-session';
export const SESSION_LIFETIME_SECONDS = 180 * 24 * 60 * 60;

/**
 * Swaps a sign-in code for a new session and returns the session id for the cookie, or null when
 * the code is malformed, unknown, expired or already used. The caller must not say which.
 */
export async function exchangeCode(
  db: D1Database,
  code: string,
  now: Date,
): Promise<string | null> {
  if (!TOKEN_PATTERN.test(code)) return null;

  const codeHash = await hashToken(code);
  const sessionId = generateToken();
  const sessionHash = await hashToken(sessionId);
  const nowText = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_SECONDS * 1000).toISOString();

  // One transaction: the session is created only if the code is valid and unused, and the code
  // is marked used in the same step. Two requests racing with one code get one session.
  // If the code is the link of a sign-in email, the short code of that email dies with it. That
  // update needs no validity check of its own: it only matters when the link code is live, and
  // presenting the link code at all takes knowing it.
  const [insertResult] = await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (id_hash, expires_at, created_at, updated_at)
         SELECT ?, ?, ?, ? FROM signin_codes
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .bind(sessionHash, expiresAt, nowText, nowText, codeHash, nowText),
    db
      .prepare(
        `UPDATE signin_codes SET used_at = ?, updated_at = ?
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .bind(nowText, nowText, codeHash, nowText),
    db
      .prepare(
        `UPDATE signin_requests SET used_at = ?, updated_at = ?
         WHERE link_code_hash = ? AND used_at IS NULL`,
      )
      .bind(nowText, nowText, codeHash),
  ]);
  if (insertResult?.meta.changes !== 1) return null;
  return sessionId;
}

/** Returns the stored hash of the request's session, or null when it has no valid session. */
export async function findSession(
  db: D1Database,
  request: Request,
  now: Date,
): Promise<string | null> {
  const sessionId = readCookie(request, SESSION_COOKIE);
  if (sessionId === null || !TOKEN_PATTERN.test(sessionId)) return null;

  const sessionHash = await hashToken(sessionId);
  const row = await db
    .prepare('SELECT id_hash FROM sessions WHERE id_hash = ? AND expires_at > ?')
    .bind(sessionHash, now.toISOString())
    .first<{ id_hash: string }>();
  return row?.id_hash ?? null;
}

export async function revokeSession(db: D1Database, sessionHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(sessionHash).run();
}

/** Expired codes and sessions are useless; the cron run deletes them. */
export async function deleteExpiredAccess(db: D1Database, now: Date): Promise<void> {
  const nowText = now.toISOString();
  await db.batch([
    db.prepare('DELETE FROM signin_codes WHERE expires_at <= ?').bind(nowText),
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(nowText),
  ]);
}

export function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Max-Age=${SESSION_LIFETIME_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}
