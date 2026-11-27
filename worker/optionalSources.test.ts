// Sources whose token is not set: "not configured", never failing, never alerting.

import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { runChecks } from './run.ts';
import { readSecrets } from './secrets.ts';
import type { Fetcher } from './sources/http.ts';
import { loadStatus } from './status.ts';
import { createTestEnv } from './testing/env.ts';
import { createTestDatabase } from './testing/fakeD1.ts';
import {
  analyticsBody,
  githubGraphqlBody,
  scriptListBody,
  supabaseBody,
  TEST_CONFIG,
  workflowRunsBody,
} from './testing/fixtures.ts';

const START = new Date('2026-11-26T12:00:00.000Z').getTime();
const RUN_INTERVAL_MS = 5 * 60 * 1000;

let sqlite: DatabaseSync;
let db: D1Database;
let sent: unknown[];
let hosts: string[];
let githubStatus: number;
let ciConclusion: string;
let runIndex: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Red CI, a paused Supabase project and a review request: plenty to alert about. */
const fetcher: Fetcher = (url) => {
  hosts.push(new URL(url).hostname);
  if (url.endsWith('/graphql') && url.includes('github')) {
    return Promise.resolve(json(githubGraphqlBody(), githubStatus));
  }
  if (url.includes('/actions/workflows/')) return Promise.resolve(json({ state: 'active' }));
  if (url.includes('/actions/runs')) {
    return Promise.resolve(
      json(
        workflowRunsBody([
          {
            workflow: 1,
            name: 'CI',
            status: 'completed',
            conclusion: ciConclusion,
            at: '2026-11-26T10:00:00Z',
          },
        ]),
        githubStatus,
      ),
    );
  }
  if (url.includes('supabase')) return Promise.resolve(json(supabaseBody()));
  if (url.endsWith('/graphql')) return Promise.resolve(json(analyticsBody([])));
  if (url.includes('cloudflare')) return Promise.resolve(json(scriptListBody()));
  return Promise.resolve(new Response(''));
};

/** The test env with only these secrets set. */
function envWith(secrets: Record<string, string>): Env {
  const base = createTestEnv(db);
  return {
    DB: base.DB,
    ALERT_EMAIL: {
      send: (message: unknown) => {
        sent.push(message);
        return Promise.resolve({ messageId: 'id' });
      },
    },
    ...secrets,
  };
}

const ALL_TOKENS = {
  GITHUB_TOKEN_PERSONAL: 'p',
  GITHUB_TOKEN_WORK: 'w',
  SUPABASE_TOKEN: 's',
  CF_TOKEN: 'c',
};

async function runTimes(env: Env, times: number): Promise<void> {
  for (let run = 0; run < times; run += 1) {
    hosts = [];
    await runChecks(env, new Date(START + runIndex * RUN_INTERVAL_MS), TEST_CONFIG, fetcher);
    runIndex += 1;
  }
}

function health(): Record<string, { consecutive_failures: number; last_error: string | null }> {
  const rows = sqlite
    .prepare('SELECT source, consecutive_failures, last_error FROM source_health')
    .all() as { source: string; consecutive_failures: number; last_error: string | null }[];
  return Object.fromEntries(
    rows.map(({ source, consecutive_failures, last_error }) => [
      source,
      { consecutive_failures, last_error },
    ]),
  );
}

function eventKinds(): string[] {
  return (sqlite.prepare('SELECT kind FROM events ORDER BY rowid').all() as { kind: string }[]).map(
    (row) => row.kind,
  );
}

function count(table: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
  return row.total;
}

function checkKeys(): string[] {
  return (
    sqlite.prepare('SELECT check_key FROM check_states ORDER BY check_key').all() as {
      check_key: string;
    }[]
  ).map((row) => row.check_key);
}

const NOT_CONFIGURED = { consecutive_failures: 0, last_error: 'not configured' };
const WORKING = { consecutive_failures: 0, last_error: null };

beforeEach(() => {
  const database = createTestDatabase();
  sqlite = database.sqlite;
  db = database.db;
  sent = [];
  hosts = [];
  githubStatus = 200;
  ciConclusion = 'failure';
  runIndex = 0;
});

