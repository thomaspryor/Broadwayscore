#!/usr/bin/env bash
# pr-write-guard.sh — PreToolUse hook on Bash (BRO-5915).
#
# Refuses `gh pr create` / `gh pr ready` / `gh pr merge`, the equivalent
# `gh api` + `curl` + `graphql` PR writes, on thomaspryor/Broadwayscore.
# The owner never reviews or merges PRs, so a PR just parks the work: sessions
# land it themselves with `git push origin HEAD:refs/heads/land/<name>` and
# follow the Land run (CLOUD.md § Landing). The MCP route is covered by
# .claude/hooks/github-main-guard.sh.
#
# Why this is its own hook, not a block inside pre-push-review-gate.sh (which
# is where BRO-5915 first landed): that file is a project copy of a user-level
# master, and it SELF-SKIPS whenever ~/.claude/hooks/pre-push-review-gate.sh
# exists, so the master can own the push gate on local CLI. The master has no
# PR guard, so on the Mac the block was dead — `gh pr create` was refused in
# cloud sandboxes only. A guard that must hold everywhere cannot live behind
# that preamble. Like github-main-guard.sh ("No Mac master: this file has no
# ~/.claude/hooks twin, so it also runs on the Mac") and
# pre-push-land-preflight.sh, this file is repo-only by design: never create a
# ~/.claude/hooks/pr-write-guard.sh twin, or it will self-skip into the same
# hole.
#
# All logic lives in scripts/lib/pr-command.mjs (tested by
# scripts/lib/pre-push-review-gate.test.mjs, which drives THIS hook). This
# wrapper only feeds it the hook JSON. It fails open: any error, a missing
# node, or the lib missing exits 0.
# Kill switch: PR_WRITE_GUARD_DISABLE=1 in the hook environment.
# Per-command override: PR_GUARD_OFF=1 (this check only) or LAND_ENFORCE_OFF=1
# (all land guards), as an env prefix, the environment, or
# $HOME/.claude/{PR_GUARD_OFF,LAND_ENFORCE_OFF} — all handled in the lib.

[ "${PR_WRITE_GUARD_DISABLE:-0}" = "1" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../../scripts/lib/pr-command.mjs"
[ -f "$LIB" ] || exit 0

input=$(cat)
# Cheap pre-filter: most Bash calls name no PR at all, so skip node entirely.
# Mirrors the lib's own surface — `gh`/`curl`, plus a `pr`/`pulls`/PullRequest
# token. Deliberately loose: the lib makes the real decision.
printf '%s' "$input" | grep -qE 'gh|curl' || exit 0
printf '%s' "$input" | grep -qiE '(^|[^a-z])pr([^a-z]|$)|pulls|PullRequest' || exit 0

# Stock macOS has no `timeout`; fall back to gtimeout, then to no wrapper
# (the settings.json hook timeout still bounds it).
if command -v timeout >/dev/null 2>&1; then TO=(timeout 30)
elif command -v gtimeout >/dev/null 2>&1; then TO=(gtimeout 30)
else TO=()
fi
err=$(printf '%s' "$input" | "${TO[@]}" node "$LIB" --hook 2>&1 >/dev/null)
rc=$?
# Only an explicit refusal (exit 2) blocks. A crash, a timeout kill (124/137)
# or any other status fails open — this guard must never wedge a Bash call.
if [ "$rc" -eq 2 ]; then
  printf '%s\n' "$err" >&2
  exit 2
fi
exit 0
