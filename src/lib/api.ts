import type { SigninRequest, StatusResponse } from '../../shared/api.ts';

const REQUEST_TIMEOUT_MS = 10_000;
const SIGNIN_PATH = '/signin';
const CODE_PREFIX = '#code=';

export type StatusResult = { kind: 'signed-in'; status: StatusResponse } | { kind: 'signed-out' };

/**
 * Takes the code out of a sign-in link (/signin#code=...) and replaces the address with /, so
 * the code leaves the address bar and history before anything else happens.
 */
export function takeSigninCode(): string | null {
  if (window.location.pathname !== SIGNIN_PATH) return null;
  const { hash } = window.location;
  window.history.replaceState(null, '', '/');
  return hash.startsWith(CODE_PREFIX) ? hash.slice(CODE_PREFIX.length) : null;
}

/** What happened to a sign-in link in the address bar, if there was one. */
export type SigninOutcome = 'none' | 'signed-in' | 'rejected' | 'unreachable';

/**
 * Swaps the code for a session cookie. 'rejected' only when the server said so (the code is
 * wrong, used or expired); a network error, a timeout or any other answer is 'unreachable',
 * because then the link itself may be fine.
 */
export async function signIn(code: string): Promise<Exclude<SigninOutcome, 'none'>> {
  const body: SigninRequest = { code };
  let response: Response;
  try {
    response = await fetch('/api/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    console.error('Sign-in request failed', error);
    return 'unreachable';
  }
  if (response.ok) return 'signed-in';
  if (response.status === 401) return 'rejected';
  console.error(`Sign-in failed with HTTP ${response.status}`);
  return 'unreachable';
}

export type CodeRequestOutcome = 'sent' | 'try-later' | 'unreachable';

/**
 * Asks the server to email a sign-in code. 'try-later' when the server said no email goes out
 * now (too many were asked for, or sending failed); anything else that is not success is
 * 'unreachable'.
 */
export async function requestSigninCode(): Promise<CodeRequestOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/signin/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    console.error('Asking for a sign-in code failed', error);
    return 'unreachable';
  }
  if (response.ok) return 'sent';
  if (response.status === 429 || response.status === 503) return 'try-later';
  console.error(`Asking for a sign-in code failed with HTTP ${response.status}`);
  return 'unreachable';
}

export type CodeVerifyOutcome =
  | 'signed-in'
  | 'wrong-code'
  | 'too-many-attempts'
  /** This browser has no code waiting: it expired, was used, or was asked for elsewhere. */
  | 'closed'
  | 'unreachable';

/** Swaps the typed code for a session cookie. The code is never logged. */
export async function verifySigninCode(code: string): Promise<CodeVerifyOutcome> {
  const body: SigninRequest = { code };
  let response: Response;
  try {
    response = await fetch('/api/signin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    console.error('Checking the sign-in code failed', error);
    return 'unreachable';
  }
  if (response.ok) return 'signed-in';
  if (response.status === 401) return 'wrong-code';
  if (response.status === 429) return 'too-many-attempts';
  if (response.status === 410) return 'closed';
  console.error(`Checking the sign-in code failed with HTTP ${response.status}`);
  return 'unreachable';
}

export async function fetchStatus(): Promise<StatusResult> {
  const response = await fetch('/api/status', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status === 401) return { kind: 'signed-out' };
  if (!response.ok) throw new Error(`Loading status failed with HTTP ${response.status}`);
  return { kind: 'signed-in', status: (await response.json()) as StatusResponse };
}

export async function signOut(): Promise<void> {
  const response = await fetch('/api/signout', {
    method: 'POST',
    // No body, but the API only accepts JSON posts (it is how it tells its own page apart).
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // 401 means the session was already gone, which is what signing out wants.
  if (!response.ok && response.status !== 401) {
    throw new Error(`Sign-out failed with HTTP ${response.status}`);
  }
}
