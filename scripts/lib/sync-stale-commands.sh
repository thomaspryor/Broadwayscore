#!/usr/bin/env bash
# scripts/lib/sync-stale-commands.sh <repo-root> (BRO-7887). Called by .claude/hooks/session-start.sh.
#
# Locally the GLOBAL ~/.claude/commands copy of a skill is the one that loads (verified 2026-11-21: a Mac job's
# Skill ship-check loaded the 2026-10-21 global copy, which lacked the skeptic reviewer step, so 0 of 5 Mac
# sessions ran it). The repo copy only reaches cloud sessions. So a stale global copy silently runs an old skill.
#
# Copies repo .claude/commands/X.md -> ~/.claude/commands/X.md ONLY when the global copy is STRICTLY BEHIND:
#   - the repo is Broadwayscore (another project's same-named skill must never replace the global one),
#   - the repo file equals origin/main's blob (a stale worktree never pushes an old version),
#   - the global file has no uncommitted edit in ~/.claude,
#   - the global file's blob is an older origin/main version of the repo file (home-only content is never lost).
# Copy is temp + mv (parallel sessions), then committed in ~/.claude (an uncommitted ~/.claude makes
# claude-sync pull refuse). Prints the synced names; anything else is left for the hook's drift warning.
set -u
root="$1"; home_cmds="$HOME/.claude/commands"
[ -d "$root/.claude/commands" ] && [ -d "$home_cmds" ] || exit 0
case "$(git -C "$root" remote get-url origin 2>/dev/null)" in *thomaspryor/Broadwayscore*) ;; *) exit 0 ;; esac
synced=""
backup_dir=$(mktemp -d "${TMPDIR:-/tmp}/sync-cmds.XXXXXX") || exit 0
trap 'rm -rf "$backup_dir"' EXIT
for cf in "$root"/.claude/commands/*.md; do
  [ -f "$cf" ] || continue
  cb=$(basename "$cf"); gf="$home_cmds/$cb"
  [ -f "$gf" ] && ! cmp -s "$cf" "$gf" || continue
  git -C "$root" diff --quiet origin/main -- ".claude/commands/$cb" 2>/dev/null || continue
  git -C "$HOME/.claude" ls-files --error-unmatch -- "commands/$cb" >/dev/null 2>&1 || continue # tracked only
  git -C "$HOME/.claude" diff --quiet HEAD -- "commands/$cb" 2>/dev/null || continue
  gh=$(git hash-object "$gf" 2>/dev/null); [ -n "$gh" ] || continue
  hit=""
  for c in $(git -C "$root" log origin/main --format='%H' -n 200 -- ".claude/commands/$cb" 2>/dev/null); do
    [ "$(git -C "$root" rev-parse "$c:.claude/commands/$cb" 2>/dev/null)" = "$gh" ] && { hit=1; break; }
  done
  [ -n "$hit" ] || continue
  backup="$backup_dir/$cb"; cp -p "$gf" "$backup" 2>/dev/null || continue # restored if the commit fails
  if cp "$cf" "$gf.sync.$$" 2>/dev/null && mv "$gf.sync.$$" "$gf" 2>/dev/null; then synced="$synced $cb"; else rm -f "$gf.sync.$$"; fi
done
[ -n "$synced" ] || exit 0
paths=""; for s in $synced; do paths="$paths commands/$s"; done
# shellcheck disable=SC2086
if ( cd "$HOME/.claude" && git add -- $paths && git commit -q -m "commands: auto-sync$synced from Broadwayscore (global copy was strictly behind; BRO-7887)" -- $paths ) >/dev/null 2>&1; then
  echo "$synced"
else
  # Commit failed (index.lock held by a parallel claude-sync, ...): put the committed copies back so ~/.claude is not
  # left dirty (claude-sync pull would refuse) and the next session retries. Print nothing: nothing was synced.
  # Copy files back (no git: the lock that failed the commit would fail a checkout too), then unstage if possible.
  for s in $synced; do mv "$backup_dir/$s" "$home_cmds/$s" 2>/dev/null; done
  # shellcheck disable=SC2086
  ( cd "$HOME/.claude" && git reset -q -- $paths ) >/dev/null 2>&1 || true
fi
