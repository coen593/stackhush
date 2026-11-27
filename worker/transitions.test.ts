import { describe, expect, it } from 'vitest';
import type {
  Observation,
  PullRequestObservation,
  PullRequestsObservation,
  SourceResult,
  StateObservation,
} from './observations.ts';
import {
  checkStateKey,
  evaluate,
  evaluateSources,
  reviewRequestKey,
  sourceFailingTitle,
  type EvaluateInput,
  type PreviousCheck,
  type PreviousSourceHealth,
} from './transitions.ts';

const NOW = '2026-11-26T12:00:00.000Z';
const SOURCE = 'test';
const NAMES = new Map([['demo', 'Demo App']]);
const EARLIER = '2026-11-26T11:00:00.000Z';

function state(overrides: Partial<StateObservation> = {}): StateObservation {
  return {
    type: 'state',
    projectId: 'demo',
    checkKey: 'ci',
    kind: 'ci',
    subject: 'Demo',
    label: 'CI',
    status: 'ok',
    summary: 'Passing',
    linkUrl: 'https://example.test/run/1',
    at: null,
    failuresToProblem: 1,
    ...overrides,
  };
}

function uptime(overrides: Partial<StateObservation> = {}): StateObservation {
  return state({
    checkKey: 'uptime:https://demo.example',
    kind: 'uptime',
    subject: 'demo.example',
    label: 'demo.example',
    failuresToProblem: 2,
    ...overrides,
  });
}

function prs(
  pullRequests: PullRequestObservation[],
  overrides: Partial<PullRequestsObservation> = {},
): PullRequestsObservation {
  return {
    type: 'pull_requests',
    projectId: 'demo',
    projectName: 'Demo',
    repo: 'owner/demo',
    pullRequests,
    ...overrides,
  };
}

function pr(number: number, isReviewRequestedFromMe: boolean): PullRequestObservation {
  return {
    number,
    title: `Change ${number}`,
    url: `https://example.test/pull/${number}`,
    isReviewRequestedFromMe,
  };
}

function previousOf(entries: Record<string, Partial<PreviousCheck>>): Map<string, PreviousCheck> {
  const map = new Map<string, PreviousCheck>();
  for (const [key, entry] of Object.entries(entries)) {
    const [projectId = '', checkKey = ''] = key.split('|');
    map.set(key, {
      projectId,
      checkKey,
      status: entry.status ?? 'ok',
      consecutiveFailures: entry.consecutiveFailures ?? 0,
      summary: entry.summary ?? 'Passing',
      linkUrl: entry.linkUrl ?? 'https://example.test/run/1',
      detail: entry.detail ?? { label: 'CI', at: null, source: SOURCE },
      problemSince: entry.problemSince ?? null,
    });
  }
  return map;
}

function results(observations: Observation[], error: string | null = null): SourceResult[] {
  return [{ source: SOURCE, label: 'Test source', error, observations }];
}

/** Evaluates one source's observations. That source has reported before unless said otherwise. */
function run(
  observations: Observation[],
  overrides: Partial<EvaluateInput> = {},
): ReturnType<typeof evaluate> {
  return evaluate({
    previous: previousOf({ [OTHER_KEY]: {} }),
    results: results(observations),
    notifiedReviewRequests: new Set(),
    notConfiguredSources: new Set(),
    isFirstRun: false,
    projectNames: NAMES,
    now: NOW,
    ...overrides,
  });
}

const CI_KEY = checkStateKey('demo', 'ci');
// A check of the same source that never changes, so the source counts as having reported before.
const OTHER_KEY = checkStateKey('demo', 'other');
const SITE_KEY = checkStateKey('demo', 'uptime:https://demo.example');

