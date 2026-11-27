// Every API response is built here, so each one carries the security headers and no-store.
// Static assets get the same headers from public/_headers; a test keeps the two in sync.

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
};

function baseHeaders(): Headers {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Cache-Control', 'no-store');
  return headers;
}

export function jsonResponse(body: unknown, status: number): Response {
  const headers = baseHeaders();
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
}

/** A response with no body. Used for every refusal, so a 401 says nothing about why. */
export function emptyResponse(status: number, ...setCookies: string[]): Response {
  const headers = baseHeaders();
  for (const cookie of setCookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status, headers });
}
