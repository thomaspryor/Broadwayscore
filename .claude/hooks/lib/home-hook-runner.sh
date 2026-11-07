#!/usr/bin/env bash
# Runs one of this repo's hooks for a cloud session that started in /home/user
# instead of in this checkout (BRO-5221). Wired by scripts/install-home-claude-config.js,
# which writes /home/user/.claude/settings.json: the project config for sessions
# whose working directory is /home/user. That is every multi-repo session (the
# usual phone setup, which passes each repo as --add-dir, and --add-dir loads a
# repo's commands but never its hooks) and every create_session whose source_url
# is not spelled exactly like the repo. Before this, none of .claude/settings.json's
# hooks ran in those sessions: no Stop finish-chain gate, no create_session URL
# guard, no SessionStart setup.
#
# Usage (from the generated settings only): home-hook-runner.sh <hook-script.sh>
# The hook's stdin JSON is passed through unchanged.
#
# Scope: the session holds several repos. The hooks in REPO_SCOPED judge this
# repo's files and git state (worktree rule, push and merge gates), so they are
# skipped when the tool's target is in another git repo (the app's package.json,
# a push from the app checkout): the app keeps its main-only workflow. Every
# other hook guards an action wherever it runs (Resend broadcasts, create_session
# URLs, GitHub MCP writes) and always runs, as do session hooks (Stop,
# SessionStart, PreCompact). A hook missing from REPO_SCOPED therefore errs
# toward enforcing. Fails open: a resolution problem exits 0 without the hook.

hook="${1:-}"
case "$hook" in ''|*/*) exit 0 ;; esac
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd)" || exit 0
[ -f "$R/.claude/hooks/$hook" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat) || exit 0
event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -d "$cwd" ] || cwd="$PWD"

common_dir() { git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; }
OURS="$(common_dir "$R")"
[ -n "$OURS" ] || exit 0
[ "$(common_dir "$cwd")" = "$OURS" ] && grep -q "\.claude/hooks/$hook" "$(git -C "$cwd" rev-parse --show-toplevel)/.claude/settings.json" 2>/dev/null && exit 0  # BRO-6126: project settings already run it
# in_other_repo DIR: true when DIR is inside a git repo that is not this one
# (worktrees of this repo share its common dir, so they count as ours).
in_other_repo() {
  local d="$1" c
  while [ -n "$d" ] && [ ! -d "$d" ]; do d=$(dirname -- "$d"); done
  c="$(common_dir "$d")"
  [ -n "$c" ] && [ "$c" != "$OURS" ]
}

REPO_SCOPED=" worktree-enforce.sh pre-push-visual-gate.sh pre-push-review-gate.sh pre-push-land-preflight.sh pre-merge-review-gate.sh check-skill-redaction.sh infra-plan-review-gate.sh infra-post-write-audit.sh whitespace-nowrap-lint.sh "
tool_event=""
if [ "$event" = PreToolUse ] || [ "$event" = PostToolUse ]; then tool_event=1; fi

if [ -n "$tool_event" ] && [ "${REPO_SCOPED#* "$hook" }" != "$REPO_SCOPED" ]; then
  tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
  target=""
  case "$tool" in
    Edit|Write|MultiEdit|NotebookEdit)
      target=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
      [ -n "$target" ] && target=$(dirname -- "$target")
      ;;
    Bash)
      cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
      # A leading `cd X` (or `git -C X`) decides where the command acts.
      first=$(printf '%s' "$cmd" | sed -nE '1s/^[[:space:]]*(cd[[:space:]]+|git[[:space:]]+-C[[:space:]]+)("[^"]+"|'"'"'[^'"'"']+'"'"'|[^[:space:];&|]+).*/\2/p' | tr -d "\"'")
      if [ -n "$first" ]; then
        case "$first" in /*) target="$first" ;; *) target="$cwd/$first" ;; esac
      elif ! in_other_repo "$cwd" && [ -z "$(common_dir "$cwd")" ]; then
        # Started outside any repo: a command naming only another repo's
        # checkout is that repo's work.
        for d in "$(dirname -- "$R")"/*/; do
          d="${d%/}"
          [ "$(common_dir "$d")" = "$OURS" ] && continue
          [ -n "$(common_dir "$d")" ] || continue
          case "$cmd" in *"$d"*) case "$cmd" in *"$R"*) ;; *) exit 0 ;; esac ;; esac
        done
      fi
      ;;
  esac
  [ -n "$target" ] || target="$cwd"
  in_other_repo "$target" && exit 0
fi

# The setup script's result is cached, so the wiring can lag the repo (a hook,
# command or agent folder added since). Repair it at startup; links added now
# serve this session's later lookups and every later start in this container.
if [ "$hook" = session-start.sh ] && command -v node >/dev/null 2>&1; then
  I="$R/scripts/install-home-claude-config.js"; H="$(dirname -- "$R")"
  CLAUDE_CODE_REMOTE=true node "$I" --check --target "$H" >/dev/null 2>&1 || CLAUDE_CODE_REMOTE=true node "$I" --target "$H" >/dev/null 2>&1
  CLAUDE_CODE_REMOTE=true node "$I" --check --target "$H" >/dev/null 2>&1 \
    || echo "⚠️ BRO-5221: /home/user/.claude could not be brought up to date (node scripts/install-home-claude-config.js --check). Hooks added since this container was set up are NOT running; follow CLOUD.md § Multi-repo by hand for them."
fi

export CLAUDE_PROJECT_DIR="$R"
# Hooks find their repo with git from the working directory. Keep a worktree of
# this repo as the cwd. From /home/user (no repo), session hooks run from the
# checkout; tool hooks stay put, so a relative path in a command still means
# /home/user/<path> and not a file in the checkout.
if [ "$(common_dir "$cwd")" = "$OURS" ] || [ -n "$tool_event" ]; then
  cd "$cwd" 2>/dev/null || exit 0
else
  cd "$R" || exit 0
fi
printf '%s' "$input" | exec bash "$R/.claude/hooks/$hook"
