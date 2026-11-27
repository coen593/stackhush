// D1 reads and writes for a cron run. The decisions live in transitions.ts; this only moves rows.

import type { AlertEvent } from './alerts.ts';
import {
  checkStateKey,
  type CheckWrite,
  type PreviousCheck,
  type PreviousSourceHealth,
  type Removal,
  type ReviewRequestKey,
  reviewRequestKey,
  type SourceHealthWrite,
  type Transition,
} from './transitions.ts';

export const EVENT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Records that a run started, and whether it is the first one (none has ever finished). */
export async function startRun(db: D1Database, now: string): Promise<{ isFirstRun: boolean }> {
  const row = await db
    .prepare('SELECT last_run_finished_at FROM run_state WHERE id = 1')
    .first<{ last_run_finished_at: string | null }>();
  await db
    .prepare(
      `INSERT INTO run_state (id, last_run_started_at) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET last_run_started_at = excluded.last_run_started_at, updated_at = excluded.last_run_started_at`,
    )
    .bind(now)
    .run();
  // Keyed on "finished", not on the row existing: a first run that crashed halfway is still first.
  return { isFirstRun: row?.last_run_finished_at == null };
}

export async function finishRun(db: D1Database, now: string): Promise<void> {
  await db
    .prepare('UPDATE run_state SET last_run_finished_at = ?, updated_at = ? WHERE id = 1')
    .bind(now, now)
    .run();
}

export async function loadPreviousChecks(db: D1Database): Promise<Map<string, PreviousCheck>> {
  const { results } = await db
    .prepare(
      'SELECT project_id, check_key, status, consecutive_failures, summary, link_url, detail_json, problem_since FROM check_states',
    )
    .all<{
      project_id: string;
      check_key: string;
      status: PreviousCheck['status'];
      consecutive_failures: number;
      summary: string;
      link_url: string | null;
      detail_json: string;
      problem_since: string | null;
    }>();
  return new Map(
    results.map((row) => [
      checkStateKey(row.project_id, row.check_key),
      {
        projectId: row.project_id,
        checkKey: row.check_key,
        status: row.status,
        consecutiveFailures: row.consecutive_failures,
        summary: row.summary,
        linkUrl: row.link_url,
        detail: parseDetail(row.detail_json),
        problemSince: row.problem_since,
      },
    ]),
  );
}

