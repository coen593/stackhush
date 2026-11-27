import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNIN_CODE_ALPHABET } from '../shared/signinCode.ts';
import { MAX_EMAILS_PER_DAY, MAX_EMAILS_PER_HOUR, MAX_FAILED_ATTEMPTS } from './emailSignin.ts';
import { createTestEnv, testWorker as worker } from './testing/env.ts';
import { createTestDatabase } from './testing/fakeD1.ts';
import { TEST_CONFIG } from './testing/fixtures.ts';
import { generateShortCode, generateToken, hashToken } from './tokens.ts';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const REQUEST_PATH = '/api/signin/request';
const VERIFY_PATH = '/api/signin/verify';

interface SentEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

let sqlite: DatabaseSync;
let env: Env;
let sent: SentEmail[];
let emailFails: boolean;

beforeEach(() => {
  const database = createTestDatabase();
  sqlite = database.sqlite;
  sent = [];
  emailFails = false;
  env = {
    ...createTestEnv(database.db),
    ALERT_EMAIL: {
      send: (message: unknown) => {
        const email = message as SentEmail;
        if (emailFails) {
          // A message that echoes the email, as a careless service might.
          const error = new Error(`Could not deliver: ${email.text}`);
          return Promise.reject(Object.assign(error, { code: 'E_DELIVERY_FAILED' }));
        }
        sent.push(email);
        return Promise.resolve({ messageId: 'id' });
      },
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function post(path: string, cookies: string[], body?: string): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cookies.length > 0) headers.set('Cookie', cookies.join('; '));
  return worker.fetch(
    new Request(`https://stackhush.test${path}`, { method: 'POST', headers, body }),
    env,
  );
}

/** What one press of the button gives: the browser's cookie, and the codes from the email. */
interface Issued {
  cookie: string;
  requestId: string;
  /** As emailed: XXXX-XXXX. */
  shortCode: string;
  linkCode: string;
}

function readEmail(email: SentEmail): { shortCode: string; linkCode: string } {
  const shortCode = /^ {4}([A-Z2-9]{4}-[A-Z2-9]{4})$/m.exec(email.text)?.[1];
  const linkCode = /\/signin#code=([0-9a-f]{64})$/m.exec(email.text)?.[1];
  if (shortCode === undefined || linkCode === undefined) throw new Error('No codes in the email');
  return { shortCode, linkCode };
}

async function requestCode(earlierCookie?: string): Promise<Issued> {
  const response = await post(REQUEST_PATH, earlierCookie === undefined ? [] : [earlierCookie]);
  expect(response.status).toBe(204);
  const requestId = /^__Host-signin-request=([0-9a-f]{64});/.exec(
    response.headers.get('Set-Cookie') ?? '',
  )?.[1];
  const email = sent.at(-1);
  if (requestId === undefined || email === undefined) throw new Error('No request was made');
  return { requestId, cookie: `__Host-signin-request=${requestId}`, ...readEmail(email) };
}

function verify(cookie: string | null, code: string): Promise<Response> {
  return post(VERIFY_PATH, cookie === null ? [] : [cookie], JSON.stringify({ code }));
}

function exchangeLink(linkCode: string): Promise<Response> {
  return post('/api/signin', [], JSON.stringify({ code: linkCode }));
}

/** A code of the right shape that is not the issued one. */
function wrongCode(issued: Issued): string {
  for (;;) {
    const code = generateShortCode();
    if (code !== issued.shortCode.replace('-', '')) return code;
  }
}

function sessionFrom(response: Response): string {
  const cookies = response.headers.getSetCookie();
  const sessionId = cookies
    .map((cookie) => /^__Host-session=([0-9a-f]{64});/.exec(cookie)?.[1])
    .find((id) => id !== undefined);
  if (sessionId === undefined) throw new Error('No session cookie');
  return sessionId;
}

async function expectRefused(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.text()).toBe('');
  expect(response.headers.getSetCookie()).toEqual([]);
}

function count(
  table: 'sessions' | 'signin_requests' | 'signin_codes' | 'signin_email_sends' | 'source_health',
) {
  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.count);
}

