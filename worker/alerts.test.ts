import { describe, expect, it } from 'vitest';
import { composeAlertEmail, composeSubject, type AlertEvent } from './alerts.ts';

function event(title: string, occurredAt: string, linkUrl: string | null = null): AlertEvent {
  return { id: title, title, linkUrl, occurredAt };
}

const DOWN = event('demo.example is down (timed out)', '2026-11-26T12:05:00.000Z');
const UP = event('demo.example is back up', '2026-11-26T14:00:00.000Z');
const RED = event('Demo: CI on the default branch went red', '2026-11-26T14:00:00.000Z');

describe('composeSubject', () => {
  it('names a single change', () => {
    expect(composeSubject([DOWN])).toBe('demo.example is down (timed out)');
  });

  it('counts several changes and lists them all, newest first', () => {
    // Oldest first is how the queue is read; a late email must not lead with stale news.
    expect(composeSubject([DOWN, UP, RED])).toBe(
      '3 changes: demo.example is back up, Demo: CI on the default branch went red, demo.example is down (timed out)',
    );
  });

  it('cuts a long subject and keeps line breaks out of the header', () => {
    const long = event(`Demo: review requested on PR #1 (${'x'.repeat(200)})`, DOWN.occurredAt);
    expect(composeSubject([long])).toHaveLength(120);
    expect(composeSubject([event('one\r\nBcc: someone', DOWN.occurredAt)])).toBe(
      'one  Bcc: someone',
    );
  });

  it('refuses an empty batch', () => {
    expect(() => composeSubject([])).toThrow();
  });
});

describe('composeAlertEmail', () => {
  it('lists every change with its time and link, oldest first, and links the dashboard', () => {
    const linked = event(
      'Demo: review requested on PR #7 (Fix <b>)',
      UP.occurredAt,
      'https://x.test/7?a=1&b=2',
    );
    const email = composeAlertEmail([DOWN, linked], 'https://status.example.test');
    expect(email.text).toBe(
      '- demo.example is down (timed out)\n  2026-11-26T12:05:00.000Z\n\n' +
        '- Demo: review requested on PR #7 (Fix <b>)\n  2026-11-26T14:00:00.000Z\n  https://x.test/7?a=1&b=2\n\n' +
        'Dashboard: https://status.example.test\n',
    );
    expect(email.html).toContain('<a href="https://x.test/7?a=1&amp;b=2">');
    expect(email.html).toContain('Fix &lt;b&gt;');
    expect(email.html).not.toContain('<b>');
    expect(email.html).toContain('<a href="https://status.example.test">Open the dashboard</a>');
  });
});
