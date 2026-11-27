-- Timestamps are ISO 8601 UTC strings in the same format as JavaScript's toISOString(),
-- so values written by SQL defaults and by the Worker compare correctly as text.

-- Access ---------------------------------------------------------------------------------------

-- One-time sign-in codes made by `npm run signin-link`. Only the SHA-256 of the code is stored,
-- so reading this table does not let anyone sign in.
CREATE TABLE signin_codes (
  code_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  -- Set when the code is swapped for a session; a used code never works again.
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Signed-in browsers. Only the SHA-256 of the cookie value is stored. Deleting a row signs
-- that browser out; `DELETE FROM sessions` signs out everywhere.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Checks ---------------------------------------------------------------------------------------

-- The current state of one check of one project. A row is only rewritten when something about
-- the check changed, and deleted when its source stops reporting the check.
-- project_id is a registry id, or 'unassigned' for Supabase projects the token sees that are
-- not in the registry. check_key names the check within the project, for example
-- 'uptime:https://example.com', 'ci', 'deploy', 'prs', 'supabase:<ref>', 'worker:<script>'.
CREATE TABLE check_states (
  project_id TEXT NOT NULL,
  check_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'problem', 'unknown')),
  -- Consecutive failed observations, for checks that only count as down after several
  -- (uptime: down after 2 failed runs).
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- Short line for the dashboard, for example '200 in 312 ms' or 'INACTIVE'.
  summary TEXT NOT NULL,
  -- Where the dashboard and the alert email link to (GitHub run, PR, Supabase project, ...).
  link_url TEXT,
  -- Check-specific details as JSON: the label, the source that reported the check
  -- ('uptime', 'github:personal', ...), open PRs, and what the source needs back next run
  -- (failing workflows, failing deploy environments, the last Worker threshold reading).
  detail_json TEXT NOT NULL DEFAULT '{}',
  -- When the check last went from ok to problem; null while ok.
  problem_since TEXT,
  -- When the row was last written, which is when the check last changed.
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, check_key)
);

-- PRs whose review request from the owner was already alerted, so each one fires once.
CREATE TABLE notified_review_requests (
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo, pr_number)
);

-- Every transition, kept 90 days. The dashboard shows the latest 50.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  -- Registry id, 'unassigned', or null for a transition about a source (a rejected token).
  project_id TEXT,
  check_key TEXT NOT NULL,
  -- Transition kind, for example 'site_down', 'site_up', 'ci_red', 'ci_green'.
  kind TEXT NOT NULL,
  -- One line naming the change, for the email and the dashboard.
  title TEXT NOT NULL,
  link_url TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_events_occurred_at ON events (occurred_at);

-- Transitions not yet emailed. A row is deleted only after the Cloudflare Email Service binding
-- accepted the email, so a failed send is retried on the next run instead of dropped.
CREATE TABLE unsent_alerts (
  event_id TEXT PRIMARY KEY REFERENCES events (id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Runs -----------------------------------------------------------------------------------------

-- A single row about the cron runs. No row yet means the next run is the first one, which
-- seeds check_states without sending email.
CREATE TABLE run_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_started_at TEXT NOT NULL,
  last_run_finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Health of each data source (one per token or API), for "source failing 3 runs in a row".
-- source is for example 'uptime', 'github:personal', 'supabase', 'cloudflare:main'.
CREATE TABLE source_health (
  source TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- Safe-to-show reason for the last failure, for example 'HTTP 401' or 'timed out'.
  -- Never a header, token or raw response body.
  last_error TEXT,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
