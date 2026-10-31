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
#  9. BRO-4688: in CI, a conflict on an autostash=regenerated snapshot keeps
#     upstream with a ::notice:: and writes NO ledger row. Still recorded: the
#     same conflict outside CI, with PUSH_AUTOSTASH_REGENERATED_QUIET=0, and on
#     a merge=ours-only file (merge=ours is not proof of regenerability).
# 10. BRO-4688: a .json object that conflicts as text but where each side
#     changed different keys (two rebuilds auto-registering different outlets)
#     is merged key-wise: both keys survive, no ::error::, no ledger row. The
#     same key changed differently on both sides is still a recorded conflict,
#     and an autostash=regenerated file is never blended (upstream kept).
#
# Run: bash scripts/lib/push-with-retry.autostash.test.sh
set -uo pipefail
# BRO-2664: no case may append to the real data/audit/push-retry-failures.jsonl
# (push-with-retry.sh logs failures there in CI). The script only appends
# (>>), so /dev/null is safe; cases that read the log set their own path.
export PUSH_FAILURE_LOG="${PUSH_FAILURE_LOG:-/dev/null}"
# BRO-6592: keep the host disk preflight (a ~220s worktree GC when the Mac is
# under 5GB free) out of timing-sensitive cases.
export DISK_PREFLIGHT_FLOOR_GB=0

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
elif ! grep -q remote-advance <<<"$(git -C "$TMP/c1.git" show main:tracked.txt)"; then echo "FAIL[1]: upstream commit lost"; fail=1
else echo "PASS[1]: rebase path, dirt restored, not pushed, ref cleaned"; fi

