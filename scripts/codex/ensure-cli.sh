#!/usr/bin/env bash
# scripts/codex/ensure-cli.sh: make the Codex CLI usable in this container, then
# print one line: READY, or MISSING: <reason>.
#
# BRO-7927: the review skills (/plan-review, /ship-check) checked only
# `command -v codex`, and a fresh cloud container has no Codex, so every cloud
# review quietly fell back to gpt-5.4-mini ("expected in cloud"). Codex does run
# in cloud: the board-workers Codex lane installs it and restores the owner's
# ChatGPT login (scripts/codex/auth-store.js). This script does the same steps
# for any session, idempotently:
#   1. install @openai/codex (the pin, in cloud) when missing or different
#   2. cloud only: restore the stored login when this container has an older one
#   3. refuse a login whose access token expires soon: the CLI would refresh it,
#      and the refresh token rotates, so two processes refreshing at once spend
#      the same token (scripts/lib/codex-runner.js slotsForLogin). Refreshing is
#      left to the daily runner, which serializes it.
#   4. install the repo's Codex guards into ~/.codex (scripts/codex/install.js)
# On the owner's Mac a different Codex version and an existing login are left
# alone, and --save does nothing (the Mac login is never pushed to the store).
# Never prints token material. Exit 0 = READY/SAVED, 1 = MISSING/SAVE-FAILED.
#
# Usage: bash scripts/codex/ensure-cli.sh          # before codex exec
#        bash scripts/codex/ensure-cli.sh --save   # after codex exec (cloud: persist a rotated login)

set -u
PIN="${CODEX_CLI_VERSION:-0.160.0}"   # keep in step with scripts/codex/daily-runner.js
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$(mktemp "${TMPDIR:-/tmp}/codex-ensure.XXXXXX" 2>/dev/null || echo /dev/null)"
CLOUD=""; [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && CLOUD=1
REVIEW_MS="${CODEX_REVIEW_MS:-1200000}"   # one review exec, 20 min

missing() { echo "MISSING: $1"; exit 1; }
# `timeout` is not on stock macOS; run without a bound there.
bounded() { local s="$1"; shift; if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; else "$@"; fi; }

if [ "${1:-}" = "--save" ]; then
  [ -n "$CLOUD" ] || { echo "SAVED (skipped: not a cloud container)"; exit 0; }
  bounded 900 node "$ROOT/scripts/codex/auth-store.js" save >>"$LOG" 2>&1 && { echo SAVED; exit 0; }
  echo "SAVE-FAILED (log: $LOG)"; exit 1
fi

have=""
command -v codex >/dev/null 2>&1 && have="$(codex --version 2>/dev/null | awk '{print $NF}')"
if [ -z "$have" ] || { [ -n "$CLOUD" ] && [ "$have" != "$PIN" ]; }; then
  command -v npm >/dev/null 2>&1 || missing "no npm to install @openai/codex@$PIN"
  bounded 240 npm i -g --no-audit --no-fund "@openai/codex@$PIN" >>"$LOG" 2>&1 \
    || missing "npm install of @openai/codex@$PIN failed (log: $LOG)"
  hash -r 2>/dev/null
  have="$(codex --version 2>/dev/null | awk '{print $NF}')"
  [ -n "$have" ] || missing "codex is still not runnable after installing @openai/codex@$PIN (log: $LOG)"
  [ -z "$CLOUD" ] || [ "$have" = "$PIN" ] || missing "codex --version says $have after installing $PIN (an older codex is earlier on PATH: $(command -v codex))"
fi

home="${CODEX_HOME:-$HOME/.codex}"
if [ -n "${OPENAI_API_KEY:-}${CODEX_AUTH_KEY:-}" ] && { [ -n "$CLOUD" ] || [ ! -s "$home/auth.json" ]; }; then
  # restore is a no-op when the local login is already the newer copy
  bounded 60 node "$ROOT/scripts/codex/auth-store.js" restore >>"$LOG" 2>&1 || true
fi
[ -s "$home/auth.json" ] || missing "no Codex login in $home (the stored login could not be restored; it needs OPENAI_API_KEY and the BRO-4799 store)"

if [ -n "$CLOUD" ]; then
  why="$(node -e '
    const { loginExpiryWhy } = require(process.argv[1] + "/scripts/lib/codex-runner.js");
    const authText = require("fs").readFileSync(process.argv[2], "utf8");
    process.stdout.write(loginExpiryWhy({ authText, nowMs: Date.now(), runMs: Number(process.argv[3]) }) || "");
  ' "$ROOT" "$home/auth.json" "$REVIEW_MS" 2>>"$LOG")" || why="the login expiry check crashed (log: $LOG)"
  [ -z "$why" ] || missing "$why; refreshing it is left to the Codex daily runner"
fi

node "$ROOT/scripts/codex/install.js" >>"$LOG" 2>&1 || missing "scripts/codex/install.js failed (log: $LOG)"
echo READY
