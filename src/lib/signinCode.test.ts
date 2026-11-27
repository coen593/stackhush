import { describe, expect, it } from 'vitest';
import { formatSigninCode, normalizeSigninCode } from '../../shared/signinCode.ts';

describe('normalizeSigninCode', () => {
  it('accepts the code as emailed, in lower case, and with or without the dash', () => {
    for (const typed of ['ABCD-2345', 'abcd-2345', 'ABCD2345', 'abcd2345', ' abcd 2345 ']) {
      expect(normalizeSigninCode(typed)).toBe('ABCD2345');
    }
  });

  it('refuses anything that cannot be a code', () => {
    for (const typed of ['', 'ABCD-234', 'ABCD-23456', 'ABCD-234O', 'ABCD-2340', 'ABCD-234I']) {
      expect(normalizeSigninCode(typed)).toBeNull();
    }
    for (const typed of ['ABCD-234L', 'ABCD-2341', 'ABCD_2345', 'ÄBCD-2345']) {
      expect(normalizeSigninCode(typed)).toBeNull();
    }
  });
});

describe('formatSigninCode', () => {
  it('puts the dash in the middle', () => {
    expect(formatSigninCode('ABCD2345')).toBe('ABCD-2345');
  });
});
