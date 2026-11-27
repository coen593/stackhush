-- Sign-in by email (see BRIEF.md, "Email sign-in"). Timestamps as in 0001.

-- One row per press of "Email me a sign-in code". The email carries two codes: a short one typed
-- into the browser that asked, and a 256-bit one in a link (a signin_codes row, used through the
-- existing exchange). Nothing here lets a reader of the table sign in:
-- request_hash is the SHA-256 of the request id, which lives only in that browser's cookie;
-- short_code_hash is the SHA-256 of the request id and the short code together, so the short
-- code (about 40 bits) cannot be worked out from this table without the cookie either.
CREATE TABLE signin_requests (
  request_hash TEXT PRIMARY KEY,
  short_code_hash TEXT NOT NULL,
  -- The link code of the same email. No foreign key: the cron run deletes expired rows of both
  -- tables independently, and a dangling hash is harmless.
  link_code_hash TEXT NOT NULL,
  -- Wrong short codes typed so far. At the cap the request stops accepting codes.
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  -- Set when either code of the request was swapped for a session; then both are dead.
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The rate limit on sign-in emails: one row per email the Worker set out to send, counted over
-- the last hour and the last 24 hours. A row is written before sending and stays if the send
-- fails, so a failing email service cannot be used to get around the cap. Kept 24 hours.
CREATE TABLE signin_email_sends (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
