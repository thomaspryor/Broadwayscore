#!/usr/bin/env bash
# pr-write-guard.sh — PreToolUse hook on Bash (BRO-5915).
#
# Refuses `gh pr create` / `gh pr ready` / `gh pr merge` and the equivalent
# `gh api` / `curl` writes to a `repos/<owner>/<repo>/pulls` path (including a
# PATCH with draft=false), GraphQL PR mutations (inline or from a file),
# `hub pull-request`, and the same commands run through `bash <<EOF`,
# `bash <<< '…'` or `echo '…' | bash`, on thomaspryor/Broadwayscore.
# NOT covered (BRO-5932): an API client written in node/python/ruby, a script
# file written in one command and run in another, and a GraphQL mutation that
# names the repository by id rather than by cwd/GH_REPO.
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
# Kill switches, best lever first:
#   touch $HOME/.claude/PR_GUARD_OFF   — takes effect in EVERY running session
#     at once, no relaunch (handled in the lib); $HOME/.claude/LAND_ENFORCE_OFF
#     does the same for all land guards. This is the 2am lever.
#   PR_GUARD_OFF=1 / LAND_ENFORCE_OFF=1 as an env prefix on the one command.
#   PR_WRITE_GUARD_DISABLE=1 — skips this wrapper entirely, but only if it is
#     in the hook's own environment, i.e. the session's launch env.
#
# set +e is deliberate: a hook inherits the launching shell's options, and an
# inherited errexit would turn a nonzero child into a Bash-call-blocking exit
# before the rc normalization below (Codex adversarial review, 2026-10-22).
set +e
if [ "${PR_WRITE_GUARD_DISABLE:-0}" = "1" ]; then exit 0; fi
command -v node >/dev/null 2>&1 || exit 0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../../scripts/lib/pr-command.mjs"
[ -f "$LIB" ] || exit 0

input=$(cat)
# Cheap pre-filter: most Bash calls name no PR at all, so skip node entirely.
# Mirrors the lib's own surface — `gh`/`hub`/`curl`, plus a `pr`/`pulls`/PullRequest/
# pull-request/graphql token (a graphql payload may live in a file). Deliberately loose: the lib makes the real decision.
printf '%s' "$input" | grep -qE 'gh|hub|curl' || exit 0
printf '%s' "$input" | grep -qiE '(^|[^a-z])pr([^a-z]|$)|pulls|PullRequest|pull-request|graphql' || exit 0

# Stock macOS has no `timeout`; fall back to gtimeout, then to no wrapper
# (the settings.json hook timeout still bounds it).
if command -v timeout >/dev/null 2>&1; then TO=(timeout 30)
elif command -v gtimeout >/dev/null 2>&1; then TO=(gtimeout 30)
else TO=()
fi
err=$(printf '%s' "$input" | "${TO[@]}" node "$LIB" --hook 2>&1 >/dev/null) && rc=0 || rc=$?
# Only an explicit refusal (exit 2) blocks. A crash, a timeout kill (124/137)
# or any other status fails open — this guard must never wedge a Bash call.
if [ "$rc" -eq 2 ]; then
  printf '%s\n' "$err" >&2
  exit 2
fi
exit 0
