// Redirects in uptime checks. Each one is a subrequest, so they are followed by hand, counted,
// and remembered, and never followed beyond what the run's budget has left.

import { describe, expect, it } from 'vitest';
import type { StateObservation } from '../observations.ts';
import { rememberedRedirects } from '../budget.ts';
import { DEMO_PROJECT, OTHER_PROJECT } from '../testing/fixtures.ts';
import { checkStateKey, type PreviousCheck } from '../transitions.ts';
import type { Fetcher } from './http.ts';
import { fetchUptime } from './uptime.ts';

const OTHER_URL = 'https://other.example.test';
const OTHER_KEY = `uptime:${OTHER_URL}`;

/** Answers each listed URL with a redirect to the next; anything else with `finalStatus`. */
function chain(hops: Record<string, string>, finalStatus = 200) {
  const calls: { url: string; redirect: RequestInit['redirect'] }[] = [];
  const fetcher: Fetcher = (url, init) => {
    calls.push({ url, redirect: init?.redirect });
    const location = hops[url];
    return Promise.resolve(
      location === undefined
        ? new Response('', { status: finalStatus })
        : new Response('', { status: 301, headers: { Location: location } }),
    );
  };
  return { fetcher, calls };
}

function remembering(redirects: number): Map<string, PreviousCheck> {
  return new Map([
    [
      checkStateKey('other', OTHER_KEY),
      {
        projectId: 'other',
        checkKey: OTHER_KEY,
        status: 'ok',
        consecutiveFailures: 0,
        summary: '200 in 5 ms',
        linkUrl: OTHER_URL,
        detail: { label: 'other.example.test', at: null, source: 'uptime', redirects },
        problemSince: null,
      },
    ],
  ]);
}

/** Checks the one URL with `spare` subrequests, and its remembered redirects set aside. */
async function check(
  fetcher: Fetcher,
  previous: ReadonlyMap<string, PreviousCheck>,
  spare: number,
  reserved = rememberedRedirects(previous.get(checkStateKey('other', OTHER_KEY))),
): Promise<StateObservation> {
  const allowance = { reserved: new Map([[checkStateKey('other', OTHER_KEY), reserved]]), spare };
  const result = await fetchUptime(fetcher, [OTHER_PROJECT], previous, allowance);
  const [observation] = result.observations;
  if (observation?.type !== 'state') throw new Error('Expected one state observation');
  return observation;
}

