import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, environmentOf, type EnvironmentFacts } from './push.ts';

const READY: EnvironmentFacts = {
  isIos: false,
  isStandalone: false,
  isSupported: true,
  vapidPublicKey: 'key',
  permission: 'default',
};

describe('environmentOf', () => {
  it('is ready when everything is there', () => {
    expect(environmentOf(READY)).toBe('ready');
  });

  it('asks for the Home Screen app on iOS before anything else', () => {
    expect(environmentOf({ ...READY, isIos: true, isSupported: false })).toBe('ios-install');
    expect(environmentOf({ ...READY, isIos: true, isStandalone: true })).toBe('ready');
  });

  it('reports unsupported, not set up and denied in that order', () => {
    expect(environmentOf({ ...READY, isSupported: false, vapidPublicKey: null })).toBe(
      'unsupported',
    );
    expect(environmentOf({ ...READY, vapidPublicKey: null, permission: 'denied' })).toBe(
      'not-set-up',
    );
    expect(environmentOf({ ...READY, permission: 'denied' })).toBe('denied');
  });
});

describe('base64UrlToBytes', () => {
  it('decodes unpadded base64url', () => {
    expect([...base64UrlToBytes('-_8')]).toEqual([251, 255]);
    expect([...base64UrlToBytes('AQID')]).toEqual([1, 2, 3]);
  });
});
