#!/bin/bash
# gh-api-wrapper.sh — single logging chokepoint for DIRECT HTTP calls to
# api.github.com (curl/fetch/https.request), as opposed to `gh` CLI calls
# (already instrumented by gh-call-wrapper.sh, task #821).
#
# WHY (task #821 follow-up, BRO-134): the #821 incident's ledger showed only
# ~70 real API-consuming `gh` CLI calls in the 20-minute window where quota
# went from thousands to 0 — gh CLI usage was NOT the dominant burner. The
# actual burn is almost certainly direct fetch()/https.request()/curl calls
# to api.github.com made from Node scripts, each of which had its own
# hand-rolled fetchJSON()/apiGet()/httpsGet() helper (dozens of near-
# duplicate implementations across scripts/, none of them logged anywhere).
# There was no way to attribute WHICH script made WHICH direct API call.
#
# This script is that attribution point. It is used two ways:
#   1. Sourced/called by shell scripts that curl api.github.com directly.
#   2. Shelled out to by scripts/lib/gh-api-client.js (the centralized Node
#      fetchJSON replacement) so every direct-HTTP GitHub API call — Node or
#      shell — lands in ONE shared ledger, regardless of caller language.
#
# Usage:
#   scripts/lib/gh-api-wrapper.sh log <caller> <method> <url>
#     Append a ledger line only (used by gh-api-client.js before its own
#     fetch() call, and by any shell script that wants attribution without
#     also delegating the HTTP call itself).
#   scripts/lib/gh-api-wrapper.sh curl <caller> <url> [curl-args...]
#     Log + perform the GET via curl, with GH_TOKEN/GITHUB_TOKEN auth
#     injected automatically. Prints the response body to stdout.
#
# Logs to ~/.claude/gh-api-call-ledger.log (per-call attribution: timestamp,
# pid, ppid, calling script, method, url) and maintains a rolling-hour
# counter at ~/.claude/gh-api-call-counts.log — same shape and same
# fail-open philosophy as gh-call-wrapper.sh, so both ledgers can be
# cross-referenced by timestamp during a future incident.
#
# Fails open: any logging error is swallowed. In `curl` mode, a logging
# failure never blocks the actual API call.

set -u

LEDGER="$HOME/.claude/gh-api-call-ledger.log"
COUNTS="$HOME/.claude/gh-api-call-counts.log"
WARN_THRESHOLD=${GH_API_WRAPPER_WARN_THRESHOLD:-3000}

_log_call() {
  local caller="$1" method="$2" url="$3"
  {
    ts=$(date +%s 2>/dev/null) || ts=0
    printf '%s\tpid=%s\tppid=%s\tcaller=%s\tmethod=%s\turl=%s\n' \
      "$ts" "$$" "${PPID:-0}" "$caller" "$method" "$url" >> "$LEDGER" 2>/dev/null

    echo "$ts" >> "$COUNTS" 2>/dev/null
    # Prune + threshold-check probabilistically (1-in-20 calls), matching
    # gh-call-wrapper.sh, so the hot path stays a single append usually.
    if [ $(( RANDOM % 20 )) -eq 0 ] && [ -f "$COUNTS" ]; then
      cutoff=$((ts - 3600))
      awk -v c="$cutoff" '$1>=c' "$COUNTS" > "$COUNTS.tmp" 2>/dev/null && mv "$COUNTS.tmp" "$COUNTS" 2>/dev/null
      n=$(wc -l < "$COUNTS" 2>/dev/null | tr -d ' ')
      if [ -n "$n" ] && [ "$n" -ge "$WARN_THRESHOLD" ]; then
        echo "$ts	AGGREGATE-WARNING	${n} direct GitHub API calls across all sessions in the last hour (threshold ${WARN_THRESHOLD}/5000)" >> "$LEDGER" 2>/dev/null
      fi
    fi
  } 2>/dev/null || true
}

usage() {
  echo "Usage: gh-api-wrapper.sh {log <caller> <method> <url> | curl <caller> <url> [curl-args...]}" >&2
}

cmd="${1:-}"
case "$cmd" in
  log)
    caller="${2:-unknown}"; method="${3:-GET}"; url="${4:-}"
    if [ -z "$url" ]; then usage; exit 1; fi
    _log_call "$caller" "$method" "$url"
    ;;
  curl)
    caller="${2:-unknown}"; url="${3:-}"
    if [ -z "$url" ]; then usage; exit 1; fi
    shift 3 2>/dev/null || shift $#
    _log_call "$caller" "GET" "$url"
    token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
    if [ -n "$token" ]; then
      exec curl -sS -H "Authorization: token $token" -H "User-Agent: bsc-gh-api-wrapper" -H "Accept: application/vnd.github+json" "$url" "$@"
    else
      exec curl -sS -H "User-Agent: bsc-gh-api-wrapper" -H "Accept: application/vnd.github+json" "$url" "$@"
    fi
    ;;
  *)
    usage
    exit 1
    ;;
esac
