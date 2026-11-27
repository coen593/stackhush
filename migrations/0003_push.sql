-- Push notifications (Web Push) for the dashboard installed on a phone. Timestamps as in 0001.
-- Additive only: nothing here changes what 0001 and 0002 store.

-- One row per browser that turned notifications on. At most 10 are kept (worker/push.ts): when
-- an 11th arrives, the oldest goes. A row is deleted when its browser turns notifications off
-- and when the push service says the subscription no longer exists (404 or 410).
-- Nothing here is a secret of the Worker: the endpoint and keys are made by the browser, and a
-- push service only accepts messages for an endpoint that are signed with the Worker's VAPID
-- private key, which lives in a secret and never in this database.
CREATE TABLE push_subscriptions (
  -- The push service URL of this browser, always https.
  endpoint TEXT PRIMARY KEY,
  -- The browser's P-256 public key (65 bytes, uncompressed) and its 16-byte auth secret, both
  -- base64url as the browser gives them. Messages are encrypted to them (RFC 8291).
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- Sends in a row that the push service did not accept; back to 0 at the next accepted one.
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The rate limit on "Send test notification": one row per request that set out to send,
-- counted over the last hour. Kept one hour.
CREATE TABLE push_test_sends (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- How many stored subscriptions the last run had no subrequest left for (each push is one
-- subrequest, see docs/limits.md). Above 0 the dashboard shows a problem. A Worker from before
-- this migration never reads or writes the column.
ALTER TABLE run_state ADD COLUMN push_short INTEGER NOT NULL DEFAULT 0;