describe('a Worker with no tokens at all', () => {
  it('only checks uptime, calls no API, and records the rest as not configured', async () => {
    const env = envWith({});
    await runTimes(env, 1);
    expect(new Set(hosts)).toEqual(
      new Set(['demo.example.test', 'admin.demo.example.test', 'other.example.test']),
    );
    expect(health()).toEqual({
      uptime: WORKING,
      'github:personal': NOT_CONFIGURED,
      'github:work': NOT_CONFIGURED,
      supabase: NOT_CONFIGURED,
      'cloudflare:main': NOT_CONFIGURED,
      'cloudflare:client': NOT_CONFIGURED,
      'cloudflare:spare': NOT_CONFIGURED,
    });
    expect(checkKeys().every((key) => key.startsWith('uptime:'))).toBe(true);
  });

  it('never counts them as failing and never alerts, however long it runs', async () => {
    const env = envWith({});
    await runTimes(env, 8);
    expect(sent).toEqual([]);
    expect(eventKinds()).toEqual([]);
    expect(health()['github:personal']).toEqual(NOT_CONFIGURED);
    const status = await loadStatus(db, TEST_CONFIG, readSecrets(env, TEST_CONFIG));
    expect(status.problems).toEqual([]);
    expect(status.sources.map((source) => [source.label, source.status, source.summary])).toEqual([
      ['Uptime checks', 'ok', 'Working'],
      ['GitHub (acme)', 'unknown', 'Not configured (no token set)'],
      ['GitHub (acme-org)', 'unknown', 'Not configured (no token set)'],
      ['Supabase', 'unknown', 'Not configured (no token set)'],
      ['Cloudflare (main)', 'unknown', 'Not configured (no token set)'],
      ['Cloudflare (client)', 'unknown', 'Not configured (no token set)'],
      ['Cloudflare (spare)', 'unknown', 'Not configured (no token set)'],
    ]);
  });

  it('treats an empty secret like a missing one', async () => {
    await runTimes(envWith({ SUPABASE_TOKEN: '', GITHUB_TOKEN_PERSONAL: '' }), 1);
    expect(health()['supabase']).toEqual(NOT_CONFIGURED);
    expect(health()['github:personal']).toEqual(NOT_CONFIGURED);
  });
});

