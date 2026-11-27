import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from './responses.ts';
import { createTestEnv, testWorker as worker } from './testing/env.ts';
import { createTestDatabase } from './testing/fakeD1.ts';
import { generateToken, hashToken } from './tokens.ts';

function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(response.headers.get(name)).toBe(value);
  }
  expect(response.headers.get('Cache-Control')).toBe('no-store');
}

describe('security headers', () => {
  it('are the strict set', () => {
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("default-src 'self'");
    expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toBe('max-age=31536000');
  });

  it('are on every kind of API response', async () => {
    const { db, sqlite } = createTestDatabase();
    const env = createTestEnv(db);
    const sessionId = generateToken();
    sqlite
      .prepare('INSERT INTO sessions (id_hash, expires_at) VALUES (?, ?)')
      .run(await hashToken(sessionId), new Date(Date.now() + 60_000).toISOString());
    const signedIn = { Cookie: `__Host-session=${sessionId}` };

    const responses = await Promise.all([
      worker.fetch(new Request('https://stackhush.test/api/status'), env),
      worker.fetch(new Request('https://stackhush.test/api/status', { headers: signedIn }), env),
      worker.fetch(new Request('https://stackhush.test/api/nope', { headers: signedIn }), env),
      worker.fetch(
        new Request('https://stackhush.test/api/signin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
        env,
      ),
      worker.fetch(
        new Request('https://stackhush.test/api/signin', { method: 'POST', body: '{}' }),
        env,
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 200, 404, 401, 403]);
    responses.forEach(expectSecurityHeaders);
  });

  it('are the same for static assets (public/_headers)', () => {
    const file = readFileSync(join(import.meta.dirname, '..', 'public', '_headers'), 'utf8');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(file).toContain(`\n  ${name}: ${value}\n`);
    }
    expect(file).toContain('\n/*\n');
  });
});
