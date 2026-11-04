#!/usr/bin/env bash
# BRO-6986 (second try of BRO-6960). A conflict-resolved `rebase --continue`
# inside push-with-retry.sh succeeds and pushes, but git leaves .git/REBASE_HEAD
# behind with no rebase-merge/ dir. The NEXT push-with-retry.sh call in the same
# job (opening-night-poller: collect checkpoint push -> final rebuilt-data push)
# then died on the BRO-142 stale-marker guard ("existing REBASE_HEAD found
# before this run touched anything"), failing the whole poller run.
#
# Case 1: modify/delete conflict forces the rebase-resolved path; after the
#         push no REBASE_HEAD may remain, and a second push must succeed.
# Case 2: a genuine in-progress rebase (REBASE_HEAD + rebase-merge/) is still
#         refused by the entry guard (the fix must not weaken BRO-142).
# Run: bash scripts/lib/push-with-retry.orphan-rebase-head.test.sh
set -uo pipefail
export PUSH_FAILURE_LOG=/dev/null DISK_PREFLIGHT_FLOOR_GB=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH="$SCRIPT_DIR/push-with-retry.sh"
FAIL=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
cd "$W"
git init -q --bare -b main remote.git
git clone -q remote.git a 2>/dev/null
git clone -q remote.git b 2>/dev/null
for r in a b; do git -C $r config user.email t@t; git -C $r config user.name t; done
cd a
echo base > f.txt; echo one > keep.txt
git add -A; git commit -qm base; git push -q origin HEAD:main
cd ../b; git pull -q origin main; git rm -q f.txt; git commit -qm remote-delete; git push -q origin HEAD:main
cd ../a
echo changed > f.txt; git add -A; git commit -qm local-modify

bash "$PUSH" 3 main >out1.log 2>&1; rc=$?
[ $rc -eq 0 ] && ok "case1: conflict-resolved push succeeds" || { bad "case1: push rc=$rc"; tail -20 out1.log; }
grep -q "Rebase completed after" out1.log && ok "case1: premise (rebase-resolved path ran)" || bad "case1: premise not met, fixture no longer hits the resolved-rebase path"
[ ! -e "$(git rev-parse --git-path REBASE_HEAD)" ] && ok "case1: no orphan REBASE_HEAD left" || bad "case1: REBASE_HEAD left behind"

echo two >> keep.txt; git add -A; git commit -qm second
bash "$PUSH" 3 main >out2.log 2>&1; rc=$?
[ $rc -eq 0 ] && ok "case1: second push in same checkout succeeds" || { bad "case1: second push rc=$rc"; tail -5 out2.log; }

# Case 2: real in-progress rebase must still be refused.
echo three >> keep.txt; git add -A; git commit -qm third
mkdir -p "$(git rev-parse --git-path rebase-merge)"
git rev-parse HEAD > "$(git rev-parse --git-path REBASE_HEAD)"
bash "$PUSH" 3 main >out3.log 2>&1; rc=$?
[ $rc -ne 0 ] && grep -q "existing REBASE_HEAD found" out3.log && ok "case2: live rebase still refused" || bad "case2: live rebase not refused (rc=$rc)"
[ -f "$(git rev-parse --git-path REBASE_HEAD)" ] && [ -d "$(git rev-parse --git-path rebase-merge)" ] && ok "case2: refusal left the live marker untouched" || bad "case2: marker removed"

# Case 3: an orphan REBASE_HEAD present at entry is still refused (BRO-142 partial-cleanup detection) and kept.
rmdir "$(git rev-parse --git-path rebase-merge)"
bash "$PUSH" 3 main >out4.log 2>&1; rc=$?
[ $rc -ne 0 ] && grep -q "existing REBASE_HEAD found" out4.log && [ -f "$(git rev-parse --git-path REBASE_HEAD)" ] && ok "case3: entry-time orphan refused, not silently deleted" || bad "case3: rc=$rc"

exit $FAIL
