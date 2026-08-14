#!/usr/bin/env bash
#
# Fault-injection test for merge-worktree-to-main.sh's post-merge TEST floor
# (task #1149).
#
# THE BUG THIS PINS: the script had a post-merge SYNTAX floor (`node --check`)
# but nothing that runs TESTS against the merged tree. Reproduced 2026-08-09:
# a worktree branched from origin/main, another session's commit (a
# scripts/lib/ helper + its colocated contract test) landed on origin
# afterward, the worktree session's own pre-merge test runs were green
# because that test didn't exist yet at the branch point, this script merged
# origin in and pushed, and CI went red minutes later on the newly-merged
# contract test. Running the full suite BEFORE the merge cannot catch this
# class — the colliding test only exists WITH the merge.
#
# This fixture reproduces the exact shape: origin gains a new colocated test
# with a tightened contract AFTER the worktree branch forked; the branch
# independently touches the same scripts/lib/ helper without knowing about
# the new contract. Mirrors the structure of
# merge-worktree-to-main.content-drop.test.sh: real git repos in a temp dir,
# the real script run against a real bare "origin".
#
# Cases:
#   1. merged tree FAILS the newly-landed contract test -> refuse: exit non-
#      zero, nothing pushed, branch merge stays local (not silently dropped)
#   2. merged tree PASSES -> proceeds normally (exit 0, pushed)
#
# Run: bash scripts/lib/merge-worktree-to-main.post-merge-test-gate.test.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/merge-worktree-to-main.sh"
GATE="$REPO_ROOT/scripts/lib/merge-post-merge-test-gate.js"
[ -f "$SCRIPT" ] || { echo "FAIL: $SCRIPT not found"; exit 1; }
[ -f "$GATE" ] || { echo "FAIL: $GATE not found"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()  { echo "  ✓ $*"; PASS=$((PASS + 1)); }
bad() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }

# Build: bare origin + a "main" clone (where the script runs). $1 = case name,
# $2 = the value dummy.test.mjs asserts foo() equals (1 = matches the
# branch's foo(), which still returns 1; 2 = the tightened contract the
# branch never saw).
setup() {
  local name="$1" expect="$2" d="$TMP/$1"
  rm -rf "$d"; mkdir -p "$d"

  git init --bare -q -b main "$d/origin.git"

  git clone -q "$d/origin.git" "$d/main"
  git -C "$d/main" config user.email t@t.t
  git -C "$d/main" config user.name t

  # Fixture repo needs the real script + the real gate module it calls.
  mkdir -p "$d/main/scripts/lib"
  cp "$SCRIPT" "$d/main/scripts/merge-worktree-to-main.sh"
  cp "$GATE" "$d/main/scripts/lib/"
  # tap-failure-parser.js: hard require() of merge-post-merge-test-gate.js
  # (card #1433's baseline-diff TAP parsing), not optional like
  # acceptance-check-core.js — must be present in any real deployment.
  cp "$REPO_ROOT/scripts/lib/tap-failure-parser.js" "$d/main/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/push-mutex.sh" "$d/main/scripts/lib/"
  # Stub the unrelated range-scoped push-audit gate (own coverage elsewhere;
  # a real run here would abort before reaching the check this test targets).
  printf '#!/usr/bin/env bash\ncat >/dev/null 2>&1 || true\nexit 0\n' \
    > "$d/main/scripts/lib/run-push-audits.sh"
  chmod +x "$d/main/scripts/lib/run-push-audits.sh"

  cat > "$d/main/scripts/lib/dummy-helper.js" <<'JS'
'use strict';
function foo() { return 1; }
module.exports = { foo };
JS
  git -C "$d/main" add -A
  git -C "$d/main" commit -qm "base"
  git -C "$d/main" push -q origin main

  # Our worktree branch forks HERE and independently touches the SAME helper
  # (a real edit, unrelated to the contract that's about to land on origin) —
  # never sees the tightened test because it doesn't exist yet at fork time.
  git -C "$d/main" checkout -q -b feature
  cat > "$d/main/scripts/lib/dummy-helper.js" <<'JS'
'use strict';
// unrelated whitespace/comment touch — foo() still returns 1
function foo() { return 1; }
module.exports = { foo };
JS
  git -C "$d/main" commit -qam "feature: touch dummy-helper.js (unrelated to the contract change)"
  git -C "$d/main" checkout -q main

  # Meanwhile, origin gains the new colocated contract test (the incident's
  # "arrived via origin between fork and merge" commit).
  cat > "$d/main/scripts/lib/dummy-helper.test.mjs" <<JS
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { foo } = require('./dummy-helper.js');
test('foo returns the contracted value', () => {
  assert.equal(foo(), $expect);
});
JS
  git -C "$d/main" add -A
  git -C "$d/main" commit -qm "origin: land contract test expecting foo() === $expect"
  git -C "$d/main" push -q origin main
  # Reset local main back to the ORIGIN-BEFORE-this-commit state so the
  # script's own 'fetch + merge origin/main' step is what pulls it in —
  # exactly reproducing the incident's timing (session's local main is
  # stale; the script's merge is what first sees the new commit).
  git -C "$d/main" reset -q --hard HEAD~1
}

