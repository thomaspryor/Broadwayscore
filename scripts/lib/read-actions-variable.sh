#!/usr/bin/env bash
# BRO-6639: read a repo Actions variable without failing open.
# Usage: GH_TOKEN=<token with variables:read, i.e. REVIEW_TEXTS_TOKEN> read-actions-variable.sh NAME
#   exit 0, stdout=value   variable exists
#   exit 0, stdout empty   variable absent (HTTP 404) -> genuinely "not set"
#   exit 3, stdout empty   read FAILED (403 from GITHUB_TOKEN, 5xx, network) -> UNKNOWN.
#                          Callers must not treat this as "not paused".
set -u
NAME="${1:?variable name required}"
REPO="${GITHUB_REPOSITORY:-thomaspryor/Broadwayscore}"
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT
if OUT=$(gh api "repos/${REPO}/actions/variables/${NAME}" --jq '.value' 2>"$ERR"); then
  printf '%s' "$OUT"
  exit 0
fi
if grep -qE 'HTTP 404' "$ERR"; then
  exit 0
fi
echo "::warning::Could not read Actions variable ${NAME} (state UNKNOWN, not 'unset'): $(tr '\n' ' ' < "$ERR" | cut -c1-200)" >&2
exit 3
