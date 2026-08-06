#!/usr/bin/env bash
# Trigger one of the app's authenticated cron endpoints from any scheduler
# (GitHub Actions, crontab, systemd timer, ...).
#
# Usage:
#   APP_BASE_URL=https://host CRON_SECRET=... scripts/trigger-cron.sh <endpoint> [max-time-seconds]
#
# Endpoints: refresh-catalog | sync-goldensneakers | pull-store
set -euo pipefail

endpoint="${1:?usage: trigger-cron.sh <refresh-catalog|sync-goldensneakers|pull-store> [max-time-seconds]}"
max_time="${2:-900}"

: "${APP_BASE_URL:?APP_BASE_URL is required (e.g. https://store-hub.example.com)}"
: "${CRON_SECRET:?CRON_SECRET is required}"

url="${APP_BASE_URL%/}/api/cron/${endpoint}"
echo "POST ${url}" >&2

# --retry only re-sends on transient failures (connection errors, 429, 5xx);
# every endpoint is idempotent (upsert / stale-queue based), so a re-send is safe.
curl -sS -X POST \
  --connect-timeout 15 \
  --max-time "${max_time}" \
  --retry 3 --retry-delay 10 --retry-connrefused \
  --fail-with-body \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${url}"
echo