function failedAttempts(issued: Issued, requestHash: string): number {
  const row = sqlite
    .prepare('SELECT failed_attempts FROM signin_requests WHERE request_hash = ?')
    .get(requestHash);
  if (!row) throw new Error(`No request row for ${issued.cookie.length}-character cookie`);
  return Number(row.failed_attempts);
}

function insertSends(howMany: number, ageMs: number): void {
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  for (let index = 0; index < howMany; index += 1) {
    sqlite
      .prepare('INSERT INTO signin_email_sends (id, created_at) VALUES (?, ?)')
      .run(crypto.randomUUID(), createdAt);
  }
}

describe('the short code', () => {
  it('is 8 characters from the unambiguous alphabet', () => {
    expect(SIGNIN_CODE_ALPHABET).toHaveLength(31);
    expect(SIGNIN_CODE_ALPHABET).not.toMatch(/[01OIL]/);
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const code = generateShortCode();
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
      for (const char of code) seen.add(char);
    }
    // 4000 draws: every character of the alphabet turns up.
    expect(seen.size).toBe(31);
  });
});

describe('asking for a sign-in email', () => {
  it('sends one email to the owner and sets the request cookie', async () => {
    const response = await post(REQUEST_PATH, []);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^__Host-signin-request=[0-9a-f]{64}; /);
    expect(cookies[0]).toContain('Max-Age=900');
    expect(cookies[0]).toContain('Path=/');
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('Secure');
    expect(cookies[0]).toContain('SameSite=Strict');
    expect(cookies[0]).not.toContain('Domain');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(TEST_CONFIG.alertTo);
    expect(sent[0]?.from).toBe(TEST_CONFIG.alertFrom);
    // No session yet: asking is not signing in.
    expect(count('sessions')).toBe(0);
  });

  it('emails the code and the link, and keeps both out of the subject', async () => {
    const issued = await requestCode();
    const email = sent[0];
    if (!email) throw new Error('No email');
    expect(email.subject).toBe('stackhush sign-in code');
    expect(email.subject).not.toContain(issued.shortCode);
    expect(email.subject).not.toContain(issued.shortCode.replace('-', ''));

    expect(email.text).toContain(`\n    ${issued.shortCode}\n`);
    expect(email.text).toContain(`https://status.example.test/signin#code=${issued.linkCode}\n`);
    expect(email.text).toContain('expire in 15 minutes');
    expect(email.text).toContain('If that was not you, ignore this email');
    // The explanation leads, so a preview of the body shows words and not a code.
    expect(email.text.indexOf(issued.shortCode)).toBeGreaterThan(200);

    expect(email.html).toContain(issued.shortCode);
    expect(email.html).toContain(
      `<a href="https://status.example.test/signin#code=${issued.linkCode}">`,
    );
    expect(email.html).toContain('expire in 15 minutes');
    // The request id is for the browser only.
    expect(JSON.stringify(email)).not.toContain(issued.requestId);
  });

  it('stores only hashes of the request id and both codes', async () => {
    const issued = await requestCode();
    const stored = JSON.stringify([
      sqlite.prepare('SELECT * FROM signin_requests').all(),
      sqlite.prepare('SELECT * FROM signin_codes').all(),
      sqlite.prepare('SELECT * FROM signin_email_sends').all(),
    ]);
    expect(stored).not.toContain(issued.requestId);
    expect(stored).not.toContain(issued.shortCode);
    expect(stored).not.toContain(issued.shortCode.replace('-', ''));
    expect(stored).not.toContain(issued.linkCode);
    expect(stored).toContain(await hashToken(issued.requestId));
    expect(stored).toContain(await hashToken(issued.linkCode));
    // Not even the plain hash of the short code, which could be worked back to the code.
    expect(stored).not.toContain(await hashToken(issued.shortCode.replace('-', '')));
    expect(stored).not.toContain(await hashToken(issued.shortCode));
  });

  it('never puts the address or a code in a response', async () => {
    const response = await post(REQUEST_PATH, []);
    const issued = readEmail(sent[0] as SentEmail);
    const visible = JSON.stringify([...response.headers.entries()]) + (await response.text());
    expect(visible).not.toContain(TEST_CONFIG.alertTo);
    expect(visible).not.toContain(issued.shortCode);
    expect(visible).not.toContain(issued.shortCode.replace('-', ''));
    expect(visible).not.toContain(issued.linkCode);
  });
});

