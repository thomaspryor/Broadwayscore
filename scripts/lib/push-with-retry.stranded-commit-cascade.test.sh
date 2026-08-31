#!/usr/bin/env bash
# BRO-2538: push-with-retry.sh's Git Data API fallback disqualifier was
# reported to fire on a step whose OWN commit only touched apiFallbackSafe
# files. The ORIGINAL hypothesis (the disqualifier evaluates the merge-
# accumulated diff from repeated rebase-fail -> merge-fallback retry cycles,
# not the job's own diff) does NOT reproduce: push-with-retry.sh already
# resets HEAD to RESTORE_BASE_HEAD before the disqualifier's diff (commit
# 509174350d4, 2026-08-16) — see push-with-retry.merge-fallback-disqualifier
# investigation notes in this task. That reset correctly discards genuine
# rebase/merge-fallback pollution every time; this file does NOT re-test that
# (already covered by the shallow-retry-escalation test's own multi-cycle
# fetch/rebase churn).
#
# The REAL, confirmed mechanism: .github/workflows/data-health-check.yml runs
# FOUR separate commit+push-with-retry.sh steps in ONE job/checkout. One of
# them, "Commit acceptance recheck ledger", has `continue-on-error: true` and
# commits a file (data/audit/autonomous-recheck-ledger.jsonl) that is NOT
# registered apiFallbackSafe. Under real contention, if that step's own
# push-with-retry.sh call exhausts BOTH the local retry loop and the Git Data
# API fallback, the step still "passes" the job (continue-on-error) but its
# commit stays on local HEAD, UNPUSHED. A LATER commit+push-with-retry.sh step
# in the SAME job/checkout then inherits that stranded commit as an ancestor
# of its own SCRIPT_ENTRY_HEAD — so its "own diff" legitimately includes the
# earlier non-safe file, and the disqualifier (working exactly as designed:
# bundling a non-audited file into an "ours wins outright" force-overlay push
# genuinely IS unsafe, regardless of which step's commit introduced it)
# refuses the fallback for a later step whose OWN work was 100% safe.
#
# PART A (below) reproduces this end-to-end against the real, unmodified
# push-with-retry.sh — this documents a real, BY-DESIGN property of the
# script (not a bug to fix there): a caller with `continue-on-error: true`
# that can strand a non-safe commit will poison every later push-with-
# retry.sh call in the same checkout. This part is expected to PASS
# regardless of the workflow fix — it is not the regression guard.
#
# PART B is the actual regression guard for the fix that landed (BRO-2538):
# data-health-check.yml reordered so "Commit acceptance recheck ledger" now
# runs LAST among its four commit+push steps (nothing after it in that job
# can inherit its stranding). Fails against the pre-fix ordering, passes
# against the fixed ordering.
#
# Run: bash scripts/lib/push-with-retry.stranded-commit-cascade.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

gitc() { git -C "$1" "${@:2}"; }
REAL_GIT_BIN="$(command -v git)"

echo "=== PART A: reproduce the stranded-commit cascade against the real script ==="

mkdir -p "$TMP/fakebin"
cat > "$TMP/fakebin/git" <<WRAPPER
#!/usr/bin/env bash
for a in "\$@"; do
  [ "\$a" = "push" ] && { echo "fake-git: forcing push to fail" >&2; exit 1; }
done
exec "$REAL_GIT_BIN" "\$@"
WRAPPER
chmod +x "$TMP/fakebin/git"

git init -q --bare "$TMP/origin.git"
git init -q "$TMP/seed"
gitc "$TMP/seed" config user.email t@t.t; gitc "$TMP/seed" config user.name t
mkdir -p "$TMP/seed/data/audit"
printf '{}\n' > "$TMP/seed/data/audit/autonomous-recheck-ledger.jsonl"
printf '{"runs":[1]}\n' > "$TMP/seed/data/audit/health-check-history.json"
gitc "$TMP/seed" add -A; gitc "$TMP/seed" commit -q -m seed
gitc "$TMP/seed" branch -M main; gitc "$TMP/seed" push -q "$TMP/origin.git" main

git clone -q "file://$TMP/origin.git" "$TMP/runner"
gitc "$TMP/runner" config user.email t@t.t; gitc "$TMP/runner" config user.name t

# "Step: Commit acceptance recheck ledger" (continue-on-error) — its own
# push-with-retry.sh call always fails (contention), so its commit strands.
printf '{"n":1}\n' > "$TMP/runner/data/audit/autonomous-recheck-ledger.jsonl"
gitc "$TMP/runner" add -A
gitc "$TMP/runner" commit -q -m "data: Update acceptance recheck ledger [skip ci]"

step1_out=$(
  cd "$TMP/runner" && \
  PATH="$TMP/fakebin:$PATH" \
  GITHUB_ACTIONS=true PUSH_SKIP_UNSHALLOW=1 GIT_NET_TIMEOUT_SEC=10 PUSH_DEADLINE_SEC=20 \
  bash "$PUSH_SCRIPT" 2 main 2>&1
); step1_code=$?

if [ "$step1_code" -eq 0 ]; then
  echo "FAIL[A-fixture]: step 1's push should have failed (simulating exhausted contention) but succeeded"
  fail=1
else
  echo "PASS[A-fixture]: step 1's push exhausted and its commit is now stranded, unpushed, on local HEAD"
fi

