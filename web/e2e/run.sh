#!/usr/bin/env bash
# Browser tests for the accident screens on a LOCAL throw-away database (never touches anything else).
#   web/e2e/run.sh            seeds ef_e2e, starts the server twice (workflow off, then on) and runs the Playwright checks
# Needs: a local PostgreSQL with the role/database named below, Playwright's Chromium (preinstalled in the dev container).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="${E2E_DATABASE_URL:-postgres://eftest:eftest@localhost:5432/ef_e2e}"
case "$DB" in *localhost*|*127.0.0.1*) ;; *) echo "refusing: E2E database must be local" >&2; exit 2;; esac
case "$DB" in *e2e*|*test*) ;; *) echo "refusing: E2E database name must contain e2e or test" >&2; exit 2;; esac
PORT=4010
export E2E_BASE="http://localhost:$PORT"
mkdir -p /tmp/claude-0/e2e/storage
run_server() {
  (cd "$ROOT/server" && env DATABASE_URL="$DB" NODE_ENV=development PORT=$PORT COOKIE_SECURE=false APP_ORIGINS="$E2E_BASE" STORAGE_DIR=/tmp/claude-0/e2e/storage \
    SCRYPT_LOG_N=12 WEB_DIST_DIR="$ROOT/web/dist" ACCIDENT_WORKFLOW_ENABLED="$1" ACCIDENT_LEGACY_SENSITIVE_ENFORCEMENT=false LOG_REQUESTS=false \
    npx tsx src/index.ts >/tmp/claude-0/e2e/server-$1.log 2>&1) &
  echo $! >/tmp/claude-0/e2e/server.pid
  for _ in $(seq 1 60); do curl -fs "$E2E_BASE/api/healthz" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "server did not start" >&2; tail -20 /tmp/claude-0/e2e/server-$1.log >&2; return 1
}
stop_server() { pkill -f "[t]sx src/index.ts" 2>/dev/null || true; sleep 1; }
trap stop_server EXIT
(cd "$ROOT/server" && DATABASE_URL="$DB" SCRYPT_LOG_N=12 NODE_ENV=development npx tsx ../web/e2e/seed.ts)
run_server false; node "$ROOT/web/e2e/accidents.e2e.cjs" off; stop_server
run_server true; node "$ROOT/web/e2e/accidents.e2e.cjs" on; stop_server
# acceptance run on a fresh database (the previous run changed officers and settings)
(cd "$ROOT/server" && DATABASE_URL="$DB" SCRYPT_LOG_N=12 NODE_ENV=development npx tsx ../web/e2e/seed.ts)
run_server true; E2E_DATABASE_URL="$DB" node "$ROOT/web/e2e/accidents.e2e.cjs" accept; stop_server
