// Writes realistic synthetic state into the local D1 so the dashboard can be looked at without
// tokens or a cron run. It replaces whatever state is there (sessions are left alone).
//
//   npm run seed:local
//
// Project ids, URLs and Worker names come from stackhush.config.ts (the example config is all
// made up); everything else (PR titles, latencies, problems, events) is invented here.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import config from '../stackhush.config.ts';
import { cloudflareSource, githubSource, listSources, sourceLabel } from '../worker/config.ts';

// The D1 binding in wrangler.jsonc; wrangler accepts it in place of the database name.
const DATABASE_BINDING = 'DB';
const WRANGLER_TIMEOUT_MS = 120_000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const { projects } = config;
const now = Date.now();
const ago = (ms: number): string => new Date(now - ms).toISOString();

type Status = 'ok' | 'problem' | 'unknown';

interface SeedCheck {
  projectId: string;
  checkKey: string;
  status: Status;
  summary: string;
  linkUrl: string | null;
  detail: Record<string, unknown>;
  problemSince: string | null;
}

const checks: SeedCheck[] = [];

function quote(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function addCheck(check: Omit<SeedCheck, 'problemSince'> & { problemSince?: string }): void {
  checks.push({ ...check, problemSince: check.problemSince ?? null });
}

// Which projects get a problem or open PRs is decided by position, so any config works.
const withRepo = projects.filter((project) => project.github !== null);
const withSite = projects.filter((project) => project.productionUrls.length > 0);
const PROBLEMS = {
  siteDown: withSite.at(-1) ?? null,
  ciRed: withRepo.at(-1) ?? null,
  pausedSupabase: projects.find((project) => project.supabaseRef !== null) ?? null,
  noisyWorker: projects.flatMap((project) => project.cloudflare?.scripts ?? []).at(-1) ?? null,
};

// Made-up PRs for the first three repos.
const MADE_UP_PULL_REQUESTS = [
  [{ number: 14, title: 'Show the due date on the list page', review: true }],
  [
    { number: 212, title: 'Group reports by week', review: true },
    { number: 214, title: 'Update the onboarding copy', review: true },
    { number: 209, title: 'Bump the chart library', review: false },
  ],
  [
    { number: 88, title: 'Rework the notification settings screen', review: false },
    { number: 91, title: 'Cache the product list', review: false },
    { number: 92, title: 'Fix the rounding of totals', review: false },
  ],
];
// What a repo that shows pull request checks says about its PRs, by position.
const MADE_UP_CHECKS = ['passing', 'failing', 'running'] as const;
const pullRequestsOf = (projectId: string) =>
  MADE_UP_PULL_REQUESTS[withRepo.findIndex((project) => project.id === projectId)] ?? [];

for (const project of projects) {
  const repoUrl = project.github ? `https://github.com/${project.github.fullName}` : null;

  project.productionUrls.forEach((url, index) => {
    const isDown = project === PROBLEMS.siteDown && index === 0;
    addCheck({
      projectId: project.id,
      checkKey: `uptime:${url}`,
      status: isDown ? 'problem' : 'ok',
      summary: isDown
        ? 'HTTP 502 in 184 ms'
        : `200 in ${140 + ((index * 83 + url.length * 7) % 420)} ms`,
      linkUrl: url,
      detail: { label: new URL(url).hostname, at: null, source: 'uptime' },
      problemSince: isDown ? ago(27 * MINUTE_MS) : undefined,
    });
  });

  const repoSource = project.github ? githubSource(project.github.ownerKey) : null;
  if (project.github?.watchDeployments) {
    addCheck({
      projectId: project.id,
      checkKey: 'deploy',
      status: 'ok',
      summary: 'Succeeded',
      linkUrl: `${repoUrl}/deployments`,
      detail: {
        label: 'Deploy',
        at: ago((3 + project.id.length) * HOUR_MS),
        source: repoSource,
        failing: [],
      },
    });
  }

  if (project.github) {
    const isRed = project === PROBLEMS.ciRed;
    addCheck({
      projectId: project.id,
      checkKey: 'ci',
      status: isRed ? 'problem' : 'ok',
      summary: isRed ? 'Failing: Admin tests' : 'Passing',
      linkUrl: `${repoUrl}/actions`,
      detail: {
        label: 'CI',
        at: ago(isRed ? 2 * HOUR_MS : (5 + project.id.length) * HOUR_MS),
        source: repoSource,
      },
      problemSince: isRed ? ago(2 * HOUR_MS) : undefined,
    });

    for (const branch of project.github.extraBranches) {
      addCheck({
        projectId: project.id,
        checkKey: `ci:${branch}`,
        status: 'ok',
        summary: 'Passing',
        linkUrl: `${repoUrl}/actions`,
        detail: {
          label: `CI (${branch})`,
          at: ago((1 + branch.length) * HOUR_MS),
          source: repoSource,
          failing: [],
        },
      });
    }

    const showsChecks = project.github.pullRequestChecks;
    const open = pullRequestsOf(project.id);
    const requested = open.filter((pr) => pr.review).length;
    addCheck({
      projectId: project.id,
      checkKey: 'prs',
      status: 'ok',
      summary:
        open.length === 0 ? 'No open PRs' : `${open.length} open, ${requested} need your review`,
      linkUrl: `${repoUrl}/pulls`,
      detail: {
        pullRequests: open.map((pr, index) => ({
          number: pr.number,
          title: pr.title,
          url: `${repoUrl}/pull/${pr.number}`,
          isReviewRequestedFromMe: pr.review,
          ...(showsChecks ? { checks: MADE_UP_CHECKS[index % MADE_UP_CHECKS.length] } : {}),
        })),
        source: repoSource,
      },
    });
  }

  if (project.supabaseRef) {
    const isPaused = project === PROBLEMS.pausedSupabase;
    addCheck({
      projectId: project.id,
      checkKey: `supabase:${project.supabaseRef}`,
      status: isPaused ? 'problem' : 'ok',
      summary: isPaused ? 'INACTIVE (paused)' : 'Healthy',
      linkUrl: `https://supabase.com/dashboard/project/${project.supabaseRef}`,
      detail: { label: 'Supabase', at: null, source: 'supabase' },
      problemSince: isPaused ? ago(9 * HOUR_MS) : undefined,
    });
  }

  project.cloudflare?.scripts.forEach((script, index) => {
    const isNoisy = script === PROBLEMS.noisyWorker;
    addCheck({
      projectId: project.id,
      checkKey: `worker:${script}`,
      status: isNoisy ? 'problem' : 'ok',
      summary: isNoisy
        ? '14 of 96 failed (14.6%)'
        : index % 3 === 2
          ? 'No requests in 30 min'
          : `0 of ${40 + index * 25} failed (0%)`,
      linkUrl: 'https://dash.cloudflare.com/',
      detail: {
        label: script,
        at: ago((2 + index * 6) * DAY_MS),
        source: cloudflareSource(project.cloudflare?.accountKey ?? ''),
        isOverThreshold: isNoisy,
      },
      problemSince: isNoisy ? ago(35 * MINUTE_MS) : undefined,
    });
  });
}

addCheck({
  projectId: 'unassigned',
  checkKey: 'supabase:zzzzzzzzzzzzzzzzzzzz',
  status: 'ok',
  summary: 'Healthy',
  linkUrl: 'https://supabase.com/dashboard/project/zzzzzzzzzzzzzzzzzzzz',
  detail: { label: 'scratch-experiments', at: null, source: 'supabase' },
});

interface SeedEvent {
  project: string | null;
  check: string;
  kind: string;
  title: string;
  link: string | null;
  at: string;
}

// Events that match the problems above, plus some older history.
const events: SeedEvent[] = [];
const down = PROBLEMS.siteDown;
const downUrl = down?.productionUrls[0];
if (down && downUrl !== undefined) {
  const host = new URL(downUrl).hostname;
  events.push(
    {
      project: down.id,
      check: `uptime:${downUrl}`,
      kind: 'site_down',
      title: `${host} is down (HTTP 502 in 184 ms)`,
      link: downUrl,
      at: ago(27 * MINUTE_MS),
    },
    {
      project: down.id,
      check: `uptime:${downUrl}`,
      kind: 'site_up',
      title: `${host} is back up`,
      link: downUrl,
      at: ago(1 * DAY_MS + 6 * HOUR_MS),
    },
    {
      project: down.id,
      check: `uptime:${downUrl}`,
      kind: 'site_down',
      title: `${host} is down (timed out)`,
      link: downUrl,
      at: ago(1 * DAY_MS + 6 * HOUR_MS + 15 * MINUTE_MS),
    },
  );
}
const red = PROBLEMS.ciRed;
if (red?.github) {
  events.push({
    project: red.id,
    check: 'ci',
    kind: 'ci_red',
    title: `${red.name}: CI on the default branch went red`,
    link: `https://github.com/${red.github.fullName}/actions`,
    at: ago(2 * HOUR_MS),
  });
}
for (const project of withRepo) {
  for (const pr of pullRequestsOf(project.id).filter((item) => item.review)) {
    events.push({
      project: project.id,
      check: `pr:${project.github?.fullName}#${pr.number}`,
      kind: 'review_requested',
      title: `${project.name}: review requested on PR #${pr.number} (${pr.title})`,
      link: `https://github.com/${project.github?.fullName}/pull/${pr.number}`,
      at: ago((5 + (pr.number % 20)) * HOUR_MS),
    });
  }
}
const paused = PROBLEMS.pausedSupabase;
if (paused) {
  events.push({
    project: paused.id,
    check: `supabase:${paused.supabaseRef}`,
    kind: 'supabase_unhealthy',
    title: `${paused.name}: Supabase project not healthy (INACTIVE (paused))`,
    link: `https://supabase.com/dashboard/project/${paused.supabaseRef}`,
    at: ago(9 * HOUR_MS),
  });
}
// A source that has been failing for four runs, so "Needs attention" shows one.
const failingSource = config.githubOwners.at(-1);
if (failingSource) {
  const source = githubSource(failingSource.key);
  events.push({
    project: null,
    check: `source:${source}`,
    kind: 'source_failing',
    title: `${sourceLabel(config, source)} token was rejected (HTTP 401)`,
    link: null,
    at: ago(20 * MINUTE_MS),
  });
}

const lines: string[] = [
  'DELETE FROM unsent_alerts;',
  'DELETE FROM events;',
  'DELETE FROM check_states;',
  'DELETE FROM notified_review_requests;',
  'DELETE FROM source_health;',
  'DELETE FROM run_state;',
];

const observedAt = ago(3 * MINUTE_MS);
for (const check of checks) {
  lines.push(
    `INSERT INTO check_states (project_id, check_key, status, consecutive_failures, summary, link_url, detail_json, problem_since, observed_at) VALUES (${[
      quote(check.projectId),
      quote(check.checkKey),
      quote(check.status),
      check.status === 'problem' ? 2 : 0,
      quote(check.summary),
      quote(check.linkUrl),
      quote(JSON.stringify(check.detail)),
      quote(check.problemSince),
      quote(observedAt),
    ].join(', ')});`,
  );
}

events.forEach((event, index) => {
  lines.push(
    `INSERT INTO events (id, project_id, check_key, kind, title, link_url, occurred_at) VALUES (${[
      quote(`seed-event-${index}`),
      quote(event.project),
      quote(event.check),
      quote(event.kind),
      quote(event.title),
      quote(event.link),
      quote(event.at),
    ].join(', ')});`,
  );
});

// One health row per source of the config: all working, except the GitHub owner whose token
// "was rejected" in the events above. The dashboard shows a source as working only when its
// token is set too (`npm run screenshots` sets placeholder tokens for that).
const failingSourceKey = failingSource ? githubSource(failingSource.key) : null;
for (const { source } of listSources(config)) {
  const isFailing = source === failingSourceKey;
  lines.push(
    `INSERT INTO source_health (source, consecutive_failures, last_error, last_attempt_at, last_success_at) VALUES (${[
      quote(source),
      isFailing ? 4 : 0,
      quote(isFailing ? 'HTTP 401' : null),
      quote(observedAt),
      quote(isFailing ? ago(30 * MINUTE_MS) : observedAt),
    ].join(', ')});`,
  );
}
lines.push(
  `INSERT INTO run_state (id, last_run_started_at, last_run_finished_at) VALUES (1, ${quote(observedAt)}, ${quote(observedAt)});`,
);

const directory = mkdtempSync(join(tmpdir(), 'stackhush-seed-'));
try {
  const file = join(directory, 'seed.sql');
  writeFileSync(file, `${lines.join('\n')}\n`);
  execFileSync('npx', ['wrangler', 'd1', 'execute', DATABASE_BINDING, '--local', '--file', file], {
    encoding: 'utf8',
    timeout: WRANGLER_TIMEOUT_MS,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(`Seeded ${checks.length} checks, ${events.length} events into the local database.`);
