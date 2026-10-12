#!/usr/bin/env bash
# BRO-3668/3669/3667/3687: push-with-retry.sh must not lose, push, or be derailed
# by tracked files the caller left modified but uncommitted.
#
#  1. Dirty unrelated file + remote ahead: rebase path runs (no pre-flight refusal,
#     no merge -X ours), push lands, the dirt is back byte-identical, NOT in the
#     pushed commit, and the snapshot ref is cleaned up. An untracked file is not
#     swept in either.
#  2. Dirty file that upstream ALSO changed (non-overlapping hunks): restore is a
#     3-way merge, so both the caller's edit and upstream's edit survive on disk.
#  3. Dirty file whose edit CONFLICTS with upstream: upstream's version stays on
#     disk, ::error:: names the path, snapshot ref is kept for recovery, and an
#     autostash-conflict row lands in the failure ledger.
#  4. Caller-deleted tracked file stays deleted.
#  5. PUSH_AUTOSTASH=0 keeps the old behaviour (dirt untouched, no autostash line).
#  6. A dirty symlink skips the autostash (cannot be restored via git show).
#  7. A merge=union ledger appended on both sides keeps both rows.
#  8. A caller deletion never overrides a concurrent upstream edit.
#
# Run: bash scripts/lib/push-with-retry.autostash.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
fail=0

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# setup <name>: origin with base files, a work clone with one local commit, and a
# racer commit on origin touching tracked.txt (and optionally more via $2 script).
setup() {
  local n=$1
  git init -q --bare "$TMP/$n.git"
  git clone -q "$TMP/$n.git" "$TMP/$n-seed" 2>/dev/null
  printf 'base\n' > "$TMP/$n-seed/tracked.txt"
  printf 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n' > "$TMP/$n-seed/shared.txt"
  printf 'other\n' > "$TMP/$n-seed/other.txt"
  printf 'gone\n' > "$TMP/$n-seed/gone.txt"
  git -C "$TMP/$n-seed" add -A && git -C "$TMP/$n-seed" commit -q -m base
  git -C "$TMP/$n-seed" push -q origin HEAD:main
  git clone -q "$TMP/$n.git" "$TMP/$n-work"
  git -C "$TMP/$n-work" checkout -q -B main origin/main
  printf 'local\n' > "$TMP/$n-work/local.txt"
  git -C "$TMP/$n-work" add local.txt && git -C "$TMP/$n-work" commit -q -m local
  git clone -q "$TMP/$n.git" "$TMP/$n-racer"
  git -C "$TMP/$n-racer" checkout -q -B main origin/main
  printf 'remote-advance\n' >> "$TMP/$n-racer/tracked.txt"
}
race() { git -C "$TMP/$1-racer" commit -q -am race && git -C "$TMP/$1-racer" push -q origin main; }
refs_left() { git -C "$TMP/$1-work" for-each-ref refs/worktree/push-autostash | wc -l | tr -d ' '; }

