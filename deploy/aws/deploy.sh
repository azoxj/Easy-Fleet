#!/usr/bin/env bash
# Release and rollback of Easy Fleet on one EC2 host (systemd + releases directory). Run as root.
#
#   CONFIRM_BACKUP=yes ./deploy.sh release /tmp/easy-fleet-<version>.tgz [sha256]
#   ./deploy.sh rollback
#   ./deploy.sh status
#
# Layout:  /opt/easy-fleet/releases/<timestamp>/…   /opt/easy-fleet/current -> releases/<timestamp>
# A release = the tarball built by CI (server/dist, server/drizzle, server/package.json, web/dist, package*.json, deploy/, docs/).
# Order: unpack → npm ci (production deps) → database migrations → switch symlink → restart → readiness check →
# automatic rollback of the CODE if the new version does not become ready.
# Migrations are forward-only and additive; the code rollback is safe for them. A migration that is not additive needs a
# restore from the RDS snapshot you take before releasing — hence CONFIRM_BACKUP=yes.
set -euo pipefail

APP_DIR="${EF_APP_DIR:-/opt/easy-fleet}"
USER_NAME="${EF_USER:-easyfleet}"
ENV_FILE="${EF_ENV_FILE:-/etc/easy-fleet/easy-fleet.env}"
SERVICE="${EF_SERVICE:-easy-fleet}"
READY_URL="${EF_READY_URL:-http://127.0.0.1:4000/api/readyz}"
KEEP="${EF_KEEP_RELEASES:-5}"
RELEASES="$APP_DIR/releases"
CURRENT="$APP_DIR/current"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"

wait_ready() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 4 "$READY_URL" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

switch_to() {
  ln -sfn "$1" "$CURRENT.new"
  mv -T "$CURRENT.new" "$CURRENT"
}

cmd_status() {
  log "current: $(readlink -f "$CURRENT" 2>/dev/null || echo none)"
  ls -1 "$RELEASES" 2>/dev/null | tail -n "$KEEP"
  systemctl is-active "$SERVICE" || true
  curl -fsS --max-time 4 "$READY_URL" || true; echo
}

cmd_rollback() {
  [ -L "$CURRENT" ] || die "no current release"
  local cur prev
  cur="$(readlink -f "$CURRENT")"
  prev="$(ls -1d "$RELEASES"/*/ 2>/dev/null | sed 's#/$##' | grep -vx "$cur" | sort | tail -n 1 || true)"
  [ -n "$prev" ] || die "no previous release to roll back to"
  log "rolling back $cur -> $prev"
  switch_to "$prev"
  systemctl restart "$SERVICE"
  wait_ready || die "previous release did not become ready either — check: journalctl -u $SERVICE -n 100"
  log "rolled back to $prev"
}

cmd_release() {
  local tarball="${1:-}" sha="${2:-}"
  [ -f "$tarball" ] || die "usage: deploy.sh release <tarball> [sha256]"
  [ "${CONFIRM_BACKUP:-}" = "yes" ] || die "take an RDS snapshot first, then run with CONFIRM_BACKUP=yes"
  [ -r "$ENV_FILE" ] || die "$ENV_FILE not found"
  if [ -n "$sha" ]; then
    echo "$sha  $tarball" | sha256sum -c - >/dev/null || die "sha256 mismatch"
  fi

  local ts dest previous
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="$RELEASES/$ts"
  previous="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  install -d -m 0755 "$dest"
  tar -xzf "$tarball" -C "$dest"
  [ -f "$dest/server/dist/index.js" ] || die "tarball has no server/dist/index.js"
  [ -f "$dest/web/dist/index.html" ] || die "tarball has no web/dist/index.html"

  log "installing production dependencies"
  (cd "$dest" && npm ci --omit=dev -w server --ignore-scripts --no-audit --no-fund)
  chown -R root:root "$dest"
  chmod -R go-w "$dest"

  # Secrets (when Secrets Manager is used): refresh the files the env file points at.
  if [ -x "$dest/deploy/aws/fetch-secrets.sh" ] && grep -q '_FILE=/run/easy-fleet/secrets' "$ENV_FILE"; then
    log "refreshing secrets"
    "$dest/deploy/aws/fetch-secrets.sh" >/dev/null
  fi

  log "running database migrations (forward-only, advisory-locked, one transaction)"
  sudo -u "$USER_NAME" bash -c "set -a; . '$ENV_FILE'; set +a; cd '$dest/server' && node dist/scripts/migrate.js && node dist/scripts/bootstrap.js"

  log "switching to $ts"
  switch_to "$dest"
  systemctl restart "$SERVICE"
  if wait_ready; then
    log "release $ts is ready"
  else
    log "release $ts did NOT become ready"
    if [ -n "$previous" ] && [ -d "$previous" ]; then
      switch_to "$previous"
      systemctl restart "$SERVICE"
      wait_ready && log "rolled the code back to $previous (schema stays migrated; migrations are additive)" || log "previous release is not ready either: journalctl -u $SERVICE -n 100"
    fi
    exit 1
  fi

  # keep the newest $KEEP releases
  ls -1d "$RELEASES"/*/ | sed 's#/$##' | sort | head -n -"$KEEP" | xargs -r rm -rf
}

case "${1:-}" in
  release) shift; cmd_release "$@" ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  *) die "usage: deploy.sh release <tarball> [sha256] | rollback | status" ;;
esac
