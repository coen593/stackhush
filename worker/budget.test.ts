// The subrequest budget at run time: every check is made every run, redirects of uptime checks
// are paid from what the plan leaves, and a run never makes more subrequests than the budget.

import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { allowRedirects } from './budget.ts';
import { defineConfig, type Config } from './config.ts';
import { runChecks } from './run.ts';
import { readSecrets, type Secrets } from './secrets.ts';
import type { Fetcher } from './sources/http.ts';
import { loadStatus } from './status.ts';
import { createTestDatabase } from './testing/fakeD1.ts';
import { checkStateKey, type PreviousCheck } from './transitions.ts';

const START = Date.parse('2026-11-26T12:00:00.000Z');
const RUN_INTERVAL_MS = 5 * 60 * 1000;
const SITES = 6;

function siteUrl(index: number): string {
  return `https://site-${index}.example.test`;
}

function siteKey(index: number): string {
  return checkStateKey(`site-${index}`, `uptime:${siteUrl(index)}`);
}

/** Six sites and Supabase: 7 subrequests planned every run. */
function configWith(subrequestBudget: number): Config {
  return defineConfig({
    dashboardUrl: 'https://status.example.test',
    alertTo: 'owner@example.test',
    alertFrom: 'stackhush@alerts.example.test',
    subrequestBudget,
    groups: ['All'],
    projects: Array.from({ length: SITES }, (_, index) => ({
      id: `site-${index}`,
      name: `Site ${index}`,
      group: 'All',
      productionUrls: [siteUrl(index)],
    })),
  });
}

let sqlite: DatabaseSync;
let env: Env;
let sent: unknown[];
let runIndex: number;
/** Site index -> a chain of that many redirects (/h1, /h2, ...) before the answer. */
let hops: Map<number, number>;
let down: Set<number>;
let fetches: number;
let unreachable: Set<number>;

const fetcher: Fetcher = (url) => {
  fetches += 1;
  if (url.startsWith('https://api.supabase.com/')) {
    return Promise.resolve(new Response('[]'));
  }
  const { hostname, pathname } = new URL(url);
  const site = Number(hostname.slice('site-'.length, hostname.indexOf('.')));
  if (unreachable.has(site)) return Promise.reject(new TypeError('unreachable'));
  const hop = pathname.startsWith('/h') ? Number(pathname.slice(2)) : 0;
  if (hop < (hops.get(site) ?? 0)) {
    return Promise.resolve(
      new Response('', { status: 302, headers: { Location: `/h${hop + 1}` } }),
    );
  }
  return Promise.resolve(new Response('', { status: down.has(site) ? 503 : 200 }));
};

/** Runs once and returns how many subrequests the run made. */
async function runOnce(config: Config): Promise<number> {
  fetches = 0;
  await runChecks(env, new Date(START + runIndex * RUN_INTERVAL_MS), config, fetcher);
  runIndex += 1;
  expect(fetches).toBeLessThanOrEqual(config.subrequestBudget);
  return fetches;
}

async function runTimes(config: Config, times: number): Promise<void> {
  for (let run = 0; run < times; run += 1) await runOnce(config);
}

function row(index: number): { status: string; consecutive_failures: number; detail: unknown } {
  const stored = sqlite
    .prepare(
      'SELECT status, consecutive_failures, detail_json FROM check_states WHERE project_id = ?',
    )
    .get(`site-${index}`) as { status: string; consecutive_failures: number; detail_json: string };
  return {
    status: stored.status,
    consecutive_failures: stored.consecutive_failures,
    detail: JSON.parse(stored.detail_json),
  };
}

function eventKinds(): string[] {
  return (sqlite.prepare('SELECT kind FROM events ORDER BY rowid').all() as { kind: string }[]).map(
    (event) => event.kind,
  );
}

async function problems(config: Config): Promise<string[]> {
  const status = await loadStatus(env.DB, config, readSecrets(env, config), new Date());
  return status.problems.map((problem) => problem.title);
}

function overBudget(index: number, short: number): string {
  return `Over the subrequest budget: ${siteUrl(index)} needs at least ${short} more; raise subrequestBudget or remove checks`;
}

beforeEach(() => {
  const database = createTestDatabase();
  sqlite = database.sqlite;
  sent = [];
  runIndex = 0;
  hops = new Map();
  down = new Set();
  fetches = 0;
  unreachable = new Set();
  env = {
    DB: database.db,
    SUPABASE_TOKEN: 'token',
    ALERT_EMAIL: {
      send: (message: unknown) => {
        sent.push(message);
        return Promise.resolve({ messageId: 'id' });
      },
    },
  };
});