describe('first run', () => {
  it('records state and sends nothing, even for problems and review requests', () => {
    const result = run(
      [state({ status: 'problem', summary: 'Failing: build' }), prs([pr(1, true)])],
      { isFirstRun: true },
    );
    expect(result.transitions).toEqual([]);
    expect(result.checks.map((check) => check.status)).toEqual(['problem', 'ok']);
    expect(result.newReviewRequests).toEqual([{ repo: 'owner/demo', prNumber: 1 }]);
  });

  it('alerts when a check first shows up as a problem after the first run', () => {
    const result = run([state({ status: 'problem' })]);
    expect(result.transitions.map((transition) => transition.kind)).toEqual(['ci_red']);
    expect(result.checks[0]?.status).toBe('problem');
    expect(result.checks[0]?.problemSince).toBe(NOW);
  });

  it('seeds silently when a source reports for the first time after the first run', () => {
    // Nothing stored came from this source: its token only started working now.
    const previous = previousOf({ [OTHER_KEY]: { detail: { source: 'another-source' } } });
    const result = evaluate({
      previous,
      results: [
        ...results([state({ status: 'problem' }), prs([pr(1, true)])]),
        { source: 'another-source', label: 'Another', error: null, observations: [] },
      ],
      notifiedReviewRequests: new Set(),
      notConfiguredSources: new Set(),
      isFirstRun: false,
      projectNames: NAMES,
      now: NOW,
    });
    expect(result.transitions).toEqual([]);
    expect(result.checks.map((check) => check.status)).toEqual(['problem', 'ok']);
    expect(result.newReviewRequests).toEqual([{ repo: 'owner/demo', prNumber: 1 }]);
  });

  it('records which source reported a check, and what the source wants back', () => {
    const result = run([state({ memory: { failing: [] } })]);
    expect(result.checks[0]?.detail).toEqual({
      label: 'CI',
      at: null,
      source: SOURCE,
      failing: [],
    });
  });
});

describe('writes', () => {
  const stored = { [CI_KEY]: { summary: 'Passing', linkUrl: 'https://example.test/run/1' } };

  it('skips a check that is exactly as stored', () => {
    expect(run([state()], { previous: previousOf(stored) }).checks).toEqual([]);
  });

  it('writes a check when its summary, link or detail changed', () => {
    const previous = previousOf(stored);
    expect(run([state({ summary: 'Passing (2 workflows)' })], { previous }).checks).toHaveLength(1);
    expect(
      run([state({ linkUrl: 'https://example.test/run/2' })], { previous }).checks,
    ).toHaveLength(1);
    expect(run([state({ at: EARLIER })], { previous }).checks).toHaveLength(1);
    expect(run([state({ memory: { failing: [] } })], { previous }).checks).toHaveLength(1);
  });
});

describe('checks that are no longer reported', () => {
  const previous = previousOf({
    [CI_KEY]: { status: 'problem', problemSince: EARLIER },
    [OTHER_KEY]: { detail: { label: 'Other', source: SOURCE } },
  });
  const evaluateWith = (sources: SourceResult[]) =>
    evaluate({
      previous,
      results: sources,
      notifiedReviewRequests: new Set(),
      notConfiguredSources: new Set(),
      isFirstRun: false,
      projectNames: NAMES,
      now: NOW,
    });

  it('removes them when their source worked, without a transition', () => {
    const result = evaluateWith(results([state({ checkKey: 'other' })]));
    expect(result.removals).toEqual([
      { projectId: 'demo', checkKey: 'ci', title: 'Demo App: CI no longer watched' },
    ]);
    expect(result.transitions).toEqual([]);
  });

  it('names the project and the check in words, not ids', () => {
    const stored = previousOf({
      [checkStateKey('demo', 'prs')]: { detail: { pullRequests: [], source: SOURCE } },
      [checkStateKey('unassigned', 'supabase:zzzz')]: {
        detail: { label: 'stray-project', source: SOURCE },
      },
      [checkStateKey('left-config', 'ci')]: {},
    });
    const result = evaluate({
      previous: stored,
      results: results([]),
      notifiedReviewRequests: new Set(),
      notConfiguredSources: new Set(),
      isFirstRun: false,
      projectNames: NAMES,
      now: NOW,
    });
    expect(result.removals.map((removal) => removal.title)).toEqual([
      'Demo App: Open PRs no longer watched',
      'Unassigned: stray-project no longer watched',
      'left-config: CI no longer watched',
    ]);
  });

  it('removes nothing when their source failed, even if it reported other checks', () => {
    const result = evaluateWith(results([state({ checkKey: 'other' })], 'HTTP 500'));
    expect(result.removals).toEqual([]);
  });

  it('keeps a check whose observation was unknown', () => {
    const result = evaluateWith(
      results([state({ status: 'unknown' }), state({ checkKey: 'other' })]),
    );
    expect(result.removals).toEqual([]);
  });

  it('removes nothing of a source whose token is not set', () => {
    const result = evaluate({
      previous,
      results: [],
      notifiedReviewRequests: new Set(),
      notConfiguredSources: new Set([SOURCE]),
      isFirstRun: false,
      projectNames: NAMES,
      now: NOW,
    });
    expect(result).toEqual({ checks: [], transitions: [], newReviewRequests: [], removals: [] });
  });

  it('removes checks of a source that no longer exists, whatever the other sources did', () => {
    const result = evaluateWith([
      { source: 'renamed', label: 'Renamed', error: 'timed out', observations: [] },
    ]);
    expect(result.removals.map((removal) => removal.checkKey)).toEqual(['ci', 'other']);
  });
});