# Concurrent writer advances origin on an unrelated file so step 2's own
# plain push is rejected and must go through its own retry loop too.
printf '{"x":1}\n' > "$TMP/seed/data/audit/other-workflow-file.json"
gitc "$TMP/seed" add -A; gitc "$TMP/seed" commit -q -m "other workflow write"
gitc "$TMP/seed" push -q "$TMP/origin.git" main

# "Step: Commit health check audit snapshots (apiFallbackSafe)" — its own
# commit touches ONLY an apiFallbackSafe file.
printf '{"runs":[1,2]}\n' > "$TMP/runner/data/audit/health-check-history.json"
gitc "$TMP/runner" add -- data/audit/health-check-history.json
gitc "$TMP/runner" commit -q -m "data: Update health check audit snapshots [skip ci]"

step2_out=$(
  cd "$TMP/runner" && \
  PATH="$TMP/fakebin:$PATH" \
  GITHUB_ACTIONS=true PUSH_SKIP_UNSHALLOW=1 GIT_NET_TIMEOUT_SEC=10 PUSH_DEADLINE_SEC=30 \
  bash "$PUSH_SCRIPT" 3 main 2>&1
); step2_code=$?

if grep -q "skipping Git Data API fallback — our outgoing diff touches" <<<"$step2_out"; then
  echo "PASS[A]: reproduced — step 2's OWN commit was 100% apiFallbackSafe, but its fallback was"
  echo "         disqualified by step 1's stranded, unrelated, non-safe commit (expected, by design)."
else
  echo "FAIL[A]: expected the disqualifier to fire (documenting the by-design cascade) but it did not."
  echo "$step2_out" | sed 's/^/    /'
  fail=1
fi

echo
echo "=== PART B: regression guard — data-health-check.yml step ordering ==="

# Codex adversarial review finding (BRO-2538): checking that the ledger step
# merely sits after one named step and before another is fragile — a FIFTH
# commit+push-with-retry.sh step inserted between them would silently defeat
# the fix and still pass. Instead, enumerate every step whose OWN `run:` body
# actually invokes push-with-retry.sh, and assert the ledger step is the LAST
# one (max starting line), regardless of how many such steps exist or what
# they're named.
WORKFLOW="$REPO_ROOT/.github/workflows/data-health-check.yml"
if [ ! -f "$WORKFLOW" ]; then
  echo "FAIL[B]: $WORKFLOW not found"
  fail=1
else
  B_RESULT=$(node -e '
    const fs = require("fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").split("\n");
    const stepStartRe = /^\s{6}- name: (.+?)\s*$/; // steps in this job are indented 6 spaces
    const steps = [];
    lines.forEach((line, i) => {
      const m = line.match(stepStartRe);
      if (m) steps.push({ name: m[1], start: i }); // 0-indexed
    });
    if (steps.length === 0) { console.log("ERROR|no steps found"); process.exit(1); }
    steps.forEach((s, i) => {
      s.end = i + 1 < steps.length ? steps[i + 1].start : lines.length;
      const bodyLines = lines.slice(s.start, s.end);
      // Only count an ACTUAL invocation inside the run: block (indented 8+
      // spaces here, vs. 6-space step-level `#` comments) — a comment line
      // mentioning push-with-retry.sh (common: header comments documenting
      // the NEXT step, which this start/end slice also sweeps in) must not
      // count as a call, or every step preceding a documented commit step
      // would be misidentified as itself calling push-with-retry.sh.
      s.callsPushRetry = bodyLines.some((line) => {
        const trimmed = line.replace(/^\s+/, "");
        const indent = line.length - trimmed.length;
        return indent >= 8 && !trimmed.startsWith("#") && /push-with-retry\.sh/.test(line);
      });
    });
    const callers = steps.filter((s) => s.callsPushRetry);
    if (callers.length === 0) { console.log("ERROR|no step calls push-with-retry.sh"); process.exit(1); }
    const last = callers[callers.length - 1];
    const ledgerCallers = callers.filter((s) => s.name === "Commit acceptance recheck ledger");
    if (ledgerCallers.length === 0) { console.log("ERROR|no push-with-retry.sh-calling step named Commit acceptance recheck ledger"); process.exit(1); }
    const ledger = ledgerCallers[ledgerCallers.length - 1];
    const names = callers.map((s) => `${s.name}@L${s.start + 1}`).join(" -> ");
    if (ledger.start === last.start) {
      console.log(`OK|${names}`);
    } else {
      console.log(`FAIL|${names}|ledger is not last, "${last.name}"@L${last.start + 1} runs after it`);
    }
  ' "$WORKFLOW")
  B_STATUS="${B_RESULT%%|*}"
  B_REST="${B_RESULT#*|}"
  if [ "$B_STATUS" = "OK" ]; then
    echo "PASS[B]: 'Commit acceptance recheck ledger' is the LAST of all push-with-retry.sh-calling steps"
    echo "         in this job's execution order: $B_REST"
  else
    echo "FAIL[B]: $B_REST"
    echo "         This is the BRO-2538 regression: a continue-on-error step that can strand a"
    echo "         non-apiFallbackSafe commit must run LAST among this job's commit+push steps —"
    echo "         otherwise its stranded commit can poison a later step's Git Data API fallback."
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then echo; echo "=== push-with-retry.stranded-commit-cascade.test.sh FAILED ==="; exit 1; fi
echo
echo "=== push-with-retry.stranded-commit-cascade.test.sh PASSED ==="