describe('a run and its subrequest budget', () => {
  it('makes every check in every run', async () => {
    const config = configWith(7);
    expect(await runOnce(config)).toBe(7);
    expect(await runOnce(config)).toBe(7);
    expect(sqlite.prepare('SELECT COUNT(*) AS total FROM check_states').get()).toEqual({
      total: SITES,
    });
  });

  it('follows a new redirect at once when the budget has room, and plans for it from then on', async () => {
    const config = configWith(9);
    await runOnce(config);
    hops.set(2, 2);
    expect(await runOnce(config)).toBe(9);
    expect(row(2)).toMatchObject({ status: 'ok', detail: { redirects: 2 } });
    expect(await problems(config)).toEqual([]);
    // The known chain is paid for first: a redirect that appears elsewhere finds nothing left.
    hops.set(4, 1);
    expect(await runOnce(config)).toBe(9);
    expect(row(2)).toMatchObject({ status: 'ok', detail: { redirects: 2 } });
    expect(row(4)).toMatchObject({ status: 'ok', detail: { redirects: 1, short: 1 } });
    expect(await problems(config)).toEqual([overBudget(4, 1)]);
  });

  it('does not follow a redirect it has no subrequest for, keeps the state, and shows the problem', async () => {
    const config = configWith(7);
    await runTimes(config, 2);
    hops.set(3, 1);
    await runTimes(config, 4);
    // Every run stayed inside the budget (checked in runOnce). The site is not called down or
    // up: it keeps what it had. Nothing is emailed; the dashboard says what is wrong.
    expect(row(3)).toMatchObject({ status: 'ok', consecutive_failures: 0 });
    expect(eventKinds()).toEqual([]);
    expect(sent).toEqual([]);
    expect(await problems(config)).toEqual([overBudget(3, 1)]);
  });

  it('clears the problem as soon as the check fits: a bigger budget, or the redirect gone', async () => {
    const tight = configWith(7);
    await runOnce(tight);
    hops.set(3, 1);
    await runTimes(tight, 2);
    expect(await problems(tight)).toEqual([overBudget(3, 1)]);

    const roomy = configWith(8);
    expect(await runOnce(roomy)).toBe(8);
    expect(await problems(roomy)).toEqual([]);
    expect(row(3).detail).toEqual({
      label: 'site-3.example.test',
      at: null,
      source: 'uptime',
      redirects: 1,
    });

    // Back to the tight budget: the remembered redirect no longer fits, and it says so again.
    await runOnce(tight);
    expect(await problems(tight)).toEqual([overBudget(3, 1)]);
    hops.clear();
    await runOnce(tight);
    expect(await problems(tight)).toEqual([]);
    expect(row(3).detail).toEqual({ label: 'site-3.example.test', at: null, source: 'uptime' });
  });

  it('keeps a site that was down down, and one that was up up, while it cannot be followed', async () => {
    const config = configWith(7);
    await runOnce(config);
    down.add(1);
    await runTimes(config, 2);
    expect(row(1).status).toBe('problem');
    expect(sent).toHaveLength(1);
    // Both start to redirect: site 1 to a page that still fails, site 5 to one that fails now.
    hops.set(1, 1);
    hops.set(5, 1);
    down.add(5);
    await runTimes(config, 4);
    expect(row(1)).toMatchObject({ status: 'problem', consecutive_failures: 2 });
    expect(row(5)).toMatchObject({ status: 'ok', consecutive_failures: 0 });
    expect(sent).toHaveLength(1);
    expect((await problems(config)).sort()).toEqual([
      overBudget(1, 1),
      overBudget(5, 1),
      expect.stringMatching(/^Site 1: site-1\.example\.test - HTTP 503/),
    ]);

    // With room they are followed: site 5 goes down after its two failed checks.
    const roomy = configWith(9);
    await runTimes(roomy, 2);
    expect(row(5).status).toBe('problem');
    expect(eventKinds()).toEqual(['site_down', 'site_down']);
    expect(await problems(roomy)).toHaveLength(2);
  });

  it('never lets a chain it cannot finish take the subrequest of a chain that works', async () => {
    // Two subrequests beyond the plan. Site 2 has a known one-hop chain.
    const config = configWith(9);
    hops.set(2, 1);
    await runOnce(config);
    expect(row(2).detail).toMatchObject({ redirects: 1 });
    // Site 0, earlier in the config, starts a chain of three: it cannot finish with what is
    // left, now or later. Site 2 must stay really checked all the while.
    hops.set(0, 3);
    await runTimes(config, 3);
    expect(row(0).detail).toMatchObject({ short: expect.any(Number) as unknown });
    expect(row(2).detail).toEqual({
      label: 'site-2.example.test',
      at: null,
      source: 'uptime',
      redirects: 1,
    });

    // So site 2 going down, and coming back, is still seen and emailed.
    down.add(2);
    await runTimes(config, 2);
    expect(row(2).status).toBe('problem');
    down.delete(2);
    await runOnce(config);
    expect(row(2).status).toBe('ok');
    expect(eventKinds()).toEqual(['site_down', 'site_up']);
    expect(sent).toHaveLength(2);
    expect(await problems(config)).toEqual([
      expect.stringMatching(
        /^Over the subrequest budget: https:\/\/site-0\.example\.test needs at least \d more;/,
      ),
    ]);

    // Once site 0 fits it completes, and from then on it is a known chain like any other.
    const roomy = configWith(11);
    await runOnce(roomy);
    expect(row(0).detail).toEqual({
      label: 'site-0.example.test',
      at: null,
      source: 'uptime',
      redirects: 3,
    });
    expect(await problems(roomy)).toEqual([]);
  });

  it('does not take an outage of a URL that ran short for a completed chain', async () => {
    // Two subrequests beyond the plan. Site 2 has a known one-hop chain; site 0, earlier in the
    // config, starts a chain of three it cannot finish.
    const config = configWith(9);
    hops.set(2, 1);
    await runOnce(config);
    hops.set(0, 3);
    await runTimes(config, 2);
    expect(row(0).detail).toMatchObject({ redirects: 2, short: 1 });

    // Site 0 cannot be reached for two runs: down, and still marked short.
    unreachable.add(0);
    await runTimes(config, 2);
    expect(row(0)).toMatchObject({ status: 'problem', detail: { redirects: 2, short: 1 } });
    expect(eventKinds()).toEqual(['site_down']);

    // Back, still three hops. It must not have moved ahead of site 2, which stays really
    // checked: no short mark, and its own outage is still noticed.
    unreachable.delete(0);
    await runTimes(config, 4);
    expect(row(0).detail).toMatchObject({ short: expect.any(Number) as unknown });
    expect(row(2).detail).toEqual({
      label: 'site-2.example.test',
      at: null,
      source: 'uptime',
      redirects: 1,
    });
    down.add(2);
    await runTimes(config, 2);
    expect(row(2).status).toBe('problem');
    expect(await problems(config)).toHaveLength(3);
  });

  it('asks for the whole chain it remembers when the budget shrinks under it', async () => {
    const roomy = configWith(12);
    hops.set(0, 3);
    await runOnce(roomy);
    expect(row(0).detail).toMatchObject({ redirects: 3 });
    const tight = configWith(8);
    expect(await runOnce(tight)).toBe(8);
    expect(await problems(tight)).toEqual([overBudget(0, 2)]);
  });

  it('spends what a missing token frees on redirects', async () => {
    const config = configWith(7);
    env = { ...env, SUPABASE_TOKEN: undefined };
    hops.set(3, 1);
    expect(await runOnce(config)).toBe(7);
    expect(row(3)).toMatchObject({ status: 'ok', detail: { redirects: 1 } });
  });
});

