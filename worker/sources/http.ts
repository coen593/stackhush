// Shared by the sources that call an API. Every call has a timeout, and every failure becomes a
// SourceError with a short safe message: never a header, token or response body.

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const REQUEST_TIMEOUT_MS = 10_000;

export class SourceError extends Error {}

/**
 * Fetches a URL and returns the parsed JSON body. Throws SourceError on any failure.
 * Every caller sends a token, so redirects are not followed: following one could hand the token
 * to another host. With 'manual' the 3xx answer comes back as it is and fails as 'HTTP 30x'.
 * (Not 'error': the Workers runtime only accepts 'follow' and 'manual'.)
 */
export async function fetchJson(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new SourceError('timed out');
    }
    throw new SourceError('network error');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SourceError(`HTTP ${response.status}`);
  }
  try {
    const body: unknown = await response.json();
    return body;
  } catch {
    throw new SourceError('invalid response');
  }
}

/** Turns anything thrown by a source into the safe text stored in source_health. */
export function safeErrorMessage(error: unknown): string {
  return error instanceof SourceError ? error.message : 'unexpected error';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a field the API contract promises; a missing or mistyped one is an invalid response. */
export function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new SourceError('invalid response');
  return value;
}

export function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') throw new SourceError('invalid response');
  return value;
}

export function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new SourceError('invalid response');
  return value as unknown[];
}

export function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new SourceError('invalid response');
  return value;
}
