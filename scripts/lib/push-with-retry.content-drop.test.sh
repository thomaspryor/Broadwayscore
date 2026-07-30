#!/usr/bin/env bash
# Integration test for the task #619 P0 fix: push-with-retry.sh could print
# "Push succeeded" with a genuine ref-update while silently discarding the
# run's own commit content — reproduced live twice in one session on the same
# one-line CLAUDE.md byte-cap edit.
#
# This does NOT attempt to reproduce the exact internal git-conflict trigger
# under real concurrent-CI load (unconfirmed / requires a live concurrency
# harness per the card's own acceptance criteria). It proves two things that
# together close the bug class:
#
#   1. resolve_conflicts()'s catch-all "accept remote" arm no longer silently
#      discards real local content it doesn't recognize as protected — proven
#      via fault injection with a type-change conflict (the one structural
#      shape confirmed, by direct git experimentation, to survive `-X ours`/
#      `-X theirs` auto-resolution and reach that arm; ordinary same-line
#      modify/modify conflicts — even on the exact CLAUDE.md scenario — are
#      already auto-resolved favouring OUR side before ever reaching this
#      code, so they cannot be used to fault-inject the arm directly).
#   2. The new post-push CONTENT-survival check (push-content-survival.js)
#      catches the incident's own documented END-STATE — a push landed, but a
#      file our commit modified is back to its pre-edit content on the ref we
#      just pushed — which NEITHER pre-existing guard catches: the post-rebase
#      survival check only tracks ADDED files and no-ops on a pure
#      modification, and the no-op-rebase guard only proves the remote tip
#      became an ancestor of HEAD (true even when a modified file's content
#      was discarded along the way).
#
# Run: bash scripts/lib/push-with-retry.content-drop.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
CONTENT_CLI="$SCRIPT_DIR/push-content-survival.js"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

gitc() { git -C "$1" "${@:2}"; }

# ── Case 1: resolve_conflicts() default arm no longer blindly discards ──────
# Fault-injects a type-change conflict (the shape proven to reach the arm)
# carrying real local content, races it against a remote edit, and asserts
# the fixed script never reports the remote's content as an unconditional
# accept without at least warning + refusing when content differs.
git init -q --bare "$TMP/origin1.git"
git init -q "$TMP/seed1"
gitc "$TMP/seed1" config user.email t@t; gitc "$TMP/seed1" config user.name t
printf 'line1\nline2\nline3\n' > "$TMP/seed1/shared-config.txt"
gitc "$TMP/seed1" add -A; gitc "$TMP/seed1" commit -q -m base
gitc "$TMP/seed1" branch -M main; gitc "$TMP/seed1" push -q "$TMP/origin1.git" main

git init -q "$TMP/runner1"
gitc "$TMP/runner1" config user.email t@t; gitc "$TMP/runner1" config user.name t
gitc "$TMP/runner1" remote add origin "$TMP/origin1.git"
gitc "$TMP/runner1" fetch -q origin main
gitc "$TMP/runner1" checkout -q -B main origin/main

printf 'line1\nREMOTE-CHANGE-line2\nline3\n' > "$TMP/seed1/shared-config.txt"
gitc "$TMP/seed1" add -A; gitc "$TMP/seed1" commit -q -m "remote edit"
gitc "$TMP/seed1" push -q "$TMP/origin1.git" main

rm "$TMP/runner1/shared-config.txt"
ln -s /etc/hosts "$TMP/runner1/shared-config.txt"
gitc "$TMP/runner1" add -A
gitc "$TMP/runner1" commit -q -m "LOCAL-MARKER: our real fix (typechange forces a genuine conflict)"

out1=$( cd "$TMP/runner1" && PUSH_FAILURE_LOG="$TMP/failures1.jsonl" bash "$PUSH_SCRIPT" 3 main 2>&1 )
FINAL_REMOTE=$(git --git-dir="$TMP/origin1.git" show main:shared-config.txt 2>/dev/null || echo "")
if echo "$out1" | grep -q "Auto-resolving (keep remote): shared-config.txt$"; then
  echo "FAIL[1]: default arm STILL blindly accepted remote without a content check — the task #619 vulnerability is unfixed."
  fail=1
