#!/usr/bin/env bash
# One-time wiring for the Cyrus relay Vercel project:
#   1. connect the cyrus-relay-queue blob store (injects BLOB_READ_WRITE_TOKEN)
#   2. create RELAY_SECRET (shared with the Mac-side drain script)
# Idempotent: re-running reuses the existing secret from ~/.cyrus/.env.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${CYRUS_RELAY_ENV_FILE:-$HOME/Broadwayscore/.env}"
TOKEN="$(grep '^VERCEL_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
TEAM=team_zvgatcxkXdPbfhtHQMOnjpXo
STORE=store_R127nbWWlYlJfDFd
PROJECT_ID="$(python3 -c "import json;print(json.load(open('$HERE/.vercel/project.json'))['projectId'])")"

echo "projectId=$PROJECT_ID"

echo "--- connect blob store ---"
curl -s -X POST "https://api.vercel.com/v1/storage/stores/$STORE/connections?teamId=$TEAM" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID\",\"envVarEnvironments\":[\"production\",\"preview\",\"development\"]}" \
  | head -c 600
echo

CYRUS_ENV="$HOME/.cyrus/.env"
if grep -q '^CYRUS_RELAY_SECRET=' "$CYRUS_ENV" 2>/dev/null; then
  SECRET="$(grep '^CYRUS_RELAY_SECRET=' "$CYRUS_ENV" | cut -d= -f2-)"
  echo "--- reusing existing RELAY_SECRET ---"
else
  SECRET="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
  printf '\n# Shared secret for the Vercel webhook relay (tools/cyrus-relay)\nCYRUS_RELAY_SECRET=%s\n' "$SECRET" >> "$CYRUS_ENV"
  echo "--- generated RELAY_SECRET, appended to $CYRUS_ENV ---"
fi

echo "--- set RELAY_SECRET on project ---"
for TARGET in production preview development; do
  curl -s -X POST "https://api.vercel.com/v10/projects/$PROJECT_ID/env?teamId=$TEAM&upsert=true" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"key\":\"RELAY_SECRET\",\"value\":\"$SECRET\",\"type\":\"encrypted\",\"target\":[\"$TARGET\"]}" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  '"$TARGET"':", "ok" if "created" in d or "id" in str(d) else d)'
done