/** Reads a detail_json column. Anything that is not a JSON object counts as empty. */
export function parseDetail(detailJson: string): Record<string, unknown> {
  try {
    const detail: unknown = JSON.parse(detailJson);
    return typeof detail === 'object' && detail !== null && !Array.isArray(detail)
      ? (detail as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function loadPreviousSourceHealth(
  db: D1Database,
): Promise<Map<string, PreviousSourceHealth>> {
  const { results } = await db
    .prepare('SELECT source, consecutive_failures, last_success_at FROM source_health')
    .all<{ source: string; consecutive_failures: number; last_success_at: string | null }>();
  return new Map(
    results.map((row) => [
      row.source,
      { consecutiveFailures: row.consecutive_failures, lastSuccessAt: row.last_success_at },
    ]),
  );
}

export async function loadNotifiedReviewRequests(db: D1Database): Promise<Set<string>> {
  const { results } = await db
    .prepare('SELECT repo, pr_number FROM notified_review_requests')
    .all<{ repo: string; pr_number: number }>();
  return new Set(results.map((row) => reviewRequestKey(row.repo, row.pr_number)));
}

export interface RunWrites {
  checks: readonly CheckWrite[];
  health: readonly SourceHealthWrite[];
  /** Every source of the config. Health rows of any other source are leftovers and are deleted. */
  knownSources: readonly string[];
  transitions: readonly Transition[];
  newReviewRequests: readonly ReviewRequestKey[];
  /** Checks nothing reports any more. Only ever from sources that worked this run. */
  removals: readonly Removal[];
  now: string;
}

/** The kind of the event written when a check's row is deleted. No email goes out for it. */
export const REMOVED_EVENT_KIND = 'check_removed';

/** Saves one run's results in one transaction: state, events and the alerts still to send. */
export async function saveRun(db: D1Database, writes: RunWrites): Promise<void> {
  const { now } = writes;
  const statements: D1PreparedStatement[] = [];

  for (const check of writes.checks) {
    statements.push(
      db
        .prepare(
          `INSERT INTO check_states (project_id, check_key, status, consecutive_failures, summary, link_url, detail_json, problem_since, observed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, check_key) DO UPDATE SET
             status = excluded.status, consecutive_failures = excluded.consecutive_failures,
             summary = excluded.summary, link_url = excluded.link_url, detail_json = excluded.detail_json,
             problem_since = excluded.problem_since, observed_at = excluded.observed_at, updated_at = excluded.updated_at`,
        )
        .bind(
          check.projectId,
          check.checkKey,
          check.status,
          check.consecutiveFailures,
          check.summary,
          check.linkUrl,
          JSON.stringify(check.detail),
          check.problemSince,
          check.observedAt,
          now,
        ),
    );
  }

  for (const health of writes.health) {
    statements.push(
      db
        .prepare(
          `INSERT INTO source_health (source, consecutive_failures, last_error, last_attempt_at, last_success_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (source) DO UPDATE SET
             consecutive_failures = excluded.consecutive_failures, last_error = excluded.last_error,
             last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at,
             updated_at = excluded.updated_at`,
        )
        .bind(
          health.source,
          health.consecutiveFailures,
          health.lastError,
          health.lastAttemptAt,
          health.lastSuccessAt,
          now,
        ),
    );
  }

  // A row for a source the config does not have is a leftover (a renamed or removed source)
  // that would otherwise stay "failing" for good.
  if (writes.knownSources.length > 0) {
    const placeholders = writes.knownSources.map(() => '?').join(', ');
    statements.push(
      db
        .prepare(`DELETE FROM source_health WHERE source NOT IN (${placeholders})`)
        .bind(...writes.knownSources),
    );
  }

  for (const removal of writes.removals) {
    statements.push(
      db
        .prepare('DELETE FROM check_states WHERE project_id = ? AND check_key = ?')
        .bind(removal.projectId, removal.checkKey),
      // An event but no unsent_alerts row: it shows on the dashboard and is not emailed.
      db
        .prepare(
          `INSERT INTO events (id, project_id, check_key, kind, title, link_url, occurred_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          removal.projectId,
          removal.checkKey,
          REMOVED_EVENT_KIND,
          removal.title,
          now,
        ),
    );
  }

  for (const transition of writes.transitions) {
    const id = crypto.randomUUID();
    statements.push(
      db
        .prepare(
          `INSERT INTO events (id, project_id, check_key, kind, title, link_url, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          transition.projectId,
          transition.checkKey,
          transition.kind,
          transition.title,
          transition.linkUrl,
          transition.occurredAt,
        ),
      db.prepare('INSERT INTO unsent_alerts (event_id) VALUES (?)').bind(id),
    );
  }

  for (const request of writes.newReviewRequests) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO notified_review_requests (repo, pr_number) VALUES (?, ?)')
        .bind(request.repo, request.prNumber),
    );
  }

  // Events older than the retention go, except ones whose alert was never sent: those wait for
  // a send to succeed (unsent_alerts cascades from events, so deleting them would drop the alert).
  const cutoff = new Date(new Date(now).getTime() - EVENT_RETENTION_DAYS * DAY_MS).toISOString();
  statements.push(
    db
      .prepare(
        'DELETE FROM events WHERE occurred_at < ? AND id NOT IN (SELECT event_id FROM unsent_alerts)',
      )
      .bind(cutoff),
  );

  await db.batch(statements);
}

export async function loadUnsentAlerts(db: D1Database): Promise<AlertEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT events.id, events.title, events.link_url, events.occurred_at
       FROM unsent_alerts JOIN events ON events.id = unsent_alerts.event_id
       ORDER BY events.occurred_at, events.id`,
    )
    .all<{ id: string; title: string; link_url: string | null; occurred_at: string }>();
  return results.map((row) => ({
    id: row.id,
    title: row.title,
    linkUrl: row.link_url,
    occurredAt: row.occurred_at,
  }));
}

/** Called only after the email service accepted the message. */
export async function markAlertsSent(db: D1Database, eventIds: readonly string[]): Promise<void> {
  await db.batch(
    eventIds.map((id) => db.prepare('DELETE FROM unsent_alerts WHERE event_id = ?').bind(id)),
  );
}

export async function markAlertsFailed(
  db: D1Database,
  eventIds: readonly string[],
  now: string,
): Promise<void> {
  await db.batch(
    eventIds.map((id) =>
      db
        .prepare(
          'UPDATE unsent_alerts SET attempts = attempts + 1, last_attempt_at = ?, updated_at = ? WHERE event_id = ?',
        )
        .bind(now, now, id),
    ),
  );
}