elif ! echo "$out1" | grep -q "Refusing to auto-accept remote for shared-config.txt"; then
  echo "FAIL[1]: expected the new content-safety refusal message; got none. Output:"; echo "$out1" | tail -20 | sed 's/^/    /'
  fail=1
elif echo "$FINAL_REMOTE" | grep -q "LOCAL-MARKER"; then
  echo "FAIL[1]: unexpected — local marker landed on origin (typechange should be structurally unresolvable); investigate test assumptions."
  fail=1
else
  echo "PASS[1]: resolve_conflicts() refuses to silently discard real local content in the default arm (fault-injected via type-change)"
fi

# ── Case 2: the new content-survival CLI catches the incident's own          ──
# documented end-state, which NEITHER pre-existing guard can see.
node -e "require('fs').writeFileSync('$TMP/CLAUDE.md', 'a'.repeat(200)+'\n')" 2>/dev/null || true
git init -q "$TMP/repro2"
gitc "$TMP/repro2" config user.email t@t; gitc "$TMP/repro2" config user.name t
node -e "require('fs').writeFileSync('$TMP/repro2/CLAUDE.md', 'a'.repeat(200)+'\n')"
gitc "$TMP/repro2" add -A; gitc "$TMP/repro2" commit -q -m base
# Force the branch name explicitly (init.defaultBranch varies by environment —
# this exact assumption broke the .test.mjs sibling on the CI runner, whose git
# named the initial branch differently than this machine's).
gitc "$TMP/repro2" branch -M main
BASE2=$(gitc "$TMP/repro2" rev-parse HEAD)
node -e "require('fs').writeFileSync('$TMP/repro2/CLAUDE.md', 'a'.repeat(50)+'\n')"
gitc "$TMP/repro2" add -A; gitc "$TMP/repro2" commit -q -m "fix: trim CLAUDE.md byte cap"
BEFORE2=$(gitc "$TMP/repro2" rev-parse HEAD)
gitc "$TMP/repro2" branch origin-tip "$BASE2"
gitc "$TMP/repro2" checkout -q origin-tip
node -e "require('fs').writeFileSync('$TMP/repro2/unrelated.txt', 'other run landed fine\n')"
gitc "$TMP/repro2" add -A; gitc "$TMP/repro2" commit -q -m "unrelated: some other concurrent commit"
node -e "require('fs').writeFileSync('$TMP/repro2/CLAUDE.md', 'a'.repeat(200)+'\n')"
gitc "$TMP/repro2" add -A; gitc "$TMP/repro2" commit -q --allow-empty -m "buggy-resolution: reverted CLAUDE.md back to base"
FINAL2=$(gitc "$TMP/repro2" rev-parse HEAD)
gitc "$TMP/repro2" checkout -q main

old_guard_out=$(cd "$TMP/repro2" && node "$SCRIPT_DIR/../check-post-rebase-survival.js" --before-sha="$BEFORE2" --remote-ref="$FINAL2" --path-prefix="" 2>&1); old_guard_code=$?
new_guard_out=$(cd "$TMP/repro2" && node "$CONTENT_CLI" --before-sha="$BEFORE2" --base-sha="$BASE2" --check-ref="$FINAL2" 2>&1); new_guard_code=$?

if [ "$old_guard_code" -ne 0 ]; then
  echo "FAIL[2a]: expected the PRE-EXISTING added-files-only guard to MISS this (exit 0, proving the pre-fix gap) — got exit $old_guard_code"
  fail=1
else
  echo "PASS[2a]: pre-existing check-post-rebase-survival.js (added-files only) misses the reverted-content incident, as documented"
fi

if [ "$new_guard_code" -eq 1 ] && echo "$new_guard_out" | grep -q "REVERTED"; then
  echo "PASS[2b]: new push-content-survival.js CATCHES the exact task #619 signature (content reverted to pre-edit base)"
else
  echo "FAIL[2b]: expected new guard to fail loudly (exit 1, REVERTED). Got exit $new_guard_code:"; echo "$new_guard_out" | sed 's/^/    /'
  fail=1
fi

if [ "$fail" -ne 0 ]; then echo "=== push-with-retry.content-drop.test.sh FAILED ==="; exit 1; fi
echo "=== push-with-retry.content-drop.test.sh PASSED ==="