describe('state transitions', () => {
  const cases = [
    { kind: 'uptime', problem: 'site_down', recovery: 'site_up' },
    { kind: 'deploy', problem: 'deploy_failed', recovery: 'deploy_ok' },
    { kind: 'ci', problem: 'ci_red', recovery: 'ci_green' },
    { kind: 'supabase', problem: 'supabase_unhealthy', recovery: 'supabase_healthy' },
    { kind: 'worker', problem: 'worker_errors', recovery: 'worker_ok' },
  ] as const;

  for (const { kind, problem, recovery } of cases) {
    it(`${kind}: fires once when it goes bad and once when it recovers`, () => {
      const key = checkStateKey('demo', 'check');
      const base = { checkKey: 'check', kind, failuresToProblem: 1 };

      const down = run([state({ ...base, status: 'problem' })], {
        previous: previousOf({ [key]: { status: 'ok' } }),
      });
      expect(down.transitions.map((transition) => transition.kind)).toEqual([problem]);
      expect(down.checks[0]?.problemSince).toBe(NOW);

      const stillDown = run([state({ ...base, status: 'problem' })], {
        previous: previousOf({ [key]: { status: 'problem', problemSince: EARLIER } }),
      });
      expect(stillDown.transitions).toEqual([]);
      expect(stillDown.checks[0]?.problemSince).toBe(EARLIER);

      const up = run([state({ ...base, status: 'ok' })], {
        previous: previousOf({ [key]: { status: 'problem', problemSince: EARLIER } }),
      });
      expect(up.transitions.map((transition) => transition.kind)).toEqual([recovery]);
      expect(up.checks[0]?.problemSince).toBeNull();
    });
  }

  it('does nothing while ok stays ok', () => {
    const result = run([state()], { previous: previousOf({ [CI_KEY]: { status: 'ok' } }) });
    expect(result.transitions).toEqual([]);
  });

  it('puts the subject, summary and link in the title and link', () => {
    const result = run(
      [uptime({ status: 'problem', summary: 'HTTP 503 in 90 ms', failuresToProblem: 1 })],
      { previous: previousOf({ [SITE_KEY]: { status: 'ok' } }) },
    );
    expect(result.transitions[0]).toMatchObject({
      projectId: 'demo',
      title: 'demo.example is down (HTTP 503 in 90 ms)',
      linkUrl: 'https://example.test/run/1',
      occurredAt: NOW,
    });
  });

  it('keeps the previous state when the observation is unknown', () => {
    const result = run([state({ status: 'unknown', summary: 'In progress' })], {
      previous: previousOf({ [CI_KEY]: { status: 'problem', problemSince: EARLIER } }),
    });
    expect(result.checks).toEqual([]);
    expect(result.transitions).toEqual([]);
  });

  it('stores what a source learnt with an unknown observation, and nothing else of it', () => {
    const stored = previousOf({
      [CI_KEY]: {
        status: 'problem',
        consecutiveFailures: 2,
        summary: 'HTTP 503 in 9 ms',
        problemSince: EARLIER,
        detail: { label: 'CI', at: null, source: SOURCE, kept: true },
      },
    });
    const unknown = state({ status: 'unknown', summary: 'Could not tell', linkUrl: null });
    const result = run([{ ...unknown, memory: { ignored: 1 }, learned: { redirects: 2 } }], {
      previous: stored,
    });
    expect(result.transitions).toEqual([]);
    expect(result.checks).toEqual([
      {
        projectId: 'demo',
        checkKey: 'ci',
        status: 'problem',
        consecutiveFailures: 2,
        summary: 'HTTP 503 in 9 ms',
        linkUrl: 'https://example.test/run/1',
        detail: { label: 'CI', at: null, source: SOURCE, kept: true, redirects: 2 },
        problemSince: EARLIER,
        observedAt: NOW,
      },
    ]);
    // Learnt nothing new: nothing is written.
    const again = run([{ ...unknown, learned: { kept: true } }], { previous: stored });
    expect(again.checks).toEqual([]);
  });

  it('records a never-seen unknown check, and a later problem on it is news', () => {
    const first = run([state({ status: 'unknown', summary: 'In progress' })]);
    expect(first.checks[0]?.status).toBe('unknown');
    const second = run([state({ status: 'problem' })], {
      previous: previousOf({ [CI_KEY]: { status: 'unknown' } }),
    });
    expect(second.transitions.map((transition) => transition.kind)).toEqual(['ci_red']);
  });
});