describe('the email caps', () => {
  it('stops at the hourly cap: no email, no cookie, no request', async () => {
    for (let index = 0; index < MAX_EMAILS_PER_HOUR; index += 1) await requestCode();
    expect(sent).toHaveLength(MAX_EMAILS_PER_HOUR);

    await expectRefused(await post(REQUEST_PATH, []), 429);
    await expectRefused(await post(REQUEST_PATH, []), 429);
    expect(sent).toHaveLength(MAX_EMAILS_PER_HOUR);
    expect(count('signin_requests')).toBe(MAX_EMAILS_PER_HOUR);
    expect(count('signin_codes')).toBe(MAX_EMAILS_PER_HOUR);
    expect(count('signin_email_sends')).toBe(MAX_EMAILS_PER_HOUR);
  });

  it('holds when the button is pressed many times at once', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => post(REQUEST_PATH, [])));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 204)).toHaveLength(MAX_EMAILS_PER_HOUR);
    expect(statuses.filter((status) => status === 429)).toHaveLength(12 - MAX_EMAILS_PER_HOUR);
    expect(sent).toHaveLength(MAX_EMAILS_PER_HOUR);
  });

  it('counts the hour as the last 60 minutes', async () => {
    insertSends(MAX_EMAILS_PER_HOUR - 1, 59 * MINUTE_MS);
    insertSends(3, 61 * MINUTE_MS);
    await requestCode();
    await expectRefused(await post(REQUEST_PATH, []), 429);
    expect(sent).toHaveLength(1);
  });

  it('stops at the daily cap even when the last hour was quiet', async () => {
    insertSends(MAX_EMAILS_PER_DAY, 2 * HOUR_MS);
    await expectRefused(await post(REQUEST_PATH, []), 429);
    expect(sent).toHaveLength(0);
  });

  it('counts the day as the last 24 hours', async () => {
    insertSends(MAX_EMAILS_PER_DAY - 1, 23 * HOUR_MS);
    insertSends(10, 25 * HOUR_MS);
    await requestCode();
    await expectRefused(await post(REQUEST_PATH, []), 429);
    expect(sent).toHaveLength(1);
  });

  it('leaves the terminal sign-in link working while capped', async () => {
    insertSends(MAX_EMAILS_PER_DAY, 2 * HOUR_MS);
    const code = generateToken();
    sqlite
      .prepare('INSERT INTO signin_codes (code_hash, expires_at) VALUES (?, ?)')
      .run(await hashToken(code), new Date(Date.now() + 15 * MINUTE_MS).toISOString());
    expect((await exchangeLink(code)).status).toBe(204);
  });
});

describe('when the email cannot be sent', () => {
  it('answers with a bare error, makes no session and leaves no usable request', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    emailFails = true;
    await expectRefused(await post(REQUEST_PATH, []), 503);
    expect(count('sessions')).toBe(0);
    expect(count('signin_requests')).toBe(0);
    expect(count('signin_codes')).toBe(0);
    // The log names the error code and nothing from the message, which held the codes.
    expect(logged.mock.calls).toEqual([['Sign-in email failed (E_DELIVERY_FAILED)']]);
  });

  it('still counts towards the cap', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    emailFails = true;
    for (let index = 0; index < MAX_EMAILS_PER_HOUR; index += 1) {
      await expectRefused(await post(REQUEST_PATH, []), 503);
    }
    emailFails = false;
    await expectRefused(await post(REQUEST_PATH, []), 429);
    expect(sent).toHaveLength(0);
  });

  it('leaves an earlier request of the same browser as it was', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const earlier = await requestCode();
    emailFails = true;
    await expectRefused(await post(REQUEST_PATH, [earlier.cookie]), 503);
    expect((await verify(earlier.cookie, earlier.shortCode)).status).toBe(204);
  });
});