# ── Case 2: upstream changed the dirty file in a different hunk ─────────────
setup c2
perl -pi -e 's/^l8$/l8-upstream/' "$TMP/c2-racer/shared.txt"; race c2
perl -pi -e 's/^l1$/l1-caller/' "$TMP/c2-work/shared.txt"
out=$( cd "$TMP/c2-work" && bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
if [ "$rc" -ne 0 ]; then echo "FAIL[2]: rc=$rc"; echo "$out"; fail=1
elif ! grep -q l1-caller "$TMP/c2-work/shared.txt" || ! grep -q l8-upstream "$TMP/c2-work/shared.txt"; then
  echo "FAIL[2]: 3-way restore lost a side:"; cat "$TMP/c2-work/shared.txt"; fail=1
elif [ "$(refs_left c2)" != "0" ]; then echo "FAIL[2]: ref not cleaned"; fail=1
else echo "PASS[2]: 3-way restore kept caller and upstream edits"; fi

# ── Case 3: conflicting edit ────────────────────────────────────────────────
setup c3
perl -pi -e 's/^l4$/l4-upstream/' "$TMP/c3-racer/shared.txt"; race c3
perl -pi -e 's/^l4$/l4-caller/' "$TMP/c3-work/shared.txt"
out=$( cd "$TMP/c3-work" && PUSH_FAILURE_LOG="$TMP/c3-fail.jsonl" bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
if [ "$rc" -ne 0 ]; then echo "FAIL[3]: rc=$rc"; echo "$out"; fail=1
elif ! grep -q l4-upstream "$TMP/c3-work/shared.txt" || grep -q '<<<<<<<' "$TMP/c3-work/shared.txt"; then
  echo "FAIL[3]: expected clean upstream version on disk:"; cat "$TMP/c3-work/shared.txt"; fail=1
elif ! grep -q "::error::.*shared.txt conflicts" <<<"$out"; then echo "FAIL[3]: no ::error:: naming the path"; echo "$out"; fail=1
elif [ "$(refs_left c3)" != "1" ]; then echo "FAIL[3]: snapshot ref should be kept"; fail=1
elif ! grep -q '"autostash-conflict"' "$TMP/c3-fail.jsonl" 2>/dev/null; then echo "FAIL[3]: conflict not recorded in the failure ledger"; fail=1
elif ! grep -q l4-caller <<<"$(git -C "$TMP/c3-work" show "$(git -C "$TMP/c3-work" for-each-ref --format='%(objectname)' refs/worktree/push-autostash):shared.txt")"; then
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

# ── Case 9: regenerated snapshot conflict (BRO-4688) ────────────────────────
for mode in ci local off ours; do
  n="c9$mode"; setup "$n"
  if [ "$mode" = ours ]; then printf 'gen/*.json merge=ours\n' > "$TMP/$n-work/.gitattributes"
  else printf 'gen/*.json autostash=regenerated\n' > "$TMP/$n-work/.gitattributes"; fi
  mkdir -p "$TMP/$n-work/gen"
  printf '{\n  "at": "t0"\n}\n' > "$TMP/$n-work/gen/a.json"; cp "$TMP/$n-work/gen/a.json" "$TMP/$n-work/gen/b.json"
  git -C "$TMP/$n-work" add -A; git -C "$TMP/$n-work" commit -q -m snap; git -C "$TMP/$n-work" push -q origin HEAD:main
  git -C "$TMP/$n-racer" fetch -q origin && git -C "$TMP/$n-racer" reset -q --hard origin/main
  perl -pi -e 's/t0/t-upstream/' "$TMP/$n-racer/gen/a.json" "$TMP/$n-racer/gen/b.json"; race "$n"
  printf 'local2\n' > "$TMP/$n-work/local2.txt"; git -C "$TMP/$n-work" add local2.txt; git -C "$TMP/$n-work" commit -q -m local2
  perl -pi -e 's/t0/t-caller/' "$TMP/$n-work/gen/a.json" "$TMP/$n-work/gen/b.json"
  ga=true; quiet=1
  case "$mode" in local) ga="" ;; off) quiet=0 ;; esac
  out=$( cd "$TMP/$n-work" && GITHUB_ACTIONS="$ga" PUSH_AUTOSTASH_REGENERATED_QUIET="$quiet" PUSH_FAILURE_LOG="$TMP/$n-fail.jsonl" bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
  if [ "$rc" -ne 0 ]; then echo "FAIL[9 $mode]: rc=$rc"; echo "$out" | tail -5; fail=1
  elif ! grep -q t-upstream "$TMP/$n-work/gen/a.json" || ! grep -q t-upstream "$TMP/$n-work/gen/b.json"; then echo "FAIL[9 $mode]: upstream copy not on disk"; fail=1
  elif [ "$mode" = ci ] && { grep -q '"autostash-conflict"' "$TMP/$n-fail.jsonl" 2>/dev/null || grep -q '::error::.*autostash' <<<"$out" || [ "$(grep -c '::notice::.*is a regenerated snapshot' <<<"$out")" != "2" ]; }; then
    echo "FAIL[9 ci]: regenerated conflict should be one notice per file, no ledger row/error"; echo "$out" | grep autostash; fail=1
  elif [ "$mode" != ci ] && ! grep -q '"autostash-conflict"' "$TMP/$n-fail.jsonl" 2>/dev/null; then
    echo "FAIL[9 $mode]: this conflict must still be recorded"; fail=1
  elif [ "$(refs_left "$n")" != "1" ]; then echo "FAIL[9 $mode]: snapshot ref should be kept"; fail=1
  else echo "PASS[9 $mode]: regenerated-snapshot conflict handled ($mode)"; fi
done

# ── Case 10: key-wise JSON merge of a text conflict (BRO-4688) ─────────────
for mode in merge clash regen; do
  n="c10$mode"; setup "$n"
  [ "$mode" = regen ] && printf 'reg.json autostash=regenerated\n' > "$TMP/$n-work/.gitattributes"
  printf '{\n  "outlets": {\n    "nyt": "NYT"\n  }\n}\n' > "$TMP/$n-work/reg.json"
  git -C "$TMP/$n-work" add -A; git -C "$TMP/$n-work" commit -q -m reg; git -C "$TMP/$n-work" push -q origin HEAD:main
  git -C "$TMP/$n-racer" fetch -q origin && git -C "$TMP/$n-racer" reset -q --hard origin/main
  if [ "$mode" != clash ]; then
    printf '{\n  "outlets": {\n    "nyt": "NYT",\n    "up": "Upstream"\n  }\n}\n' > "$TMP/$n-racer/reg.json"
    want='{\n  "outlets": {\n    "nyt": "NYT",\n    "up": "Upstream",\n    "me": "Caller"\n  }\n}\n'
    printf '{\n  "outlets": {\n    "nyt": "NYT",\n    "me": "Caller"\n  }\n}\n' > "$TMP/$n-work/reg.json.new"
  else
    printf '{\n  "outlets": {\n    "nyt": "NYT-up"\n  }\n}\n' > "$TMP/$n-racer/reg.json"
    printf '{\n  "outlets": {\n    "nyt": "NYT-me"\n  }\n}\n' > "$TMP/$n-work/reg.json.new"
  fi
  race "$n"
  printf 'local2\n' > "$TMP/$n-work/local2.txt"; git -C "$TMP/$n-work" add local2.txt; git -C "$TMP/$n-work" commit -q -m local2
  mv "$TMP/$n-work/reg.json.new" "$TMP/$n-work/reg.json"
  out=$( cd "$TMP/$n-work" && GITHUB_ACTIONS=true PUSH_FAILURE_LOG="$TMP/$n-fail.jsonl" bash "$PUSH_SCRIPT" 3 main 2>&1 ); rc=$?
  if [ "$rc" -ne 0 ]; then echo "FAIL[10 $mode]: rc=$rc"; echo "$out" | tail -5; fail=1
  elif [ "$mode" = merge ] && [ "$(cat "$TMP/$n-work/reg.json")" != "$(printf "$want")" ]; then
    echo "FAIL[10 merge]: expected both outlets in theirs' layout:"; cat "$TMP/$n-work/reg.json"; fail=1
  elif [ "$mode" = merge ] && { grep -q '"autostash-conflict"' "$TMP/$n-fail.jsonl" 2>/dev/null || grep -q '::error::.*autostash' <<<"$out" || [ "$(refs_left "$n")" != "0" ]; }; then
    echo "FAIL[10 merge]: merged JSON still reported as a conflict / ref kept"; echo "$out" | grep autostash; fail=1
  elif [ "$mode" = clash ] && { ! grep -q NYT-up "$TMP/$n-work/reg.json" || ! grep -q '"autostash-conflict"' "$TMP/$n-fail.jsonl" 2>/dev/null; }; then
    echo "FAIL[10 clash]: a true value clash must keep upstream and be recorded"; cat "$TMP/$n-work/reg.json"; fail=1
  elif [ "$mode" = regen ] && { grep -q Caller "$TMP/$n-work/reg.json" || ! grep -q Upstream "$TMP/$n-work/reg.json" || grep -q '"autostash-conflict"' "$TMP/$n-fail.jsonl" 2>/dev/null; }; then
    echo "FAIL[10 regen]: a regenerated snapshot must keep upstream, not blend"; cat "$TMP/$n-work/reg.json"; fail=1
  else echo "PASS[10 $mode]: JSON restore ($mode)"; fi
done

exit $fail
