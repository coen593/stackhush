// The short sign-in code that is emailed and typed in. Shared so the page can tidy up and check
// what was typed with the same rules the Worker applies. Nothing private lives here.

/** Letters and digits that cannot be mistaken for each other: no 0/O and no 1/I/L. */
export const SIGNIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SIGNIN_CODE_LENGTH = 8;

/** Shown as XXXX-XXXX. */
export function formatSigninCode(code: string): string {
  const half = SIGNIN_CODE_LENGTH / 2;
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/**
 * Turns what was typed into the code as issued: upper case, without dashes or spaces. Returns
 * null when that is not eight characters from the alphabet, so it cannot be a code at all.
 */
export function normalizeSigninCode(typed: string): string | null {
  const code = typed.replaceAll(/[\s-]/g, '').toUpperCase();
  if (code.length !== SIGNIN_CODE_LENGTH) return null;
  for (const char of code) {
    if (!SIGNIN_CODE_ALPHABET.includes(char)) return null;
  }
  return code;
}