describe('typing the code', () => {
  it('gives a working session and clears the request cookie', async () => {
    const issued = await requestCode();
    const response = await verify(issued.cookie, issued.shortCode);
    expect(response.status).toBe(204);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^__Host-session=[0-9a-f]{64}; /);
    expect(cookies[0]).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(cookies[0]).toContain(`Max-Age=${180 * 24 * 60 * 60}`);
    expect(cookies[1]).toBe(
      '__Host-signin-request=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict',
    );

    const status = await worker.fetch(
      new Request('https://stackhush.test/api/status', {
        headers: { Cookie: `__Host-session=${sessionFrom(response)}` },
      }),
      env,
    );
    expect(status.status).toBe(200);
  });

  it('accepts lower case, no dash, and stray spaces', async () => {
    for (const retype of [
      (code: string) => code.toLowerCase(),
      (code: string) => code.replace('-', ''),
      (code: string) => code.replace('-', '').toLowerCase(),
      (code: string) => ` ${code.replace('-', ' ')} `,
    ]) {
      const issued = await requestCode();
      sqlite.exec('DELETE FROM signin_email_sends');
      expect((await verify(issued.cookie, retype(issued.shortCode))).status).toBe(204);
    }
  });

  it('refuses a wrong code, counts it, and still takes the right one afterwards', async () => {
    const issued = await requestCode();
    const requestHash = await hashToken(issued.requestId);
    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expectRefused(await verify(issued.cookie, wrongCode(issued)), 401);
      expect(failedAttempts(issued, requestHash)).toBe(attempt);
    }
    expect(count('sessions')).toBe(0);
    expect((await verify(issued.cookie, issued.shortCode)).status).toBe(204);
  });

  it('closes the request at the fifth wrong code, also for the right code and the cap holds', async () => {
    const issued = await requestCode();
    const requestHash = await hashToken(issued.requestId);
    for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expectRefused(await verify(issued.cookie, wrongCode(issued)), 401);
    }
    await expectRefused(await verify(issued.cookie, wrongCode(issued)), 429);
    await expectRefused(await verify(issued.cookie, issued.shortCode), 429);
    await expectRefused(await verify(issued.cookie, wrongCode(issued)), 429);
    expect(failedAttempts(issued, requestHash)).toBe(MAX_FAILED_ATTEMPTS);
    expect(count('sessions')).toBe(0);
  });

  it('counts wrong codes sent at once, and never lets more than the cap through', async () => {
    const issued = await requestCode();
    const guesses = Array.from({ length: 12 }, () => verify(issued.cookie, wrongCode(issued)));
    const statuses = (await Promise.all(guesses)).map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(MAX_FAILED_ATTEMPTS - 1);
    expect(statuses.filter((status) => status === 429)).toHaveLength(13 - MAX_FAILED_ATTEMPTS);
    await expectRefused(await verify(issued.cookie, issued.shortCode), 429);
  });

  it('does not count something that cannot be a code', async () => {
    const issued = await requestCode();
    const requestHash = await hashToken(issued.requestId);
    const bare = issued.shortCode.replace('-', '');
    for (const typed of [
      '',
      'ABC',
      `${bare}A`,
      `${bare.slice(0, 7)}0`,
      'ABCD_EFGH',
      'x'.repeat(64),
    ]) {
      await expectRefused(await verify(issued.cookie, typed), 401);
    }
    for (const body of [
      '',
      'not json',
      'null',
      '{}',
      '{"code":42}',
      `{"code":"${'A'.repeat(300)}"}`,
    ]) {
      await expectRefused(await post(VERIFY_PATH, [issued.cookie], body), 401);
    }
    expect(failedAttempts(issued, requestHash)).toBe(0);
    expect((await verify(issued.cookie, issued.shortCode)).status).toBe(204);
  });

  it('refuses the right code from a browser that did not ask', async () => {
    const issued = await requestCode();
    await expectRefused(await verify(null, issued.shortCode), 410);
    await expectRefused(
      await verify(`__Host-signin-request=${generateToken()}`, issued.shortCode),
      410,
    );
    await expectRefused(await verify('__Host-signin-request=not-a-request', issued.shortCode), 410);
    // A session cookie is not a request cookie.
    await expectRefused(await verify(`__Host-session=${issued.requestId}`, issued.shortCode), 410);
    expect(count('sessions')).toBe(0);
  });

  it('refuses the code of one request with the cookie of another, at the cost of a try', async () => {
    const owner = await requestCode();
    const other = await requestCode();
    await expectRefused(await verify(other.cookie, owner.shortCode), 401);
    expect(failedAttempts(other, await hashToken(other.requestId))).toBe(1);
    // The owner's request is untouched.
    expect(failedAttempts(owner, await hashToken(owner.requestId))).toBe(0);
    expect((await verify(owner.cookie, owner.shortCode)).status).toBe(204);
  });

  it('refuses the request id, the link code or a hash in place of the short code', async () => {
    const issued = await requestCode();
    for (const typed of [issued.requestId, issued.linkCode, await hashToken(issued.shortCode)]) {
      await expectRefused(await verify(issued.cookie, typed), 401);
    }
    expect(count('sessions')).toBe(0);
  });

  it('works once: a replay gets nothing', async () => {
    const issued = await requestCode();
    expect((await verify(issued.cookie, issued.shortCode)).status).toBe(204);
    await expectRefused(await verify(issued.cookie, issued.shortCode), 410);
    await expectRefused(await verify(issued.cookie, wrongCode(issued)), 410);
    expect(count('sessions')).toBe(1);
  });

  it('gives one session when the right code is sent several times at once', async () => {
    const issued = await requestCode();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => verify(issued.cookie, issued.shortCode)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([204, 410, 410, 410, 410]);
    expect(count('sessions')).toBe(1);
  });

  it('refuses the code and the cookie of an expired request', async () => {
    const issued = await requestCode();
    const past = new Date(Date.now() - 1).toISOString();
    sqlite.prepare('UPDATE signin_requests SET expires_at = ?').run(past);
    sqlite.prepare('UPDATE signin_codes SET expires_at = ?').run(past);
    await expectRefused(await verify(issued.cookie, issued.shortCode), 410);
    await expectRefused(await exchangeLink(issued.linkCode), 401);
    expect(count('sessions')).toBe(0);
  });

  it('is refused for requests from other sites, like every POST', async () => {
    const issued = await requestCode();
    const body = JSON.stringify({ code: issued.shortCode });
    const attempts: Record<string, string>[] = [
      { Cookie: issued.cookie },
      { Cookie: issued.cookie, 'Content-Type': 'text/plain' },
      { Cookie: issued.cookie, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      { Cookie: issued.cookie, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' },
    ];
    for (const headers of attempts) {
      const request = new Request(`https://stackhush.test${VERIFY_PATH}`, {
        method: 'POST',
        headers,
        body,
      });
      await expectRefused(await worker.fetch(request, env), 403);
    }
    expect(count('sessions')).toBe(0);
    expect((await verify(issued.cookie, issued.shortCode)).status).toBe(204);
  });
});