describe('allowRedirects', () => {
  const secrets: Secrets = {
    github: new Map(),
    supabase: 'token',
    cloudflare: null,
    vapid: { kind: 'absent' },
  };
  const remembering = (redirects: Record<number, number>): Map<string, PreviousCheck> =>
    new Map(
      Object.entries(redirects).map(([index, count]) => [
        siteKey(Number(index)),
        {
          projectId: `site-${index}`,
          checkKey: `uptime:${siteUrl(Number(index))}`,
          status: 'ok',
          consecutiveFailures: 0,
          summary: '',
          linkUrl: null,
          detail: { redirects: count },
          problemSince: null,
        },
      ]),
    );

  it('sets aside what each URL took last time and leaves the rest spare', () => {
    const allowance = allowRedirects(configWith(12), secrets, remembering({ 1: 2, 4: 1 }));
    expect(allowance.reserved.get(siteKey(1))).toBe(2);
    expect(allowance.reserved.get(siteKey(4))).toBe(1);
    expect(allowance.reserved.get(siteKey(0))).toBe(0);
    expect(allowance.spare).toBe(12 - 7 - 3);
  });

  it('pays for chains that completed before a URL that ran short, wherever that is in the config', () => {
    // Site 0 comes first in the config and remembers needing 3, but its last check ran short.
    const previous = remembering({ 0: 3, 2: 1, 4: 1 });
    const short = previous.get(siteKey(0));
    if (short) short.detail = { redirects: 3, short: 1 };
    const allowance = allowRedirects(configWith(10), secrets, previous);
    expect([...allowance.reserved.values()]).toEqual([1, 0, 1, 0, 1, 0]);
    expect(allowance.spare).toBe(0);
    // With room for everything it gets all it remembers, and the rest is spare.
    const roomy = allowRedirects(configWith(14), secrets, previous);
    expect([...roomy.reserved.values()]).toEqual([3, 0, 1, 0, 1, 0]);
    expect(roomy.spare).toBe(2);
  });

  it('never hands out more than the budget has left, in the order of the config', () => {
    const allowance = allowRedirects(configWith(9), secrets, remembering({ 1: 1, 2: 3, 4: 1 }));
    expect([...allowance.reserved.values()]).toEqual([0, 1, 1, 0, 0, 0]);
    expect(allowance.spare).toBe(0);
  });

  it('ignores a stored count that cannot be right', () => {
    const allowance = allowRedirects(configWith(40), secrets, remembering({ 0: 99, 1: -1 }));
    expect(allowance.reserved.get(siteKey(0))).toBe(5);
    expect(allowance.reserved.get(siteKey(1))).toBe(0);
  });
});
