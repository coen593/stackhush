import { describe, expect, it } from 'vitest';
import { freshnessOf } from './freshness.ts';

const CHECKED_AT = '2026-11-26T12:00:00.000Z';
const minutesLater = (minutes: number) => Date.parse(CHECKED_AT) + minutes * 60_000;

describe('freshnessOf', () => {
  it('is fresh right after a check', () => {
    expect(freshnessOf(CHECKED_AT, false, minutesLater(3))).toBe('fresh');
  });

  it('goes stale as the clock moves on, without a new load', () => {
    // The same loaded status, looked at later: the age is measured against the current time.
    expect(freshnessOf(CHECKED_AT, false, minutesLater(14))).toBe('fresh');
    expect(freshnessOf(CHECKED_AT, false, minutesLater(15))).toBe('stale');
  });

  it('is never fresh when the last refresh failed, however recent the check', () => {
    expect(freshnessOf(CHECKED_AT, true, minutesLater(1))).toBe('refresh-failed');
    expect(freshnessOf(null, true, minutesLater(1))).toBe('refresh-failed');
  });

  it('is waiting before the first check', () => {
    expect(freshnessOf(null, false, minutesLater(0))).toBe('waiting');
  });
});