describe('the two codes of one email', () => {
  it('signs in through the link, with the existing exchange', async () => {
    const issued = await requestCode();
    const response = await exchangeLink(issued.linkCode);
    expect(response.status).toBe(204);
    expect(response.headers.get('Set-Cookie')).toMatch(/^__Host-session=[0-9a-f]{64}; /);
  });

  it('kills the link when the typed code was used', async () => {
    const issued = await requestCode();
    expect((await verify(issued.cookie, issued.shortCode)).status).toBe(204);
    await expectRefused(await exchangeLink(issued.linkCode), 401);
    expect(count('sessions')).toBe(1);
  });

  it('kills the typed code when the link was used', async () => {
    const issued = await requestCode();
    expect((await exchangeLink(issued.linkCode)).status).toBe(204);
    await expectRefused(await verify(issued.cookie, issued.shortCode), 410);
    await expectRefused(await exchangeLink(issued.linkCode), 401);
    expect(count('sessions')).toBe(1);
  });

  it('gives one session when both are used at once', async () => {
    const issued = await requestCode();
    const responses = await Promise.all([
      verify(issued.cookie, issued.shortCode),
      exchangeLink(issued.linkCode),
    ]);
    expect(responses.filter((response) => response.status === 204)).toHaveLength(1);
    expect(count('sessions')).toBe(1);
  });

  it('keeps the link alive when the typed code ran out of tries', async () => {
    const issued = await requestCode();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await verify(issued.cookie, wrongCode(issued));
    }
    await expectRefused(await verify(issued.cookie, issued.shortCode), 429);
    // The link code is 256 bits; wrong short codes say nothing about it.
    expect((await exchangeLink(issued.linkCode)).status).toBe(204);
  });

  it('leaves other requests alone', async () => {
    const first = await requestCode();
    const second = await requestCode();
    expect((await verify(first.cookie, first.shortCode)).status).toBe(204);
    expect((await exchangeLink(second.linkCode)).status).toBe(204);
    expect(count('sessions')).toBe(2);
  });
});