describe('uptime redirects', () => {
  it('never lets fetch follow a redirect on its own', async () => {
    const { fetcher, calls } = chain({ [OTHER_URL]: 'https://www.other.example.test/' });
    await check(fetcher, new Map(), 5);
    expect(calls.map((call) => call.redirect)).toEqual(['manual', 'manual']);
  });

  it('follows a redirect it has a subrequest for, and remembers how many it took', async () => {
    const { fetcher, calls } = chain({
      [OTHER_URL]: 'https://www.other.example.test/',
      'https://www.other.example.test/': '/home',
    });
    const observation = await check(fetcher, new Map(), 2);
    expect(calls.map((call) => call.url)).toEqual([
      OTHER_URL,
      'https://www.other.example.test/',
      // A relative Location is read against the URL that sent it.
      'https://www.other.example.test/home',
    ]);
    expect(observation).toMatchObject({ status: 'ok', learned: { redirects: 2 } });
    expect(observation.summary).toMatch(/^200 in \d+ ms$/);
  });

  it('judges the site by where the redirects end', async () => {
    const { fetcher } = chain({ [OTHER_URL]: 'https://www.other.example.test/' }, 503);
    const observation = await check(fetcher, new Map(), 1);
    expect(observation.status).toBe('problem');
    expect(observation.summary).toMatch(/^HTTP 503 in \d+ ms$/);
  });

  it('stores nothing extra for a URL that does not redirect', async () => {
    const observation = await check(chain({}).fetcher, remembering(1), 0);
    expect(observation.status).toBe('ok');
    expect(observation.learned).toBeUndefined();
  });

  it('follows the redirects it took last time without needing spare subrequests', async () => {
    const { fetcher, calls } = chain({ [OTHER_URL]: 'https://www.other.example.test/' });
    const observation = await check(fetcher, remembering(1), 0);
    expect(calls).toHaveLength(2);
    expect(observation).toMatchObject({ status: 'ok', learned: { redirects: 1 } });
  });

  it('does not follow a redirect nobody counted when nothing is spare, and says so without judging', async () => {
    const { fetcher, calls } = chain({ [OTHER_URL]: 'https://www.other.example.test/' });
    const observation = await check(fetcher, new Map(), 0);
    expect(calls).toHaveLength(1);
    // Not down and not up: the stored state stands, and it says how much it was short.
    expect(observation).toMatchObject({
      status: 'unknown',
      summary: 'Redirect not followed (subrequest budget)',
      learned: { redirects: 1, short: 1 },
    });
  });

  it('stops at the first hop past what it took last time when nothing is spare', async () => {
    const { fetcher, calls } = chain({
      [OTHER_URL]: 'https://a.other.example.test/',
      'https://a.other.example.test/': 'https://b.other.example.test/',
    });
    const observation = await check(fetcher, remembering(1), 0);
    expect(calls).toHaveLength(2);
    expect(observation).toMatchObject({ status: 'unknown', learned: { redirects: 2, short: 1 } });
  });

  it('keeps what it remembered, and asks for all of it, when the budget set nothing aside', async () => {
    const { fetcher, calls } = chain({ [OTHER_URL]: 'https://www.other.example.test/' });
    // It took three redirects last time; this run has room for none of them.
    const observation = await check(fetcher, remembering(3), 0, 0);
    expect(calls).toHaveLength(1);
    expect(observation).toMatchObject({ status: 'unknown', learned: { redirects: 3, short: 3 } });
  });

  it('keeps the short mark when a URL that ran short cannot be reached', async () => {
    const stored = remembering(2);
    const [check0] = stored.values();
    if (check0) check0.detail = { ...check0.detail, short: 1 };
    const unreachable: Fetcher = () => Promise.reject(new TypeError('connect failed'));
    const observation = await check(unreachable, stored, 0, 1);
    // Down is down, but the chain is still a guess, not one that was followed to the end.
    expect(observation).toMatchObject({
      status: 'problem',
      summary: 'unreachable',
      learned: { redirects: 2, short: 1 },
    });
    // A chain that had completed stays a known chain through an outage.
    const known = await check(unreachable, remembering(2), 0);
    expect(known.learned).toEqual({ redirects: 2 });
  });

  it('shares the spare subrequests between the URLs of a run and never spends more', async () => {
    // Both of the demo project's URLs and the other project's URL redirect once; one is spare.
    const calls: string[] = [];
    const fetcher: Fetcher = (url) => {
      calls.push(url);
      return Promise.resolve(
        url.endsWith('/landed')
          ? new Response('')
          : new Response('', { status: 302, headers: { Location: '/landed' } }),
      );
    };
    const result = await fetchUptime(fetcher, [DEMO_PROJECT, OTHER_PROJECT], new Map(), {
      reserved: new Map(),
      spare: 1,
    });
    expect(calls).toHaveLength(3 + 1);
    const statuses = result.observations.map((o) => (o.type === 'state' ? o.status : ''));
    expect(statuses.filter((status) => status === 'ok')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'unknown')).toHaveLength(2);
  });

  it('gives up on a chain of more than five redirects, as a failed check', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = (url) => {
      calls.push(url);
      return Promise.resolve(
        new Response('', { status: 302, headers: { Location: `${OTHER_URL}/${calls.length}` } }),
      );
    };
    const observation = await check(fetcher, new Map(), 100);
    expect(calls).toHaveLength(6);
    expect(observation).toMatchObject({
      status: 'problem',
      summary: 'too many redirects',
      learned: { redirects: 5 },
    });
  });

  it('treats a redirect without a usable Location as the answer it is', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(new Response('', { status: 302, headers: { Location: 'mailto:x@y.test' } }));
    const observation = await check(fetcher, new Map(), 5);
    expect(observation.status).toBe('problem');
    expect(observation.summary).toMatch(/^HTTP 302 in \d+ ms$/);
  });
});
