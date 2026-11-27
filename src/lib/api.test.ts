import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestSigninCode, signIn, signOut, verifySigninCode } from './api.ts';

const CODE = 'a'.repeat(64);

function stubFetch(answer: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answer();
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('signIn', () => {
  it('is signed in on success', async () => {
    const calls = stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    expect(await signIn(CODE)).toBe('signed-in');
    expect(calls[0]?.url).toBe('/api/signin');
    expect(new Headers(calls[0]?.init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('calls the link rejected only when the server said so', async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 401 })));
    expect(await signIn(CODE)).toBe('rejected');
  });

  it('says the server could not be reached on a network error, a 5xx or a refusal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await signIn(CODE)).toBe('unreachable');
    stubFetch(() => Promise.resolve(new Response(null, { status: 500 })));
    expect(await signIn(CODE)).toBe('unreachable');
    stubFetch(() => Promise.resolve(new Response(null, { status: 403 })));
    expect(await signIn(CODE)).toBe('unreachable');
  });

  it('never logs the code', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await signIn(CODE);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(CODE);
  });
});

describe('signOut', () => {
  it('posts as JSON, which the API requires of its own page', async () => {
    const calls = stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    await signOut();
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('Content-Type')).toBe('application/json');
  });
});

describe('requestSigninCode', () => {
  it('posts as JSON without a body and reports the email as sent', async () => {
    const calls = stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    expect(await requestSigninCode()).toBe('sent');
    expect(calls[0]?.url).toBe('/api/signin/request');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('says try later when the cap is reached or sending failed', async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 429 })));
    expect(await requestSigninCode()).toBe('try-later');
    stubFetch(() => Promise.resolve(new Response(null, { status: 503 })));
    expect(await requestSigninCode()).toBe('try-later');
  });

  it('says the server could not be reached on a network error or any other answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await requestSigninCode()).toBe('unreachable');
    stubFetch(() => Promise.resolve(new Response(null, { status: 500 })));
    expect(await requestSigninCode()).toBe('unreachable');
    stubFetch(() => Promise.resolve(new Response(null, { status: 403 })));
    expect(await requestSigninCode()).toBe('unreachable');
  });
});

describe('verifySigninCode', () => {
  const SHORT_CODE = 'ABCDEFGH';

  it('posts the code as JSON', async () => {
    const calls = stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    expect(await verifySigninCode(SHORT_CODE)).toBe('signed-in');
    expect(calls[0]?.url).toBe('/api/signin/verify');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ code: SHORT_CODE }));
    expect(new Headers(calls[0]?.init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('tells a wrong code, too many tries and a closed request apart', async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 401 })));
    expect(await verifySigninCode(SHORT_CODE)).toBe('wrong-code');
    stubFetch(() => Promise.resolve(new Response(null, { status: 429 })));
    expect(await verifySigninCode(SHORT_CODE)).toBe('too-many-attempts');
    stubFetch(() => Promise.resolve(new Response(null, { status: 410 })));
    expect(await verifySigninCode(SHORT_CODE)).toBe('closed');
  });

  it('never calls a server problem a wrong code, and never logs the code', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await verifySigninCode(SHORT_CODE)).toBe('unreachable');
    stubFetch(() => Promise.resolve(new Response(null, { status: 500 })));
    expect(await verifySigninCode(SHORT_CODE)).toBe('unreachable');
    stubFetch(() => Promise.resolve(new Response(null, { status: 403 })));
    expect(await verifySigninCode(SHORT_CODE)).toBe('unreachable');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SHORT_CODE);
  });
});