describe('sending a new code', () => {
  it('voids the earlier request of the same browser: its typed code and its link', async () => {
    const earlier = await requestCode();
    const fresh = await requestCode(earlier.cookie);
    expect(fresh.requestId).not.toBe(earlier.requestId);

    await expectRefused(await exchangeLink(earlier.linkCode), 401);
    await expectRefused(await verify(earlier.cookie, earlier.shortCode), 410);
    expect(count('sessions')).toBe(0);
    expect((await verify(fresh.cookie, fresh.shortCode)).status).toBe(204);
    await expectRefused(await exchangeLink(earlier.linkCode), 401);
    expect(count('sessions')).toBe(1);
  });

  it('leaves the requests of other browsers alone', async () => {
    const mine = await requestCode();
    const other = await requestCode();
    await requestCode(mine.cookie);
    expect((await exchangeLink(other.linkCode)).status).toBe(204);
  });

  it('keeps the earlier code and link working when the cap stops the new email', async () => {
    const earlier = await requestCode();
    insertSends(MAX_EMAILS_PER_HOUR, MINUTE_MS);
    await expectRefused(await post(REQUEST_PATH, [earlier.cookie]), 429);
    expect((await exchangeLink(earlier.linkCode)).status).toBe(204);
  });

  it('voids nothing for a cookie that is malformed, unknown or already used', async () => {
    const used = await requestCode();
    expect((await verify(used.cookie, used.shortCode)).status).toBe(204);
    const bystander = await requestCode();
    for (const cookie of [
      '__Host-signin-request=not-a-request',
      `__Host-signin-request=${generateToken()}`,
      used.cookie,
    ]) {
      sqlite.exec('DELETE FROM signin_email_sends');
      await requestCode(cookie);
    }
    expect((await verify(bystander.cookie, bystander.shortCode)).status).toBe(204);
  });
});