describe('uptime debounce', () => {
  it('stays up after one failed run and says it is checking again', () => {
    const result = run([uptime({ status: 'problem', summary: 'timed out' })], {
      previous: previousOf({ [SITE_KEY]: { status: 'ok' } }),
    });
    expect(result.transitions).toEqual([]);
    expect(result.checks[0]).toMatchObject({
      status: 'ok',
      consecutiveFailures: 1,
      summary: 'timed out (checking again)',
    });
  });

  it('goes down after two failed runs in a row', () => {
    const result = run([uptime({ status: 'problem', summary: 'timed out' })], {
      previous: previousOf({ [SITE_KEY]: { status: 'ok', consecutiveFailures: 1 } }),
    });
    expect(result.transitions.map((transition) => transition.kind)).toEqual(['site_down']);
    expect(result.checks[0]?.consecutiveFailures).toBe(2);
  });

  it('forgets a single failure when the next run succeeds, with no email either way', () => {
    const result = run([uptime()], {
      previous: previousOf({ [SITE_KEY]: { status: 'ok', consecutiveFailures: 1 } }),
    });
    expect(result.transitions).toEqual([]);
    expect(result.checks[0]?.consecutiveFailures).toBe(0);
  });

  it('is up again after one success', () => {
    const result = run([uptime()], {
      previous: previousOf({
        [SITE_KEY]: { status: 'problem', consecutiveFailures: 5, problemSince: EARLIER },
      }),
    });
    expect(result.transitions.map((transition) => transition.kind)).toEqual(['site_up']);
  });

  it('seeds a site that fails on its first sighting as unknown, then alerts on the second failure', () => {
    const first = run([uptime({ status: 'problem' })]);
    expect(first.checks[0]?.status).toBe('unknown');
    const second = run([uptime({ status: 'problem' })], {
      previous: previousOf({ [SITE_KEY]: { status: 'unknown', consecutiveFailures: 1 } }),
    });
    expect(second.transitions.map((transition) => transition.kind)).toEqual(['site_down']);
  });
});

describe('review requests', () => {
  const previous = previousOf({ [checkStateKey('demo', 'prs')]: { status: 'ok' } });

  it('alerts once for a new review request and remembers the PR', () => {
    const result = run([prs([pr(7, true), pr(8, false)])], { previous });
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]).toMatchObject({
      kind: 'review_requested',
      checkKey: 'pr:owner/demo#7',
      title: 'Demo: review requested on PR #7 (Change 7)',
      linkUrl: 'https://example.test/pull/7',
    });
    expect(result.newReviewRequests).toEqual([{ repo: 'owner/demo', prNumber: 7 }]);
  });

  it('does not alert again for a PR already notified', () => {
    const result = run([prs([pr(7, true)])], {
      previous,
      notifiedReviewRequests: new Set([reviewRequestKey('owner/demo', 7)]),
    });
    expect(result.transitions).toEqual([]);
    expect(result.newReviewRequests).toEqual([]);
  });

  it('alerts for a second PR but not the first again', () => {
    const result = run([prs([pr(7, true), pr(9, true)])], {
      previous,
      notifiedReviewRequests: new Set([reviewRequestKey('owner/demo', 7)]),
    });
    expect(result.transitions.map((transition) => transition.checkKey)).toEqual([
      'pr:owner/demo#9',
    ]);
  });

  it('keeps PRs apart by repo', () => {
    const result = run([prs([pr(7, true)], { repo: 'owner/other' })], {
      previous,
      notifiedReviewRequests: new Set([reviewRequestKey('owner/demo', 7)]),
    });
    expect(result.transitions).toHaveLength(1);
  });

  it('summarizes the open PRs for the dashboard', () => {
    const result = run([prs([pr(1, false), pr(2, true)])], { previous });
    expect(result.checks[0]?.summary).toBe('2 open, 1 need your review');
    expect(run([prs([])], { previous }).checks[0]?.summary).toBe('No open PRs');
  });
});

