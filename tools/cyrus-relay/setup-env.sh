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

# Every call here is checked. A silent failure connecting the blob store leaves
# the relay with nowhere to put deliveries — it 500s on every webhook — and a
# setup script that printed nothing would look like it had worked.
fail_on_api_error() {
  local what="$1" resp="$2"
  if printf '%s' "$resp" | jq -e '.error' > /dev/null 2>&1; then
    echo "  $what: FAILED — $(printf '%s' "$resp" | jq -r '.error.message // .error')" >&2
    exit 1
  fi
}

echo "--- connect blob store ---"
RESP="$(curl -s -X POST "https://api.vercel.com/v1/storage/stores/$STORE/connections?teamId=$TEAM" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$PROJECT_ID" '{projectId:$p, envVarEnvironments:["production","preview","development"]}')")"
fail_on_api_error "blob store connection" "$RESP"
echo "  connected"

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
  BODY="$(jq -n --arg v "$SECRET" --arg t "$TARGET" \
    '{key:"RELAY_SECRET", value:$v, type:"encrypted", target:[$t]}')"
  RESP="$(curl -s -X POST "https://api.vercel.com/v10/projects/$PROJECT_ID/env?teamId=$TEAM&upsert=true" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY")"
  fail_on_api_error "$TARGET" "$RESP"
  echo "  $TARGET: set"
done
