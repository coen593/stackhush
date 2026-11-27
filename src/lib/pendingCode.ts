// Remembers that a sign-in code was asked for, so the code field is still there after the page
// reloads. On an iPhone, a home-screen app often reloads when coming back from the mail app.
// Only the time is stored: the code is in the email and the request id in an HttpOnly cookie.

const STORAGE_KEY = 'stackhush.codeRequestedAt';
// The same 15 minutes the server gives a code.
const CODE_LIFETIME_MS = 15 * 60 * 1000;

/** Whether a code asked for from this browser can still be waiting in the inbox. */
export function hasPendingCode(storage: Storage, now: number): boolean {
  const requestedAt = Number(storage.getItem(STORAGE_KEY));
  return requestedAt > 0 && now >= requestedAt && now - requestedAt < CODE_LIFETIME_MS;
}

export function rememberPendingCode(storage: Storage, now: number): void {
  storage.setItem(STORAGE_KEY, String(now));
}

export function forgetPendingCode(storage: Storage): void {
  storage.removeItem(STORAGE_KEY);
}