describe('a Worker with some tokens', () => {
  it('checks the sources that have one and leaves the others alone', async () => {
    const env = envWith({ GITHUB_TOKEN_PERSONAL: 'p' });
    await runTimes(env, 1);
    expect(health()).toMatchObject({
      'github:personal': WORKING,
      'github:work': NOT_CONFIGURED,
      supabase: NOT_CONFIGURED,
    });
    expect(hosts).toContain('api.github.com');
    expect(hosts).not.toContain('api.supabase.com');
    expect(hosts).not.toContain('api.cloudflare.com');
    // The personal repo's checks are there; the work repo has none.
    expect(
      sqlite.prepare("SELECT project_id FROM check_states WHERE check_key = 'ci'").all(),
    ).toEqual([{ project_id: 'demo' }]);
  });

  it('records a source silently when its token is added later', async () => {
    await runTimes(envWith({}), 2);
    // Red CI, a review request and a paused Supabase project are waiting: its starting point.
    await runTimes(envWith(ALL_TOKENS), 3);
    expect(sent).toEqual([]);
    expect(health()).toMatchObject({ 'github:personal': WORKING, supabase: WORKING });
    expect(checkKeys()).toEqual(expect.arrayContaining(['ci', 'prs', 'deploy']));
  });

  it('keeps the rows of a source whose token is taken away exactly as they were, and hides them', async () => {
    await runTimes(envWith(ALL_TOKENS), 2);
    const kept = (source: string) =>
      sqlite
        .prepare("SELECT * FROM check_states WHERE json_extract(detail_json, '$.source') = ?")
        .all(source);
    const before = { supabase: kept('supabase'), github: kept('github:personal') };
    expect(before.supabase).toHaveLength(2);
    expect(before.github).toHaveLength(3);

    const without = envWith({ GITHUB_TOKEN_WORK: 'w', CF_TOKEN: 'c' });
    await runTimes(without, 4);
    expect(kept('supabase')).toEqual(before.supabase);
    expect(kept('github:personal')).toEqual(before.github);
    expect(eventKinds()).toEqual([]);
    expect(sent).toEqual([]);
    expect(health()).toMatchObject({ supabase: NOT_CONFIGURED, 'github:personal': NOT_CONFIGURED });

    // The dashboard does not show what nobody is checking: no rows, no problems from them.
    const status = await loadStatus(db, TEST_CONFIG, readSecrets(without, TEST_CONFIG));
    const demo = status.groups.flatMap((group) => group.projects).find((p) => p.id === 'demo');
    expect(demo).toMatchObject({ ci: null, deploy: null, pullRequests: null, supabase: null });
    expect(demo?.sites).toHaveLength(2);
    expect(demo?.workers).toHaveLength(2);
    expect(status.unassigned).toEqual([]);
    expect(status.problems.map((problem) => problem.title)).toEqual([
      'Other Site: CI - Failing: CI',
    ]);
    // With the tokens they are there again at once, before any run.
    const withTokens = await loadStatus(
      db,
      TEST_CONFIG,
      readSecrets(envWith(ALL_TOKENS), TEST_CONFIG),
    );
    expect(withTokens.problems).toHaveLength(3);
  });

  it('carries on from the kept rows when the token is back: only real changes are news', async () => {
    await runTimes(envWith(ALL_TOKENS), 2);
    const rows = checkKeys();
    await runTimes(envWith({}), 3);
    expect(checkKeys()).toEqual(rows);

    // Nothing changed while the tokens were away: nothing to say, nothing re-recorded as new.
    await runTimes(envWith(ALL_TOKENS), 2);
    expect(checkKeys()).toEqual(rows);
    expect(eventKinds()).toEqual([]);
    expect(sent).toEqual([]);

    // CI was fixed while the tokens were away again: that is reported when they return.
    await runTimes(envWith({}), 2);
    ciConclusion = 'success';
    await runTimes(envWith(ALL_TOKENS), 2);
    expect(eventKinds()).toEqual(['ci_green', 'ci_green']);
    expect(sent).toHaveLength(1);
    expect(checkKeys()).toEqual(rows);
    expect(eventKinds()).not.toContain('check_removed');
  });

  it('removes a kept row whose project left the config once its token is back', async () => {
    await runTimes(envWith(ALL_TOKENS), 1);
    const withoutOther = { ...TEST_CONFIG, projects: TEST_CONFIG.projects.slice(0, 1) };
    const run = (env: Env) =>
      runChecks(env, new Date(START + (runIndex += 1) * RUN_INTERVAL_MS), withoutOther, fetcher);
    await run(envWith({ GITHUB_TOKEN_PERSONAL: 'p' }));
    // The uptime row went (that source works); the repo's rows wait for their token.
    expect(count("check_states WHERE project_id = 'other'")).toBe(2);
    await run(envWith(ALL_TOKENS));
    expect(count("check_states WHERE project_id = 'other'")).toBe(0);
  });

  it('stops reporting a failing source once its token is taken away, with no "working again"', async () => {
    await runTimes(envWith(ALL_TOKENS), 1);
    githubStatus = 401;
    await runTimes(envWith(ALL_TOKENS), 3);
    expect(sent).toHaveLength(1);
    const without = envWith({ SUPABASE_TOKEN: 's', CF_TOKEN: 'c' });
    const sourceProblems = async (env: Env) =>
      (await loadStatus(db, TEST_CONFIG, readSecrets(env, TEST_CONFIG))).problems.filter(
        (problem) => problem.projectId === null,
      );
    expect(await sourceProblems(envWith(ALL_TOKENS))).toHaveLength(2);
    // Gone from the dashboard at once, before the next run.
    expect(await sourceProblems(without)).toEqual([]);
    await runTimes(without, 2);
    expect(sent).toHaveLength(1);
    expect(eventKinds()).not.toContain('source_ok');
    expect(health()['github:personal']).toEqual(NOT_CONFIGURED);
  });
});