run_script() {
  local d="$TMP/$1"
  (cd "$d/main" && bash scripts/merge-worktree-to-main.sh feature) 2>&1
}

echo "── case 1: merged tree fails the newly-landed contract test (must REFUSE) ──"
setup fail 2
OUT="$(run_script fail)"; RC=$?
echo "$OUT" | sed 's/^/    /'
if [ "$RC" -ne 0 ]; then ok "script exited non-zero (got $RC)"; else bad "script exited 0 — should have refused"; fi
if echo "$OUT" | grep -qi "post-merge test floor"; then ok "failure message names the post-merge test floor"; else bad "no post-merge-test-floor wording in output"; fi
# Not pushed: origin/main must still be at the pre-feature-merge tip.
D="$TMP/fail"
git -C "$D/main" fetch -q origin main
if git -C "$D/main" show "origin/main:scripts/lib/dummy-helper.js" 2>/dev/null | grep -q "unrelated whitespace"; then
  bad "feature's change landed on origin despite the refusal"
else
  ok "origin/main unchanged — feature's merge was NOT pushed"
fi
# Branch intact: local main still holds the (unpushed) merge locally, i.e. the
# script didn't discard the work — it's sitting in the main worktree for the
# operator to fix, same recovery shape as the syntax floor / push audits.
LOCAL_LOG="$(git -C "$D/main" log --oneline -10 --all 2>&1)"
if echo "$LOCAL_LOG" | grep -qi "feature: touch dummy-helper"; then
  ok "the merge commit is intact locally (not discarded) for the operator to fix"
else
  bad "local main lost the merge — should stay intact per the recovery message"
fi

echo "── case 2: merged tree passes the contract test (must proceed) ──"
setup pass 1
OUT="$(run_script pass)"; RC=$?
echo "$OUT" | sed 's/^/    /'
if [ "$RC" -eq 0 ]; then ok "script exited 0"; else bad "script exited $RC — should have proceeded"; fi
D="$TMP/pass"
git -C "$D/main" fetch -q origin main
if git -C "$D/main" show "origin/main:scripts/lib/dummy-helper.js" 2>/dev/null | grep -q "unrelated whitespace"; then
  ok "feature's change landed on origin"
else
  bad "feature's change did not reach origin despite a passing merged tree"
fi

echo "── case 3: kill switch (must let the same failing contract through) ──"
setup killswitch 2
OUT="$(cd "$TMP/killswitch/main" && MERGE_SKIP_POST_MERGE_TEST_GATE=1 bash scripts/merge-worktree-to-main.sh feature 2>&1)"; RC=$?
echo "$OUT" | sed 's/^/    /'
if [ "$RC" -eq 0 ]; then ok "kill switch suppresses the gate (exit 0) despite the failing contract test"; else bad "kill switch did not bypass the gate (got $RC)"; fi
if echo "$OUT" | grep -q "MERGE_SKIP_POST_MERGE_TEST_GATE=1"; then ok "skip message names the kill switch"; else bad "no kill-switch skip message in output"; fi

echo ""
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
