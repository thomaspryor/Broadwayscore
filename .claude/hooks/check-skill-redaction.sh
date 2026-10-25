#!/usr/bin/env bash
# PreToolUse hook on Bash. Blocks push-ingress commands (git push, gh pr merge,
# push-with-retry, HEAD:main, etc.) when a redacted-sensitive string from the
# gitignored denylist has reappeared in a committed .claude/skills/** file.
#
# WHY: the repo is PUBLIC and .claude/skills/**/skill.md is auto-scraped + indexed
# by skill catalogs (claudskills.com) the moment it lands on origin. A memory note
# alone can't prevent re-introduction — this hook enforces it. The denylist lives at
# .claude/skills/.redaction-denylist.txt (gitignored, so it doesn't re-leak the
# strings it protects). Move identifiers to references/cookies.md, keep mechanism.
# Rationale: memory/feedback_claude_skills_public_via_repo.md
#
# Scope is .claude/skills/** only — the catalog-indexed surface. cloud-memory/ is
# public but not catalog-indexed; not enforced here by design.

# Self-skip if a user-level master copy exists (matches existing hook convention).
if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then exit 0; fi

# Emergency disable.
[ "${SKILL_REDACTION_DISABLE:-0}" = "1" ] && exit 0

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Fail open if we can't see the command.
[ -z "$command" ] && exit 0

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$REPO_ROOT" ] && exit 0

# Is this a push-ingress command? Reuse the scanner the visual gate uses; fall back inline.
SCAN="$REPO_ROOT/scripts/lib/transcript-scan.mjs"
if [ -f "$SCAN" ]; then
  IS_PUSH=$(node "$SCAN" --query=push-ingress --command="$command" 2>/dev/null | jq -r '.isPush // false' 2>/dev/null)
else
  if echo "$command" | grep -qE 'git[[:space:]]+push|gh[[:space:]]+pr[[:space:]]+merge|push-with-retry|HEAD:(refs/heads/)?main'; then
    IS_PUSH=true
  else
    IS_PUSH=false
  fi
fi
[ "$IS_PUSH" != "true" ] && exit 0

DENYLIST="$REPO_ROOT/.claude/skills/.redaction-denylist.txt"
# Fail open if the denylist isn't present (cloud sessions / other machines won't have it).
[ ! -f "$DENYLIST" ] && exit 0

# Non-blank, non-comment patterns. (A blank line passed to `grep -f` matches everything.)
PATTERNS=$(grep -vE '^[[:space:]]*(#|$)' "$DENYLIST" 2>/dev/null)
[ -z "$PATTERNS" ] && exit 0

# Search tracked skill files for any denylisted fixed string. The denylist is
# gitignored, so it isn't part of the tracked set and can't self-match.
HITS=$(cd "$REPO_ROOT" && printf '%s\n' "$PATTERNS" | git grep -n -F -f /dev/stdin -- '.claude/skills' 2>/dev/null)

if [ -n "$HITS" ]; then
  cat >&2 <<EOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ REDACTED STRING REAPPEARED IN A COMMITTED SKILL — PUSH BLOCKED

The repo is PUBLIC and .claude/skills/**/skill.md is auto-indexed by catalog
sites (claudskills.com). These strings were redacted into the gitignored
references/cookies.md and must not be re-committed to a skill:

$HITS

Fix: move the detail to .claude/skills/scraper-reference/references/cookies.md
(gitignored) and reference it as local-only; keep only the mechanism in the skill.
See memory/feedback_claude_skills_public_via_repo.md.
Bypass (only if the match is intentional + non-sensitive): SKILL_REDACTION_DISABLE=1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
  exit 2
fi

exit 0
