// Random secrets (sign-in codes, session ids) and their stored form. Uses only Web Crypto, so
// both the Worker and scripts/signin-link.ts (Node) import it.

import { SIGNIN_CODE_ALPHABET, SIGNIN_CODE_LENGTH } from '../shared/signinCode.ts';

const TOKEN_BYTES = 32;

/** A token is 32 random bytes as lowercase hex: 256 bits, far past guessing. */
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export const SIGNIN_CODE_LIFETIME_MS = 15 * 60 * 1000;

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return toHex(bytes);
}

/**
 * The short code that is emailed and typed in: 8 characters from a 31-character alphabet, about
 * 40 bits. That is only safe together with the limits in worker/emailSignin.ts.
 */
export function generateShortCode(): string {
  // A byte is only used when it is below the largest multiple of the alphabet size, so every
  // character is equally likely (a plain modulo would favour the first few).
  const limit = 256 - (256 % SIGNIN_CODE_ALPHABET.length);
  let code = '';
  while (code.length < SIGNIN_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SIGNIN_CODE_LENGTH))) {
      if (byte >= limit || code.length === SIGNIN_CODE_LENGTH) continue;
      code += SIGNIN_CODE_ALPHABET[byte % SIGNIN_CODE_ALPHABET.length];
    }
  }
  return code;
}

/**
 * Tokens are stored only as their SHA-256, and looked up by it. A database read therefore never
 * yields a working code or cookie, and no secret is compared in JavaScript: the lookup compares
 * hashes of attacker input, which leaks nothing about the stored token through timing.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
