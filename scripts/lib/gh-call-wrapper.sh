#!/bin/bash
# Transparent `gh` CLI instrumentation wrapper — installed IN PLACE of the real
# `gh` binary by scripts/lib/install-gh-call-wrapper.sh (which renames the
# homebrew symlink to `gh.real` next to this file and drops a copy of this
# script in as `gh`).
#
# WHY (task #821, 2026-08-02): the personal-token core API quota hit 0/5000 at
# 20:09 UTC on a quiet Saturday afternoon with NO opening night running. The
# existing loop/dispatch guards (~/.claude/hooks/gh-poll-block.sh,
# gh-zombie-reap.sh, the gh-dispatch-guard rate limiter) all target a single
# runaway script or loop; this incident had no single offender — ~45 tasks
# were [in_progress] across concurrent Claude Code sessions simultaneously,
# each making a handful of ordinary (non-loop) gh calls for CI/deploy
# verification. Nothing had ever logged WHICH process made WHICH call, so the
# burner could only be guessed at, not named.
#
# This wrapper sits at the resolved `gh` binary path (not just earlier in
# PATH) so it sees every invocation regardless of caller: a Claude Code
# Bash-tool command, an `execSync('gh ...')` buried inside a Node script, or a
# launchd job — a PreToolUse hook only sees the first of those (it can't see
# subprocess-internal gh calls a script makes after Claude's Bash tool starts
# it), which is why gh-poll-block.sh alone can't provide this attribution.
#
# Logs to ~/.claude/gh-call-ledger.log (per-call attribution: timestamp, pid,
# ppid, cwd, argv) and maintains a rolling-hour counter at
# ~/.claude/gh-call-counts.log, shared across every session/process on the
# machine. Fails open: any logging error is swallowed — the real gh call
# always proceeds untouched, and `exec` preserves its exit code and
# stdin/stdout/stderr wiring exactly.
#
# To find a future burner: grep the ledger for the incident window, group by
# cwd/ppid, then `ps -o command= -p <ppid>` (or walk its ancestry) to identify
# the calling script or session.

set -u

GH_REAL="$(dirname "$0")/gh.real"
LEDGER="$HOME/.claude/gh-call-ledger.log"
COUNTS="$HOME/.claude/gh-call-counts.log"
WARN_THRESHOLD=${GH_WRAPPER_WARN_THRESHOLD:-3000}

{
  ts=$(date +%s 2>/dev/null) || ts=0
  cwd=$(pwd 2>/dev/null) || cwd="?"
  # Redact nothing sensitive: gh args are subcommands/flags, never raw tokens
  # (auth is via keychain/env, not argv).
  printf '%s\tpid=%s\tppid=%s\tcwd=%s\targv=%s\n' \
    "$ts" "$$" "${PPID:-0}" "$cwd" "$*" >> "$LEDGER" 2>/dev/null

  echo "$ts" >> "$COUNTS" 2>/dev/null
  # Prune + threshold-check probabilistically (1-in-20 calls) so the hot path
  # stays a single append in the common case.
  if [ $(( RANDOM % 20 )) -eq 0 ] && [ -f "$COUNTS" ]; then
    cutoff=$((ts - 3600))
    awk -v c="$cutoff" '$1>=c' "$COUNTS" > "$COUNTS.tmp" 2>/dev/null && mv "$COUNTS.tmp" "$COUNTS" 2>/dev/null
    n=$(wc -l < "$COUNTS" 2>/dev/null | tr -d ' ')
    if [ -n "$n" ] && [ "$n" -ge "$WARN_THRESHOLD" ]; then
      echo "$ts	AGGREGATE-WARNING	${n} gh calls across all sessions in the last hour (threshold ${WARN_THRESHOLD}/5000)" >> "$LEDGER" 2>/dev/null
    fi
  fi
} 2>/dev/null || true

exec "$GH_REAL" "$@"