describe('logs', () => {
  it('stay empty through asking, wrong codes, signing in and replays', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    const issued = await requestCode();
    await verify(issued.cookie, wrongCode(issued));
    await verify(issued.cookie, issued.shortCode);
    await verify(issued.cookie, issued.shortCode);
    await exchangeLink(issued.linkCode);
    for (const spy of spies) expect(spy.mock.calls).toEqual([]);
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

  async function runCron(): Promise<void> {
    const controller = { scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry() {} };
    await worker.scheduled(controller, env);
  }

  function remainingRequests(): string[] {
    return sqlite
      .prepare('SELECT request_hash FROM signin_requests ORDER BY request_hash')
      .all()
      .map((row) => String(row.request_hash));
  }

  it('deletes expired and used requests and keeps open ones, tried or not', async () => {
    const expired = await requestCode();
    const usedByCode = await requestCode();
    const usedByLink = await requestCode();
    const open = await requestCode();
    const openWithTries = await requestCode();
    sqlite.exec('DELETE FROM signin_email_sends');
    const spent = await requestCode();

    sqlite
      .prepare('UPDATE signin_requests SET expires_at = ? WHERE request_hash = ?')
      .run(new Date(Date.now() - 1).toISOString(), await hashToken(expired.requestId));
    await verify(usedByCode.cookie, usedByCode.shortCode);
    await exchangeLink(usedByLink.linkCode);
    await verify(openWithTries.cookie, wrongCode(openWithTries));
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await verify(spent.cookie, wrongCode(spent));
    }

    await runCron();

    // A request out of tries is not expired: its link still works until the 15 minutes pass.
    const kept = [open, openWithTries, spent].map((issued) => hashToken(issued.requestId));
    expect(remainingRequests()).toEqual((await Promise.all(kept)).sort());
    expect((await verify(open.cookie, open.shortCode)).status).toBe(204);
    expect((await verify(openWithTries.cookie, openWithTries.shortCode)).status).toBe(204);
    expect((await exchangeLink(spent.linkCode)).status).toBe(204);
  });

  it('deletes email counts older than a day and keeps the ones the caps still need', async () => {
    insertSends(4, 25 * HOUR_MS);
    insertSends(MAX_EMAILS_PER_DAY - 1, 23 * HOUR_MS);
    insertSends(1, 5 * MINUTE_MS);

    await runCron();

    expect(count('signin_email_sends')).toBe(MAX_EMAILS_PER_DAY);
    // The cap that the kept rows add up to is still enforced after the cleanup.
    await expectRefused(await post(REQUEST_PATH, []), 429);
  });

  it('still runs the checks when migration 0002 is missing, and says so in the log', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The Worker deployed before its migration: the new tables do not exist.
    sqlite.exec('DROP TABLE signin_requests; DROP TABLE signin_email_sends;');
    const expiredCode = generateToken();
    sqlite
      .prepare('INSERT INTO signin_codes (code_hash, expires_at) VALUES (?, ?)')
      .run(await hashToken(expiredCode), new Date(Date.now() - 1).toISOString());

    await runCron();

    // The run started, recorded what the sources said, and finished.
    const run = sqlite.prepare('SELECT last_run_finished_at FROM run_state').get();
    expect(run?.last_run_finished_at).not.toBeNull();
    expect(count('source_health')).toBeGreaterThan(0);
    // The cleanup that does not need the new tables still happened.
    expect(count('signin_codes')).toBe(0);
    // Node's SQLite gives this code; D1 errors carry none and log as (unknown).
    expect(logged.mock.calls).toContainEqual([
      'Cleanup of sign-in requests failed (ERR_SQLITE_ERROR)',
    ]);
    for (const call of logged.mock.calls) expect(String(call[0])).not.toContain('signin_requests');
  });

  it('still runs the checks when every cleanup fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sqlite.exec('DROP TABLE signin_requests; DROP TABLE signin_email_sends; DROP TABLE sessions;');
    await runCron();
    const run = sqlite.prepare('SELECT last_run_finished_at FROM run_state').get();
    expect(run?.last_run_finished_at).not.toBeNull();
    expect(logged.mock.calls).toContainEqual([
      'Cleanup of codes and sessions failed (ERR_SQLITE_ERROR)',
    ]);
  });

  it('leaves sessions made by email sign-in alone', async () => {
    const issued = await requestCode();
    const response = await verify(issued.cookie, issued.shortCode);
    await runCron();
    expect(count('sessions')).toBe(1);
    const status = await worker.fetch(
      new Request('https://stackhush.test/api/status', {
        headers: { Cookie: `__Host-session=${sessionFrom(response)}` },
      }),
      env,
    );
    expect(status.status).toBe(200);
  });
});
