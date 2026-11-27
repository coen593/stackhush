// The API router. Kept out of worker/index.ts because the Worker entry module may only export
// handlers: the runtime treats every named export there as an entrypoint.

import type { Config } from './config.ts';
import {
  clearedSessionCookie,
  exchangeCode,
  findSession,
  revokeSession,
  sessionCookie,
} from './access.ts';
import {
  clearedRequestCookie,
  requestCookie,
  requestSigninEmail,
  verifySigninCode,
} from './emailSignin.ts';
import { emptyResponse, jsonResponse } from './responses.ts';
import { readSecrets } from './secrets.ts';
import { loadStatus } from './status.ts';

interface RequestContext {
  db: D1Database;
  env: Env;
  config: Config;
  /** Stored hash of the caller's session; every route in protectedRoutes has one. */
  sessionHash: string;
}

export interface ApiRoute {
  method: 'GET' | 'POST';
  path: string;
  handle: (context: RequestContext) => Promise<Response>;
}

interface SessionFreeContext {
  request: Request;
  env: Env;
  config: Config;
  now: Date;
}

export interface SessionFreeRoute {
  // Only POST, so the own-page check in handleRequest covers every one of them.
  method: 'POST';
  path: string;
  handle: (context: SessionFreeContext) => Promise<Response>;
}

export const SIGNIN_PATH = '/api/signin';

// A sign-in body is one code of at most 64 characters; anything much longer is not worth reading.
const MAX_SIGNIN_BODY_BYTES = 200;

// The complete list of routes that work without a session: the ways a session is made.
// worker/access.test.ts pins this list, so adding to it is a deliberate, visible change.
export const sessionFreeRoutes: readonly SessionFreeRoute[] = [
  // Swaps a long code (a `npm run signin-link` link, or the link in a sign-in email).
  { method: 'POST', path: SIGNIN_PATH, handle: signIn },
  // "Email me a sign-in code".
  { method: 'POST', path: '/api/signin/request', handle: requestEmail },
  // Swaps the short code typed from that email.
  { method: 'POST', path: '/api/signin/verify', handle: verifyTypedCode },
];

// Every other API route. Add new routes here: they are then behind the session check, and
// worker/access.test.ts checks each of them without a session.
export const protectedRoutes: readonly ApiRoute[] = [
  {
    method: 'GET',
    path: '/api/status',
    handle: async ({ db, env, config }) =>
      jsonResponse(await loadStatus(db, config, readSecrets(env, config)), 200),
  },
  {
    method: 'POST',
    path: '/api/signout',
    handle: async ({ db, sessionHash }) => {
      await revokeSession(db, sessionHash);
      return emptyResponse(204, clearedSessionCookie());
    },
  },
];

export async function handleRequest(
  request: Request,
  env: Env,
  now: Date,
  config: Config,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const db = env.DB;

  // Before anything else, for every POST (sign-in, sign-out and whatever is added later).
  if (request.method === 'POST' && !isOwnPagePost(request)) return emptyResponse(403);

  const sessionFree = sessionFreeRoutes.find(
    (candidate) => candidate.method === request.method && candidate.path === pathname,
  );
  if (sessionFree) return sessionFree.handle({ request, env, config, now });

  // The single guard: nothing below runs without a valid session, not even the 404.
  const sessionHash = await findSession(db, request, now);
  if (sessionHash === null) return emptyResponse(401);

  const route = protectedRoutes.find(
    (candidate) => candidate.method === request.method && candidate.path === pathname,
  );
  if (!route) return emptyResponse(404);
  return route.handle({ db, env, config, sessionHash });
}

async function signIn({ request, env, now }: SessionFreeContext): Promise<Response> {
  const code = await readSigninCode(request);
  if (code === null) return emptyResponse(401);
  const sessionId = await exchangeCode(env.DB, code, now);
  if (sessionId === null) return emptyResponse(401);
  return emptyResponse(204, sessionCookie(sessionId));
}

/**
 * 204 with the request cookie when the email was sent. 429 when the email cap is reached and
 * 503 when sending failed; the page says "try again later" for both, and no response ever
 * names the address.
 */
async function requestEmail({ request, env, config, now }: SessionFreeContext): Promise<Response> {
  const outcome = await requestSigninEmail(env, config, request, now);
  if (outcome.kind === 'capped') return emptyResponse(429);
  if (outcome.kind === 'send-failed') return emptyResponse(503);
  return emptyResponse(204, requestCookie(outcome.requestId));
}

/**
 * 204 with the session cookie; 401 for a wrong code that may be tried again; 429 when the
 * request has had too many wrong codes; 410 when this browser has no open request.
 */
async function verifyTypedCode({ request, env, now }: SessionFreeContext): Promise<Response> {
  const code = await readSigninCode(request);
  if (code === null) return emptyResponse(401);
  const outcome = await verifySigninCode(env.DB, request, code, now);
  if (outcome.kind === 'wrong-code') return emptyResponse(401);
  if (outcome.kind === 'too-many-attempts') return emptyResponse(429);
  if (outcome.kind === 'closed') return emptyResponse(410);
  return emptyResponse(204, sessionCookie(outcome.sessionId), clearedRequestCookie());
}

/**
 * Whether a POST comes from the dashboard's own page. Another site cannot make a browser send
 * Content-Type: application/json without a CORS preflight, which this API never answers, and
 * browsers say where a request comes from in Sec-Fetch-Site. Without these a hostile page could
 * sign the owner out, or sign their browser in with a code of its own.
 */
function isOwnPagePost(request: Request): boolean {
  const contentType = request.headers.get('Content-Type') ?? '';
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') return false;
  // Absent for clients that are not browsers, which cannot be tricked into sending a cookie.
  const site = request.headers.get('Sec-Fetch-Site');
  return site === null || site === 'same-origin';
}

/** Expects JSON {"code": "..."}; returns null for anything else. */
async function readSigninCode(request: Request): Promise<string | null> {
  const text = await readBody(request, MAX_SIGNIN_BODY_BYTES);
  if (text === null) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || !('code' in body)) return null;
  return typeof body.code === 'string' ? body.code : null;
}

/**
 * Reads a request body of at most maxBytes; null when it is longer. A declared Content-Length
 * over the limit is refused without reading, and a body without one (or with a false one) is
 * dropped as soon as it passes the limit.
 */
async function readBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && !(Number(declared) <= maxBytes)) return null;
  if (request.body === null) return '';

  const reader: ReadableStreamDefaultReader<unknown> = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) return null;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks).text();
}
