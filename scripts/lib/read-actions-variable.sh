#!/usr/bin/env bash
# BRO-6639: read a repo Actions variable without failing open.
# Usage: GH_TOKEN=<token with variables:read, i.e. REVIEW_TEXTS_TOKEN> read-actions-variable.sh NAME
#   exit 0, stdout=value   variable exists
#   exit 0, stdout empty   variable absent (HTTP 404) -> genuinely "not set"
#   exit 3, stdout empty   read FAILED (403 from GITHUB_TOKEN, 5xx, network) -> UNKNOWN.
#                          Callers must not treat this as "not paused".
# BRO-6643: optional READ_ATTEMPTS (default 1) retries the UNKNOWN case only,
# READ_RETRY_SLEEP seconds apart (default 5). Success and 404 return at once.
set -u
NAME="${1:?variable name required}"
REPO="${GITHUB_REPOSITORY:-thomaspryor/Broadwayscore}"
ATTEMPTS="${READ_ATTEMPTS:-1}"
case "$ATTEMPTS" in ''|*[!0-9]*|0) ATTEMPTS=1 ;; esac
SLEEP_S="${READ_RETRY_SLEEP:-5}"
case "$SLEEP_S" in ''|*[!0-9]*) SLEEP_S=5 ;; esac
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT
i=1
while :; do
  if OUT=$(gh api "repos/${REPO}/actions/variables/${NAME}" --jq '.value' 2>"$ERR"); then
    printf '%s' "$OUT"
    exit 0
  fi
  if grep -qE 'HTTP 404' "$ERR"; then
    exit 0
  fi
  [ "$i" -ge "$ATTEMPTS" ] && break
  i=$((i + 1))
  sleep "$SLEEP_S"
done
echo "::warning::Could not read Actions variable ${NAME} after ${ATTEMPTS} attempt(s) (state UNKNOWN, not 'unset'): $(tr '\n' ' ' < "$ERR" | cut -c1-200)" >&2
exit 3
