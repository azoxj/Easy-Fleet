#!/usr/bin/env bash
# Builds the release tarball that deploy.sh installs: compiled server, migrations, built web app, lockfile.
# Run from the repository root after `npm ci`. Output: dist-release/easy-fleet-<git short sha>.tgz (+ .sha256).
set -euo pipefail
cd "$(dirname "$0")/../.."
npm run build
sha="$(git rev-parse --short HEAD 2>/dev/null || echo local)"
out="dist-release"
mkdir -p "$out"
tar -czf "$out/easy-fleet-$sha.tgz" \
  package.json package-lock.json \
  server/package.json server/dist server/drizzle \
  web/package.json web/dist \
  deploy docs
( cd "$out" && sha256sum "easy-fleet-$sha.tgz" > "easy-fleet-$sha.tgz.sha256" )
echo "built $out/easy-fleet-$sha.tgz"