# ── Case 1 ──────────────────────────────────────────────────────────────────
setup c1; race c1
printf 'dirty\n' >> "$TMP/c1-work/other.txt"
printf 'untracked\n' > "$TMP/c1-work/scratch.tmp"
want=$(cat "$TMP/c1-work/other.txt")
out=$( cd "$TMP/c1-work" && PUSH_FAILURE_LOG="$TMP/c1-fail.jsonl" bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
pushed_other=$(git -C "$TMP/c1.git" show main:other.txt)
pushed_files=$(git -C "$TMP/c1.git" ls-tree --name-only main | tr '\n' ' ')
if [ "$rc" -ne 0 ]; then echo "FAIL[1]: push rc=$rc"; echo "$out"; fail=1
elif grep -qE "rebase REFUSED|Trying merge fallback" <<<"$out"; then echo "FAIL[1]: took refusal/merge path"; echo "$out"; fail=1
elif [ "$(cat "$TMP/c1-work/other.txt")" != "$want" ]; then echo "FAIL[1]: dirt not restored byte-identical"; fail=1
elif [ "$pushed_other" != "other" ]; then echo "FAIL[1]: dirt leaked into pushed commit"; fail=1
elif grep -q scratch.tmp <<<"$pushed_files"; then echo "FAIL[1]: untracked file pushed"; fail=1
elif [ ! -f "$TMP/c1-work/scratch.tmp" ]; then echo "FAIL[1]: untracked file lost"; fail=1
elif [ "$(refs_left c1)" != "0" ]; then echo "FAIL[1]: snapshot ref not cleaned"; fail=1
elif [ -s "$TMP/c1-fail.jsonl" ]; then echo "FAIL[1]: clean restore wrote a failure row"; fail=1
elif ! git -C "$TMP/c1.git" show main:tracked.txt | grep -q remote-advance; then echo "FAIL[1]: upstream commit lost"; fail=1
else echo "PASS[1]: rebase path, dirt restored, not pushed, ref cleaned"; fi

# ── Case 2: upstream changed the dirty file in a different hunk ─────────────
setup c2
sed -i 's/^l8$/l8-upstream/' "$TMP/c2-racer/shared.txt"; race c2
sed -i 's/^l1$/l1-caller/' "$TMP/c2-work/shared.txt"
out=$( cd "$TMP/c2-work" && bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
if [ "$rc" -ne 0 ]; then echo "FAIL[2]: rc=$rc"; echo "$out"; fail=1
elif ! grep -q l1-caller "$TMP/c2-work/shared.txt" || ! grep -q l8-upstream "$TMP/c2-work/shared.txt"; then
  echo "FAIL[2]: 3-way restore lost a side:"; cat "$TMP/c2-work/shared.txt"; fail=1
elif [ "$(refs_left c2)" != "0" ]; then echo "FAIL[2]: ref not cleaned"; fail=1
else echo "PASS[2]: 3-way restore kept caller and upstream edits"; fi

# ── Case 3: conflicting edit ────────────────────────────────────────────────
setup c3
sed -i 's/^l4$/l4-upstream/' "$TMP/c3-racer/shared.txt"; race c3
sed -i 's/^l4$/l4-caller/' "$TMP/c3-work/shared.txt"
out=$( cd "$TMP/c3-work" && PUSH_FAILURE_LOG="$TMP/c3-fail.jsonl" bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
if [ "$rc" -ne 0 ]; then echo "FAIL[3]: rc=$rc"; echo "$out"; fail=1
elif ! grep -q l4-upstream "$TMP/c3-work/shared.txt" || grep -q '<<<<<<<' "$TMP/c3-work/shared.txt"; then
  echo "FAIL[3]: expected clean upstream version on disk:"; cat "$TMP/c3-work/shared.txt"; fail=1
elif ! grep -q "::error::.*shared.txt conflicts" <<<"$out"; then echo "FAIL[3]: no ::error:: naming the path"; echo "$out"; fail=1
elif [ "$(refs_left c3)" != "1" ]; then echo "FAIL[3]: snapshot ref should be kept"; fail=1
elif ! grep -q '"autostash-conflict"' "$TMP/c3-fail.jsonl" 2>/dev/null; then echo "FAIL[3]: conflict not recorded in the failure ledger"; fail=1
elif ! git -C "$TMP/c3-work" show "$(git -C "$TMP/c3-work" for-each-ref --format='%(objectname)' refs/worktree/push-autostash):shared.txt" | grep -q l4-caller; then
  echo "FAIL[3]: kept snapshot lacks the caller's edit"; fail=1
else echo "PASS[3]: conflict keeps upstream, errors, keeps recoverable snapshot"; fi

# ── Case 4: caller-deleted file ─────────────────────────────────────────────
setup c4; race c4
rm "$TMP/c4-work/gone.txt"
out=$( cd "$TMP/c4-work" && bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
if [ "$rc" -ne 0 ] || [ -e "$TMP/c4-work/gone.txt" ] || ! git -C "$TMP/c4.git" cat-file -e main:gone.txt 2>/dev/null; then
  echo "FAIL[4]: rc=$rc, deletion not preserved locally or leaked upstream"; echo "$out"; fail=1
else echo "PASS[4]: caller deletion preserved, not pushed"; fi

# ── Case 5: kill switch ─────────────────────────────────────────────────────
setup c5
printf 'dirty\n' >> "$TMP/c5-work/other.txt"
out=$( cd "$TMP/c5-work" && PUSH_AUTOSTASH=0 bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
if [ "$rc" -ne 0 ] || grep -q autostash <<<"$out" || ! grep -q dirty "$TMP/c5-work/other.txt"; then
  echo "FAIL[5]: kill switch did not restore old behaviour (rc=$rc)"; echo "$out"; fail=1
else echo "PASS[5]: PUSH_AUTOSTASH=0 leaves the tree alone"; fi

# ── Case 6: dirty symlink → autostash skipped, link left intact ─────────────
setup c6
ln -s other.txt "$TMP/c6-work/link.txt"; git -C "$TMP/c6-work" add link.txt; git -C "$TMP/c6-work" commit -q -m link
ln -sfn tracked.txt "$TMP/c6-work/link.txt"
out=$( cd "$TMP/c6-work" && bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
if [ "$rc" -ne 0 ] || ! grep -q "autostash skipped" <<<"$out" || [ "$(readlink "$TMP/c6-work/link.txt")" != "tracked.txt" ]; then
  echo "FAIL[6]: symlink case (rc=$rc)"; echo "$out"; fail=1
else echo "PASS[6]: symlink dirt skips autostash, link untouched"; fi

# ── Case 7: merge=union ledger, both sides append → both rows kept ─────────
setup c7
printf 'log.jsonl merge=union\n' > "$TMP/c7-work/.gitattributes"; printf 'r0\n' > "$TMP/c7-work/log.jsonl"
git -C "$TMP/c7-work" add -A; git -C "$TMP/c7-work" commit -q -m ledger; git -C "$TMP/c7-work" push -q origin HEAD:main
git -C "$TMP/c7-racer" fetch -q origin && git -C "$TMP/c7-racer" reset -q --hard origin/main; printf 'r-upstream\n' >> "$TMP/c7-racer/log.jsonl"; race c7
printf 'local2\n' > "$TMP/c7-work/local2.txt"; git -C "$TMP/c7-work" add local2.txt; git -C "$TMP/c7-work" commit -q -m local2
printf 'r-caller\n' >> "$TMP/c7-work/log.jsonl"
out=$( cd "$TMP/c7-work" && bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
if [ "$rc" -ne 0 ] || ! grep -q r-caller "$TMP/c7-work/log.jsonl" || ! grep -q r-upstream "$TMP/c7-work/log.jsonl" || [ "$(refs_left c7)" != "0" ]; then
  echo "FAIL[7]: union ledger lost a side (rc=$rc)"; cat "$TMP/c7-work/log.jsonl"; echo "$out" | tail -5; fail=1
else echo "PASS[7]: merge=union ledger keeps caller and upstream rows"; fi

# ── Case 8: caller deleted a file upstream edited → upstream copy kept ──────
setup c8
printf 'gone-upstream-edit\n' >> "$TMP/c8-racer/gone.txt"; race c8
rm "$TMP/c8-work/gone.txt"
out=$( cd "$TMP/c8-work" && bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
if [ "$rc" -ne 0 ] || ! grep -q gone-upstream-edit "$TMP/c8-work/gone.txt" 2>/dev/null || [ "$(refs_left c8)" != "1" ]; then
  echo "FAIL[8]: delete-vs-upstream-edit (rc=$rc)"; echo "$out" | tail -5; fail=1
else echo "PASS[8]: caller delete does not override upstream edit"; fi

exit $fail
