#!/usr/bin/env bash
# Push the LINEAR_WEBHOOK_SECRET from ~/.cyrus/.env onto the Vercel relay so
# both ends verify the same signature. Run after changing the secret locally,
# then redeploy with ./deploy.sh deploy.
set -euo pipefail

ENV_FILE="${CYRUS_RELAY_ENV_FILE:-$HOME/Broadwayscore/.env}"
TOKEN="$(grep '^VERCEL_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
TEAM=team_zvgatcxkXdPbfhtHQMOnjpXo
PROJECT_ID=prj_1luSCgitVs1gQCBydiSuYU4pesjP
SECRET="$(grep '^LINEAR_WEBHOOK_SECRET=' "$HOME/.cyrus/.env" | cut -d= -f2- | tr -d '"')"

if [ -z "$SECRET" ]; then
  echo "LINEAR_WEBHOOK_SECRET missing from ~/.cyrus/.env" >&2
  exit 1
fi

for TARGET in production preview development; do
  curl -s -X POST "https://api.vercel.com/v10/projects/$PROJECT_ID/env?teamId=$TEAM&upsert=true" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"key\":\"LINEAR_WEBHOOK_SECRET\",\"value\":\"$SECRET\",\"type\":\"encrypted\",\"target\":[\"$TARGET\"]}" \
    > /dev/null
  echo "  $TARGET: set"
done