describe('source health', () => {
  function result(error: string | null, source = 'github:work'): SourceResult {
    return { source, label: 'GitHub (acme-org)', error, observations: [] };
  }
  const health = (failures: number): Map<string, PreviousSourceHealth> =>
    new Map([['github:work', { consecutiveFailures: failures, lastSuccessAt: EARLIER }]]);

  it('counts failures and keeps the last success time', () => {
    const output = evaluateSources({
      previous: health(1),
      results: [result('HTTP 401')],
      notConfigured: [],
      isFirstRun: false,
      now: NOW,
    });
    expect(output.health[0]).toEqual({
      source: 'github:work',
      consecutiveFailures: 2,
      lastError: 'HTTP 401',
      lastAttemptAt: NOW,
      lastSuccessAt: EARLIER,
    });
    expect(output.transitions).toEqual([]);
  });

  it('fires once on the third failed run in a row, naming the rejected token', () => {
    const third = evaluateSources({
      previous: health(2),
      results: [result('HTTP 401')],
      notConfigured: [],
      isFirstRun: false,
      now: NOW,
    });
    expect(third.transitions).toHaveLength(1);
    expect(third.transitions[0]).toMatchObject({
      projectId: null,
      kind: 'source_failing',
      checkKey: 'source:github:work',
      title: 'GitHub (acme-org) token was rejected (HTTP 401)',
    });
    const fourth = evaluateSources({
      previous: health(3),
      results: [result('HTTP 401')],
      notConfigured: [],
      isFirstRun: false,
      now: NOW,
    });
    expect(fourth.transitions).toEqual([]);
  });

  it('describes a non-auth failure without calling the token rejected', () => {
    expect(sourceFailingTitle('Supabase', 'timed out')).toBe(
      'Supabase has failed 3 runs in a row (timed out)',
    );
  });

  it('recovers once, only after it had been reported', () => {
    const recovered = evaluateSources({
      previous: health(3),
      results: [result(null)],
      notConfigured: [],
      isFirstRun: false,
      now: NOW,
    });
    expect(recovered.transitions.map((transition) => transition.kind)).toEqual(['source_ok']);
    expect(recovered.health[0]).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: NOW });
    expect(
      evaluateSources({
        previous: health(2),
        results: [result(null)],
        notConfigured: [],
        isFirstRun: false,
        now: NOW,
      }).transitions,
    ).toEqual([]);
  });

  it('records health on the first run without alerts', () => {
    const output = evaluateSources({
      previous: health(2),
      results: [result('HTTP 401')],
      notConfigured: [],
      isFirstRun: true,
      now: NOW,
    });
    expect(output.transitions).toEqual([]);
    expect(output.health[0]?.consecutiveFailures).toBe(3);
  });

  it('records a source without a token as not configured, never as a failure', () => {
    const output = evaluateSources({
      previous: health(5),
      results: [],
      notConfigured: ['github:work'],
      isFirstRun: false,
      now: NOW,
    });
    expect(output.health).toEqual([
      {
        source: 'github:work',
        consecutiveFailures: 0,
        lastError: 'not configured',
        lastAttemptAt: NOW,
        lastSuccessAt: EARLIER,
      },
    ]);
    // Not "failing", and not "working again" either: it was switched off, not fixed.
    expect(output.transitions).toEqual([]);
  });

  it('writes nothing for a source that was neither called nor without a token', () => {
    const output = evaluateSources({
      previous: health(2),
      results: [],
      notConfigured: [],
      isFirstRun: false,
      now: NOW,
    });
    expect(output).toEqual({ health: [], transitions: [] });
  });

  it('starts from zero for a source never seen', () => {
    const output = evaluateSources({
      previous: new Map(),
      results: [result('timed out')],
      notConfigured: [],
      isFirstRun: false,
      now: NOW,
    });
    expect(output.health[0]?.consecutiveFailures).toBe(1);
  });
});
