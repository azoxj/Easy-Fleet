#!/usr/bin/env bash
# Writes the secrets of one AWS Secrets Manager secret to /run/easy-fleet/secrets/<NAME> (tmpfs, 0640 root:easyfleet),
# one file per key, so the app reads them through NAME_FILE=… (see easy-fleet.env.example). Nothing is printed.
#
#   The secret value is a JSON object, e.g.
#     {"DATABASE_URL":"postgres://…","EMAIL_SETTINGS_KEY":"…","SMTP_USER":"…","SMTP_PASSWORD":"…",
#      "BRIGHT_WASHING_INTEGRATION_ID":"int_…","BRIGHT_WASHING_API_SECRET":"…"}
#
# Needs: awscli v2, jq, and an instance role allowed secretsmanager:GetSecretValue on that one secret.
# Run as root (systemd: ExecStartPre=+…). Configure with environment variables:
#   EF_SECRET_ID (default easy-fleet/prod)   AWS_REGION   EF_SECRETS_DIR (default /run/easy-fleet/secrets)
set -euo pipefail
umask 027

SECRET_ID="${EF_SECRET_ID:-easy-fleet/prod}"
DIR="${EF_SECRETS_DIR:-/run/easy-fleet/secrets}"
GROUP="${EF_GROUP:-easyfleet}"
# Only these names are ever written (they are the ones the app can read from NAME_FILE).
ALLOWED='DATABASE_URL EMAIL_SETTINGS_KEY SMTP_USER SMTP_PASSWORD BRIGHT_WASHING_INTEGRATION_ID BRIGHT_WASHING_API_SECRET BOOTSTRAP_ADMIN_PASSWORD'

install -d -m 0750 -o root -g "$GROUP" "$DIR"
json="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --query SecretString --output text)"

for name in $ALLOWED; do
  if jq -e --arg k "$name" 'has($k)' >/dev/null <<<"$json"; then
    tmp="$(mktemp "$DIR/.tmp.XXXXXX")"
    jq -j --arg k "$name" '.[$k]' <<<"$json" >"$tmp"
    chown root:"$GROUP" "$tmp"
    chmod 0640 "$tmp"
    mv -f "$tmp" "$DIR/$name"
  fi
done
unset json
echo "easy-fleet: secrets refreshed in $DIR ($(find "$DIR" -type f | wc -l) files)"
