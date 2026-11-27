import { describe, expect, it } from 'vitest';
import { forgetPendingCode, hasPendingCode, rememberPendingCode } from './pendingCode.ts';

const NOW = new Date('2026-11-26T12:00:00.000Z').getTime();
const MINUTE_MS = 60 * 1000;

function fakeStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

describe('the pending sign-in code', () => {
  it('is not there before one was asked for', () => {
    expect(hasPendingCode(fakeStorage(), NOW)).toBe(false);
  });

  it('is there for 15 minutes after asking', () => {
    const storage = fakeStorage();
    rememberPendingCode(storage, NOW);
    expect(hasPendingCode(storage, NOW)).toBe(true);
    expect(hasPendingCode(storage, NOW + 15 * MINUTE_MS - 1)).toBe(true);
    expect(hasPendingCode(storage, NOW + 15 * MINUTE_MS)).toBe(false);
  });

  it('is gone once forgotten', () => {
    const storage = fakeStorage();
    rememberPendingCode(storage, NOW);
    forgetPendingCode(storage);
    expect(hasPendingCode(storage, NOW)).toBe(false);
  });

  it('ignores a stored value that is not a past time', () => {
    const storage = fakeStorage();
    for (const value of ['', 'soon', '-5', String(NOW + MINUTE_MS)]) {
      storage.setItem('stackhush.codeRequestedAt', value);
      expect(hasPendingCode(storage, NOW)).toBe(false);
    }
  });

  it('stores nothing but the time', () => {
    const storage = fakeStorage();
    rememberPendingCode(storage, NOW);
    expect(storage.length).toBe(1);
    expect(storage.getItem('stackhush.codeRequestedAt')).toBe(String(NOW));
  });
});
