#!/usr/bin/env bash
# CI smoke test: builds the Worker with a small CI-only config, runs it in workerd through
# `vite preview` with no tokens, triggers one scheduled run and checks what it stored:
#
# - source_health has rows (the run happened), and
# - the uptime check of https://example.com starts with "200" (the Worker can make outgoing
#   requests; anything else, such as "unreachable", fails the job).
#
# It replaces stackhush.config.ts, so it only runs where CI=true (GitHub Actions sets it).
set -euo pipefail

if [ "${CI:-}" != "true" ]; then
  echo "CI only: this script overwrites stackhush.config.ts. Run it with CI=true in a scratch clone." >&2
  exit 1
fi

PORT=4173
URL=https://example.com
cd "$(dirname "$0")/../.."

cat > stackhush.config.ts <<'CONFIG'
// Written by .github/ci/smoke.sh: one uptime URL that resolves, no tokens.
import { defineConfig } from './worker/config.ts';

export default defineConfig({
  dashboardUrl: 'https://status.example.com',
  alertTo: 'you@example.com',
  alertFrom: 'stackhush@alerts.example.com',
  groups: ['CI'],
  projects: [{ id: 'ci', name: 'CI', group: 'CI', productionUrls: ['https://example.com'] }],
});
CONFIG

npm run build
npm run db:migrate:local

LOG=$(mktemp)
npx vite preview --port "$PORT" --strictPort > "$LOG" 2>&1 &
PREVIEW_PID=$!
trap 'kill "$PREVIEW_PID" 2> /dev/null || true; rm -f "$LOG"' EXIT

for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/" > /dev/null && break
  sleep 1
done
curl -sf "http://localhost:$PORT/cdn-cgi/handler/scheduled" > /dev/null

query() {
  npx wrangler d1 execute DB --local --json --command "$1"
}

# The scheduled handler returns before the run has written everything; wait for it.
HEALTH=""
for _ in $(seq 1 30); do
  HEALTH=$(query "SELECT source, last_error FROM source_health")
  echo "$HEALTH" | grep -q '"source"' && break
  sleep 1
done
echo "$HEALTH"
if ! echo "$HEALTH" | grep -q '"source"'; then
  echo "No source_health rows: the scheduled run did not happen" >&2
  cat "$LOG"
  exit 1
fi

SUMMARY=""
for _ in $(seq 1 30); do
  SUMMARY=$(query "SELECT summary FROM check_states WHERE check_key = 'uptime:$URL'")
  echo "$SUMMARY" | grep -q '"summary"' && break
  sleep 1
done
echo "$SUMMARY"
if ! echo "$SUMMARY" | grep -q '"summary": *"200 '; then
  echo "The uptime check of $URL did not return 200: the Worker could not make outgoing requests" >&2
  cat "$LOG"
  exit 1
fi
echo "Smoke test passed."
