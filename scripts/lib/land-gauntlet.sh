#!/usr/bin/env bash
# land-gauntlet.sh — run land.yml's check gauntlet against a checkout and
# record each gate's exit code + output, without failing itself.
#
#   bash land-gauntlet.sh <out-dir> [--checkout <sha> --return-to <sha>] [--deps-changed]
#
# Writes <out-dir>/<gate>.exit, <out-dir>/<gate>.log per gate and
# <out-dir>/meta.json ({sha, root, wallMs, gates, exits}). ALWAYS exits 0
# (except on a failed --checkout, or a failed --deps-changed reinstall of the
# checked-out tree): the verdict is not "did any gate exit
# non-zero" but scripts/lib/land-gate-delta.js's new-failures-vs-base rule,
# which needs THIS script run twice — once on origin/main (the base), once on
# the rebased branch — and both results kept. Gate names must stay in step
# with GATES in land-gate-delta.js.
#
# --checkout <sha> / --return-to <sha>: judge <sha> instead of the current
#   tree, in the SAME checkout (`git checkout -f --detach`; node_modules, the
#   private core data and the generated manifests are gitignored and survive;
#   tracked check residue is discarded — nothing in that tree is anyone's
#   work), and come back to --return-to afterwards, on every exit path. The
#   base tree does NOT carry this script (it predates it, or differs), so
#   land.yml copies the BRANCH's copy to $RUNNER_TEMP and runs that: the
#   harness is the branch's on both runs; only the tree under test changes.
# --deps-changed: the branch changes package.json/package-lock.json, so the
#   installed node_modules are the branch's — run `npm ci` on the checked-out
#   tree before its gauntlet and again on --return-to, so a dependency bump
#   that breaks a test on the branch is not forgiven by breaking the base
#   with the same node_modules (Codex adversarial review). Each install is
#   retried once. A checkout-side install that still fails exits 1: judging
#   the base on the branch's node_modules fails open. BRO-6114: npm_ci logged
#   into <out-dir> before it existed (land.yml rm -rf's it first), so npm ci
#   never ran, a warning printed, and the Next 16 bump landed a new
#   tsc-llm-scoring failure as "red on base too". The return-side install
#   stays a warning: the measurement is already complete by then.
#
# Gates (parity with test.yml's blocking jobs, minus data-validation):
#   tsc, tsc-llm-scoring, next-lint                       (test.yml typescript-check)
#   unit-tests-node, unit-tests-tsx, scripts-lib-tests    (test.yml unit-tests —
#     the two batches are SEPARATE gates so a batch that cannot start is a
#     zero-parsed-failures fail-safe of its own, never hidden behind the other
#     batch's unchanged failure set)
#   lint-workflows (actionlint + the audit script list)   (test.yml lint-workflows)
#   bash-integration (every scripts/lib/*.test.sh test.yml (test.yml unit-tests —
#     invokes, via bash-integration-test-list.js)          bash integration steps)
#     BRO-4150: land.yml never ran these — a regression in one landed clean and
#     only turned main red afterwards (BRO-3873 step 4 hung a merge-worktree-
#     to-main test for 36h; BRO-4135/BRO-4149 landed a push-with-retry
#     regression the same way). The file list is DERIVED from test.yml's own
#     `run:` text (bash-integration-test-list.js), not hardcoded here, so a
#     bash test added to test.yml is covered automatically — no second edit.
#   toplevel-regression (every standalone `node scripts/test-*.js` step in
#     test.yml, via land-gauntlet-toplevel-list.js)
#     BRO-5117: the gauntlet never ran these, so BRO-5079 (test-opening-night-
#     fixes.js) and BRO-5115 (test-ordinal-publishdate-guards.js) landed clean
#     and turned main red. List DERIVED from test.yml, like bash-integration.
#     Blocking since 2026-10-12 (kill switch: LAND_TOPLEVEL_ADVISORY=1, see
#     land-gate-delta.js). A red file is retried once, so a one-off flake on
#     the branch cannot refuse a land (the branch side is never re-measured).
#   unit-tests-e2e (tests/e2e-unit-test-manifest.txt, test.yml E2E Tests >
#     "Run unit tests")
#     BRO-5161: the gauntlet never ran this batch, so 19c4e4a193 (BRO-4911)
#     broke tests/unit/review-normalization.test.js, landed clean and turned
#     main red. Its own gate (not folded into unit-tests-tsx) so a batch that
#     cannot start stays a fail-safe of its own. land.yml does NOT check out
#     data/review-texts (it doubled the other unit gates' run time), so the
#     few subtests asserting that corpus fail on base and branch alike and
#     the delta treats them as pre-existing; every other subtest is diffed.
#     ADVISORY until armed (LAND_E2E_UNIT_BLOCKING=1, see land-gate-delta.js).
# Env: GAUNTLET_GATES — optional comma list (e.g. "lint-workflows" or
#   "unit-tests-node,scripts-lib-tests"): run only those gates, skipping the
#   gold-lists prep unless a unit gate is listed. Unset = every gate. land.yml
#   sets it on the base run and the confirm run to the branch's red gates
#   (lazy base, BRO-5670); the Codex runner's pre-review check sets it too.
# Env: GAUNTLET_SCOPE_DIR (BRO-5728, BRO-5766; land.yml sets it on the base
#   re-checks) holds <gate>.files written by land-gate-delta.js --rerun-scope:
#   that TAP / bash-integration / toplevel-regression gate runs only the listed files that exist on this tree (none: its keys
#   are new by construction, so the gate records green without running), and
#   the gate is named in $OUT/SCOPED so the result is never cached or
#   published as a full base. Every TAP gate also writes $OUT/<gate>.files,
#   the files it ran, which --rerun-scope reads from the branch result.
# Env: GAUNTLET_PARALLEL=1 (BRO-5688; land.yml sets it) runs bash-integration
#   and lint-workflows in a background copy of this script (GAUNTLET_CHILD=1,
#   same out-dir, same tree) while the TAP batches run: both mostly wait on
#   git, process spawns and timeouts, and together they were ~6-7 min of a
#   ~15-20 min serial gauntlet. The parent waits for the child before writing
#   meta.json or returning to --return-to. Neither leaves residue in the tree
#   (checked 2026-10-19: only the gold-lists prep file, written before any gate).
# Env: LAND_BASE — the origin/main sha the tree was rebased onto (tony-loso
#   gate diffs against it; unset/empty → that gate is skipped with a note).
#   GH_TOKEN — for the audits that read the API. BSC_STAGE_LATENCY_MUTE=1 set
#   here as test.yml does.
set -uo pipefail

OUT="${1:?usage: land-gauntlet.sh <out-dir> [--checkout <sha> --return-to <sha>] [--deps-changed]}"
shift
CHECKOUT="" RETURN_TO="" DEPS_CHANGED=0
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"  # before any --checkout
while [ $# -gt 0 ]; do
  case "$1" in
    --checkout) CHECKOUT="${2:?--checkout needs a sha}"; shift 2 ;;
    --return-to) RETURN_TO="${2:?--return-to needs a sha}"; shift 2 ;;
    --deps-changed) DEPS_CHANGED=1; shift ;;
    *) echo "land-gauntlet.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [ -n "$CHECKOUT" ] && [ -z "$RETURN_TO" ]; then echo "land-gauntlet.sh: --checkout needs --return-to" >&2; exit 2; fi

mkdir -p "$OUT"  # before --checkout: npm_ci logs into it (BRO-6114)
npm_ci() {
  local log="$OUT/prep-npm-ci-$1.log"
  npm ci --prefer-offline --no-audit --no-fund > "$log" 2>&1 && return 0
  echo "npm ci ($1) failed once, retrying in 15s" | tee -a "$log"; sleep "${GAUNTLET_NPM_RETRY_SEC:-15}"
  npm ci --prefer-offline --no-audit --no-fund >> "$log" 2>&1
}
BG_PID=""
# The background lane runs in this same tree: stop it (and the test processes
# under it) before any checkout. Only reached with BG_PID set on an early exit
# (signal, job timeout). SIGSTOP top-down first so no level can start a new
# process between the kills, then print its log so the job log keeps it.
stop_tree() { kill -STOP "$1" 2>/dev/null; echo "$1"; local c; for c in $(pgrep -P "$1" 2>/dev/null); do stop_tree "$c"; done; }
kill_tree() { local pids; pids=$(stop_tree "$1"); kill $pids 2>/dev/null; kill -CONT $pids 2>/dev/null; }
on_exit() {
  if [ -n "$BG_PID" ]; then
    kill_tree "$BG_PID"; wait "$BG_PID" 2>/dev/null
    echo "background lane stopped early; its log so far:"; cat "$OUT/background-lane.log" 2>/dev/null
  fi
  if [ -n "$CHECKOUT" ]; then return_to; fi
}
trap on_exit EXIT
if [ -n "$CHECKOUT" ]; then
  return_to() {
    git checkout -q -f --detach "$RETURN_TO" || { echo "::error::could not return to ${RETURN_TO:0:10}"; exit 1; }
    if [ "$DEPS_CHANGED" = 1 ] && ! npm_ci return; then echo "::warning::npm ci (return) failed twice — see $OUT/prep-npm-ci-return.log"; fi
    echo "back on ${RETURN_TO:0:10}"
  }
  git checkout -q -f --detach "$CHECKOUT" || { echo "::error::could not check out ${CHECKOUT:0:10}"; exit 1; }
  if [ "$DEPS_CHANGED" = 1 ] && ! npm_ci checkout; then
    echo "::error::npm ci on ${CHECKOUT:0:10} failed twice — refusing to judge it with the other tree's node_modules (see $OUT/prep-npm-ci-checkout.log)"; exit 1
  fi
  echo "judging ${CHECKOUT:0:10} (will return to ${RETURN_TO:0:10})"
fi

[ -z "${GAUNTLET_CHILD:-}" ] && rm -f "$OUT/SCOPED"  # a reused out-dir must not claim a scope
ROOT=$(git rev-parse --show-toplevel)
SHA=$(git rev-parse HEAD)
T0=$(node -p 'Date.now()')
export BSC_STAGE_LATENCY_MUTE=1

# gate <name> <cmd…>: capture the command's stdout+stderr to <name>.log (and
# echo it into a collapsed log group), record the exit code, never abort.
want_gate() { [ -z "${GAUNTLET_GATES:-}" ] || [[ ",${GAUNTLET_GATES}," == *",$1,"* ]]; }
# Read once and drop from the env so test processes (some run this script)
# never inherit a scope.
SCOPE_DIR="${GAUNTLET_SCOPE_DIR:-}"; unset GAUNTLET_SCOPE_DIR
# scope_list <gate> <array-name>: record the list, then narrow it to the scope.
scope_list() {
  local gate="$1"; local -n _list="$2"
  printf '%s\n' ${_list[@]+"${_list[@]}"} > "$OUT/$gate.files"
  [ -n "$SCOPE_DIR" ] && [ -f "$SCOPE_DIR/$gate.files" ] || return 0
  local -A want=(); local f
  while IFS= read -r f; do [ -n "$f" ] && want["${f#./}"]=1; done < "$SCOPE_DIR/$gate.files"
  local -a kept=()
  for f in ${_list[@]+"${_list[@]}"}; do [ -n "${want[${f#./}]:-}" ] && kept+=("$f"); done
  echo "# $gate: base re-check scoped to ${#kept[@]} of ${#_list[@]} file(s) (BRO-5728)"
  echo "$gate" >> "$OUT/SCOPED"
  _list=(${kept[@]+"${kept[@]}"})
}
gate() {
  local name="$1"; shift
  if ! want_gate "$name"; then echo "gate $name: skipped (GAUNTLET_GATES=${GAUNTLET_GATES})"; return 0; fi
  if [[ ",${BG_GATES:-}," == *",$name,"* ]]; then echo "gate $name: running in the background lane"; return 0; fi
  echo "::group::gate $name — $*"
  "$@" 2>&1 | tee "$OUT/$name.log"
  local rc=${PIPESTATUS[0]}
  # land-local-check hides stdout. Keep local missing-tool warnings visible.
  sed -n -e '/^::warning::.*not installed here; CI runs/p' \
    -e 's/.*# SKIP \(.*not installed here; CI runs.*\)/::warning::\1/p' "$OUT/$name.log" >&2
  echo "::endgroup::"
  echo "$rc" > "$OUT/$name.exit"
  echo "gate $name: exit $rc"
}

# ── prep (not gates): gold lists + gitignored manifests ────────────────────
if [ -z "${GAUNTLET_CHILD:-}" ] && { want_gate unit-tests-node || want_gate unit-tests-tsx || want_gate unit-tests-e2e || want_gate scripts-lib-tests || want_gate bash-integration || want_gate toplevel-regression; }; then
  node scripts/compute-gold-lists.js > "$OUT/prep-gold-lists.log" 2>&1 || echo "::warning::compute-gold-lists.js failed (see $OUT/prep-gold-lists.log) — data-dependent tests may fail"
fi

# ── Background lane (GAUNTLET_PARALLEL=1, see the header) ───────────────────
BG_GATES=""
if [ "${GAUNTLET_PARALLEL:-0}" = "1" ] && [ -z "${GAUNTLET_CHILD:-}" ]; then
  # A stale .exit in a reused out-dir must not stand in for a lane that died.
  for g in bash-integration lint-workflows; do want_gate "$g" && { BG_GATES="${BG_GATES:+$BG_GATES,}$g"; rm -f "$OUT/$g.exit"; }; done
  if [ -n "$BG_GATES" ]; then
    # SCOPE_DIR was unset from the env above; hand it to the child explicitly (BRO-5766).
    # Gates log their output; inherit stderr so tool warnings reach land-local-check.
    GAUNTLET_CHILD=1 GAUNTLET_PARALLEL=0 GAUNTLET_GATES="$BG_GATES" GAUNTLET_SCOPE_DIR="$SCOPE_DIR" bash "$SELF" "$OUT" > "$OUT/background-lane.log" &
    BG_PID=$!
    echo "background lane: $BG_GATES (pid $BG_PID, log $OUT/background-lane.log)"
  fi
fi

# ── TypeScript Check ───────────────────────────────────────────────────────
# Full-repo tsc OOMs at the default ~2GB heap in cloud containers (BRO-6004).
TSC_HELPER="$(dirname "${BASH_SOURCE[0]}")/tsc-node-options.sh"
TSC_NODE_OPTIONS=""
[ -f "$TSC_HELPER" ] && { TSC_NODE_OPTIONS="$(bash "$TSC_HELPER")" || TSC_NODE_OPTIONS=""; }
# A temp copy of this script (land.yml, land-local-check, the codex runner) should come with
# the helper (stageGauntletHarness), but an older stager may copy this script alone; fall back
# to the same floor rather than the 2GB default, without a "No such file" error (BRO-6152).
[ -n "$TSC_NODE_OPTIONS" ] || TSC_NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=6144"
# BRO-6043: which tracked files differ from HEAD at the moment tsc starts (the
# gold-lists prep always dirties one), so tsc-stamp.js seed-export can tell what
# tsc actually saw. Absent file => no seed.
if git status --porcelain --untracked-files=no > "$OUT/tsc-tree-status.tmp" 2>/dev/null; then mv "$OUT/tsc-tree-status.tmp" "$OUT/tsc-tree-status"; else rm -f "$OUT/tsc-tree-status.tmp"; fi
gate tsc env NODE_OPTIONS="$TSC_NODE_OPTIONS" npx tsc --noEmit
gate tsc-llm-scoring env NODE_OPTIONS="$TSC_NODE_OPTIONS" npx tsc --noEmit -p scripts/llm-scoring/tsconfig.json
gate next-lint npm run lint

# ── Unit Tests: the two in-repo batches, each its own gate, BOTH always run ──
# Same manifests and per-test timeout as test.yml's "Run unit tests
# (no-data-dependency)". --test-reporter=tap pinned so land-gate-delta.js can
# key failures by file::name regardless of the Node default reporter.
#
# BRO-2483: the node batch comes from the TREE UNDER TEST. land.yml runs this
# (the branch's) harness against the base tree too, so the source is picked by
# whether that tree carries scripts/lib/unit-test-collection.js: present ->
# collect; absent (a pre-BRO-2483 base) -> read tests/unit-test-manifest.txt.
# Never by manifest presence: after BRO-2483 that file is a tombstone.
unit_tests_node_source() {
  if [ -f scripts/lib/unit-test-collection.js ]; then echo collector; else echo manifest; fi
}
# The collector's --min enforces its MIN_NODE_BATCH floor (exit 1, no output).
unit_tests_node_list() {
  if [ "$(unit_tests_node_source)" = collector ]; then
    node scripts/lib/unit-test-collection.js --min
  else
    grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' tests/unit-test-manifest.txt 2>/dev/null
  fi
}
unit_tests_node() {
  local -a tests
  local src
  src=$(unit_tests_node_source)
  local list
  list=$(unit_tests_node_list) || { echo "::error::node unit batch ($src) could not be listed (collector --min failed: empty, under MIN_NODE_BATCH, or crashed)"; return 1; }
  mapfile -t tests <<< "$list"
  if [ -z "$list" ] || [ ${#tests[@]} -eq 0 ]; then echo "::error::node unit batch ($src) is empty or missing"; return 1; fi
  scope_list unit-tests-node tests
  [ ${#tests[@]} -eq 0 ] && { echo "# none of the branch's failing files exist on this tree: their failures are new"; return 0; }
  echo "# node batch ($src): ${#tests[@]} files"
  node --test --test-reporter=tap --test-timeout 300000 ${tests[@]+"${tests[@]}"}
}
gate unit-tests-node unit_tests_node

unit_tests_tsx() {
  local -a tests
  mapfile -t tests < tests/unit-test-manifest-tsx.txt 2>/dev/null
  if [ ${#tests[@]} -eq 0 ]; then echo "::error::tests/unit-test-manifest-tsx.txt is empty or missing"; return 1; fi
  scope_list unit-tests-tsx tests
  [ ${#tests[@]} -eq 0 ] && { echo "# none of the branch's failing files exist on this tree: their failures are new"; return 0; }
  echo "# tsx batch: ${#tests[@]} files"
  npx tsx --test --test-reporter=tap --test-timeout 300000 ${tests[@]+"${tests[@]}"}
}
gate unit-tests-tsx unit_tests_tsx

# Same manifest and runner as test.yml's E2E Tests > "Run unit tests".
unit_tests_e2e() {
  local -a tests
  mapfile -t tests < tests/e2e-unit-test-manifest.txt 2>/dev/null
  if [ ${#tests[@]} -eq 0 ]; then echo "::error::tests/e2e-unit-test-manifest.txt is empty or missing"; return 1; fi
  scope_list unit-tests-e2e tests
  [ ${#tests[@]} -eq 0 ] && { echo "# none of the branch's failing files exist on this tree: their failures are new"; return 0; }
  echo "# e2e unit batch: ${#tests[@]} files"
  npx tsx --test --test-reporter=tap --test-timeout 300000 ${tests[@]+"${tests[@]}"}
}
gate unit-tests-e2e unit_tests_e2e

scripts_lib_tests() {
  shopt -s nullglob
  local -a tests=(scripts/lib/*.test.mjs)
  if [ ${#tests[@]} -eq 0 ]; then echo "no scripts/lib tests"; return 0; fi
  scope_list scripts-lib-tests tests
  [ ${#tests[@]} -eq 0 ] && { echo "# none of the branch's failing files exist on this tree: their failures are new"; return 0; }
  node --test --test-reporter=tap --test-timeout 300000 ${tests[@]+"${tests[@]}"}
}
gate scripts-lib-tests scripts_lib_tests

# ── Bash Integration Tests: every scripts/lib/*.test.sh test.yml invokes ───
# Each runs as its own labelled sub-check (same shape as lint_workflows below)
# so land-gate-delta.js can key a failure by FILE and diff it against the
# base — a file that's red on both sides is pre-existing, one that's newly
# red on the branch refuses the landing. `timeout 180`: same hang bound
# test.yml itself applies to the merge-worktree-to-main.* steps (2026-09-23/24
# incident — a hang without it cancels the whole job instead of failing one
# step); applied here uniformly to every file, including the handful test.yml
# does not currently wrap, since a hang here has no per-step GH Actions
# cancellation boundary to fall back on.
#
# Total wall-clock budget (Codex + second-opinion review, BRO-4150): 26 files
# x 180s each is ~78min worst case, well past land.yml's `checks` job's
# 40-minute timeout-minutes — and this suite deliberately exercises hangs/
# deadlines/stalls, so several genuinely-slow files hitting their per-file
# ceiling back to back is the realistic case, not the pathological one. Left
# unbounded, that kills the WHOLE job with zero gate diagnostics — exactly
# the opaque failure BRO-4150 exists to eliminate.
#
# The budget is JOB-WIDE-AWARE, not a flat per-invocation constant (Codex:
# "base and branch run sequentially within one 40-minute job... allocate a
# job-wide deadline and cap each invocation by remaining time"): it deducts
# T0's elapsed-so-far (every earlier gate in THIS invocation: tsc, lint,
# both unit-test batches) and reserves headroom for lint-workflows, the one
# gate that still has to run after this one. In the background lane
# (GAUNTLET_PARALLEL, BRO-5688) T0 is the lane's own start, so elapsed is ~0
# and the budget is ~deadline - reserve: the lane starts with the job. GAUNTLET_DEADLINE_SEC (default
# 1800s/30min) is deliberately under the job's 40-minute ceiling, leaving
# ~10min for checkout/npm-ci/setup steps that happen OUTSIDE this script.
#
# Once the resulting budget is spent, every file that didn't get a chance to
# run is recorded FAIL-CLOSED (as if it had timed out) rather than silently
# skipped — but keyed with a per-run NONCE, not the bare file path (Codex:
# "if base and branch exhaust their budgets before the same tail, those
# never-executed tests become 'pre-existing', and the gate passes" — a real
# branch regression in a base-skipped file would be silently forgiven). The
# nonce guarantees a budget-cut key can never coincide with a base-run's
# equivalent key, so land-gate-delta.js's diff always treats it as NEW —
# unconditionally blocking, never silently "pre-existing", exactly the same
# fail-closed direction as the existing "unlocated TAP failures are always
# NEW" rule for the TAP gates.
bash_integration() {
  local -a tests
  mapfile -t tests < <(node scripts/lib/bash-integration-test-list.js --list)
  if [ ${#tests[@]} -eq 0 ]; then echo "::error::bash-integration-test-list.js derived ZERO scripts/lib/*.test.sh files from test.yml — broken matcher?"; return 1; fi
  scope_list bash-integration tests
  echo "# bash integration: ${#tests[@]} files (derived from test.yml)"
  if [ ${#tests[@]} -eq 0 ]; then echo "bash-integration: none of the branch's failing files exist on this tree (BRO-5766)"; return 0; fi
  local deadline="${GAUNTLET_DEADLINE_SEC:-1800}"
  local reserve="${LINT_WORKFLOWS_RESERVE_SEC:-300}"
  local elapsed_so_far=$(( ($(node -p 'Date.now()') - T0) / 1000 ))
  local budget="${BASH_INTEGRATION_BUDGET_SEC:-$(( deadline - elapsed_so_far - reserve ))}"
  [ "$budget" -lt 60 ] && budget=60  # floor: always give this gate a real chance, even under a tight deadline
  echo "# bash-integration budget: ${budget}s (deadline ${deadline}s - ${elapsed_so_far}s already spent on earlier gates - ${reserve}s reserved for lint-workflows)"
  local nonce; nonce="$$-$(date +%s)"
  local start; start=$(date +%s)
  local FAILED="" f rf rc i=0 elapsed
  for f in ${tests[@]+"${tests[@]}"}; do
    i=$((i + 1))
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$budget" ]; then
      echo "::error::bash-integration total budget (${budget}s) exceeded after ${elapsed}s — $(( ${#tests[@]} - i + 1 )) file(s) never ran"
      for rf in ${tests[@]+"${tests[@]:$((i - 1))}"}; do
        echo "::error::bash-integration gate failed: $rf [budget-exceeded-${nonce}] (exit 124)"
        FAILED="$FAILED\n  - $rf (not run — budget exceeded)"
      done
      break
    fi
    echo "── $f"
    timeout 180 bash "$f"
    rc=$?
    # In the background lane these timing-sensitive files share the CPU with
    # the unit batches (BRO-5688), so a red file gets one retry there, as
    # toplevel-regression does. Serial mode is unchanged.
    if [ "$rc" -ne 0 ] && [ -n "${GAUNTLET_CHILD:-}" ] && [ $(( $(date +%s) - start )) -lt "$budget" ]; then
      echo "── $f exited $rc in the background lane; retrying once to rule out CPU contention"
      timeout 180 bash "$f"
      rc=$?
    fi
    if [ "$rc" -ne 0 ]; then
      echo "::error::bash-integration gate failed: $f (exit $rc)"
      FAILED="$FAILED\n  - $f"
    fi
  done
  if [ -n "$FAILED" ]; then
    printf "::error::bash-integration failures:%b\n" "$FAILED"
    return 1
  fi
  echo "bash-integration: all files green"
}
gate bash-integration bash_integration

# ── Standalone regression scripts (BRO-5117) ───────────────────────────────
# Keyed by failing file path (land-gate-delta.js), so only a newly-red file
# blocks; one already red on origin/main is pre-existing.
toplevel_regression() {
  local -a tests
  mapfile -t tests < <(node scripts/lib/land-gauntlet-toplevel-list.js --list)
  if [ ${#tests[@]} -eq 0 ]; then echo "::error::land-gauntlet-toplevel-list.js derived ZERO node scripts/test-*.js steps from test.yml — broken matcher?"; return 1; fi
  scope_list toplevel-regression tests
  echo "# toplevel regression: ${#tests[@]} files (derived from test.yml)"
  local FAILED="" f rc
  for f in ${tests[@]+"${tests[@]}"}; do
    echo "── $f"
    timeout 120 node "$f"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "── $f exited $rc; retrying once to rule out a flake"
      timeout 120 node "$f"
      rc=$?
    fi
    if [ "$rc" -ne 0 ]; then
      echo "::error::toplevel-regression gate failed: $f (exit $rc)"
      FAILED="$FAILED\n  - $f"
    fi
  done
  if [ -n "$FAILED" ]; then
    printf "::error::toplevel-regression failures:%b\n" "$FAILED"
    return 1
  fi
  echo "toplevel-regression: all files green"
}
gate toplevel-regression toplevel_regression

# ── Lint Workflows: actionlint + test.yml's lint-workflows audit list ──────
# ALL of them run (a failure does not short-circuit the rest) and every red
# one is named on its own `::error::lint-workflows gate failed: <label>` line —
# that line IS the failure key land-gate-delta.js diffs. Keep this list in
# step with test.yml's lint-workflows job. The commit-message escape hatches
# test.yml honours ([skip-actionlint], [skip-orphan-audit], [skip-cron-audit])
# apply here too.
lint_workflows() {
  local MSG FAILED=""
  MSG=$(git log -1 --format=%B)
  lwgate() {  # $1=label; rest = command
    local label="$1"; shift
    echo "── $label"
    "$@"
    local rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "::error::lint-workflows gate failed: $label (exit $rc)"
      FAILED="$FAILED\n  - $label"
    fi
  }
  if grep -Fq "[skip-actionlint]" <<<"$MSG"; then
    echo "::warning::actionlint check skipped via [skip-actionlint] commit-message tag"
  elif [ -z "${CI:-}" ] && ! command -v actionlint >/dev/null 2>&1; then
    echo "::warning::actionlint not installed here; CI runs it"
  else
    lwgate actionlint actionlint -color -shellcheck="" -ignore 'maximum number of inputs' .github/workflows/*.yml
  fi
  if grep -Fq "[skip-orphan-audit]" <<<"$MSG"; then
    echo "::warning::orphan-test audit + decayed-exemption check skipped via [skip-orphan-audit] commit-message tag"
  else
    lwgate audit-orphan-tests node scripts/audit-orphan-tests.js
    decayed() {
      local STALE="" f
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        if node --test --test-timeout 30000 "$f" > /dev/null 2>&1; then STALE="$STALE $f"; fi
      done < <(node scripts/audit-orphan-tests.js --list-exempt)
      if [ -n "$STALE" ]; then
        echo "::error::Decayed exemption(s) — these tests now pass and must be removed from EXEMPT_KNOWN_BROKEN in scripts/audit-orphan-tests.js:$STALE"
        return 1
      fi
      echo "All exemptions still failing — no decay."
    }
    lwgate decayed-exemptions decayed
  fi
  local s
  for s in \
    audit-workflow-concurrency \
    audit-aggregator-url-duplicates \
    audit-data-gate-heal-paths \
    audit-get-route-dispatch \
    audit-raw-mean-scores \
    audit-new-gate-arming \
    audit-workflow-hygiene \
    assert-broadcast-step-order \
    audit-test-yml-lib-deps \
    audit-unsafe-show-dir-listing \
    audit-test-yml-manifest-paths \
    audit-workflow-secret-gaps \
    audit-review-texts-test-yml-coverage \
    audit-toplevel-script-test-yml-coverage \
    audit-run-budget-coverage \
    audit-run-budget-slack \
    audit-alert-reachability \
    audit-core-data-writers \
    audit-push-core-data-audit-gap \
    audit-errexit-unguarded-substitution \
    audit-same-job-breadcrumb-coverage \
    audit-delete-without-breadcrumb \
    audit-linear-issuecreate-chokepoint \
    audit-launchd-stale-sync-guard \
    audit-gate-corpus-guard-coverage \
    audit-invisible-verification \
    audit-fetchpage-cleanup \
    audit-help-flag-safety \
    audit-duplicate-of-floor \
    audit-unbounded-fetch \
    audit-cmux-spawn-credential \
    audit-reconcile-coverage \
    audit-blanket-sweep-audit-writes \
    lint-resend-calls \
    lint-wrongproduction-provenance \
    lint-autoclear-invalidate \
    audit-digest-clip-safety \
    lint-committed-pii \
    audit-tests-vs-derived-data \
    audit-playwright-evaluate-click \
    test-data-write-guard; do
    lwgate "$s" node "scripts/$s.js"
  done
  # --fail-on-job-timeout matches test.yml; without it the job-timeout finding only warns (BRO-4737).
  lwgate audit-push-retry-budgets node scripts/audit-push-retry-budgets.js --fail-on-job-timeout --annotate
  lwgate audit-direct-provider-calls node scripts/audit-direct-provider-calls.js --strict
  lwgate audit-venue-write-guard node scripts/audit-venue-write-guard.js --strict
  lwgate audit-alert-senders node scripts/audit-alert-senders.js --check
  claude_md() {
    node -e '
      const fs = require("fs");
      const cfg = JSON.parse(fs.readFileSync("scripts/lib/claude-md-anchors.json", "utf8"));
      const md = fs.readFileSync("CLAUDE.md", "utf8");
      const missing = (cfg.anchors || []).filter(p => !md.includes(p));
      if (missing.length) { console.error("::error::CLAUDE.md missing required anchor phrase(s): " + missing.join(" | ")); process.exit(1); }
      const bytes = Buffer.byteLength(md, "utf8");
      if (cfg.byteLimit && bytes > cfg.byteLimit) { console.error(`::error::CLAUDE.md is ${bytes}B, over the ${cfg.byteLimit}B cap.`); process.exit(1); }
      console.log(`CLAUDE.md OK: ${cfg.anchors.length} anchors present, ${bytes}B <= ${cfg.byteLimit}B`);
    '
  }
  lwgate claude-md-integrity claude_md
  if grep -Fq "[skip-cron-audit]" <<<"$MSG"; then
    echo "::warning::cron-health coverage audit skipped via [skip-cron-audit] commit-message tag"
  else
    lwgate audit-cron-health-coverage node scripts/audit-cron-health-coverage.js
  fi
  local PWC
  PWC=$(node scripts/audit-playwright-count-assertions.js || true)
  echo "$PWC"
  if grep -q "unguarded count() assignment" <<<"$PWC"; then
    echo "::warning::Playwright count()-without-assertion pattern found — a selector drift here would silently pass having checked nothing."
  fi
  tony_loso() {
    # Against the whole rebased branch (BASE...HEAD), not HEAD~1: a
    # multi-commit branch must not dodge the gate by splitting commits.
    local BASE="${LAND_BASE:-}"
    if [ -z "$BASE" ]; then echo "LAND_BASE unset — skipping LOSO snapshot gate"; return 0; fi
    if ! git diff "$BASE" --name-only -- src/lib/data-tony-predictions.ts | grep -q .; then
      echo "data-tony-predictions.ts unchanged — skipping LOSO snapshot gate"; return 0
    fi
    if ! git diff "$BASE" -- src/lib/data-tony-predictions.ts | grep -E '^[+-][^+-]' | grep -vE '^[+-][[:space:]]*(//|\*)' | grep -qE 'TONY_RECIPES|categoryAwardsScore'; then
      echo "Only comments / unrelated lines changed — skipping LOSO snapshot gate"; return 0
    fi
    if git diff "$BASE" --name-only -- data/tony-loso-stats.json | grep -q .; then
      echo "Recipe changed AND snapshot updated — OK"; return 0
    fi
    echo "::error::TONY_RECIPES / categoryAwardsScore changed in src/lib/data-tony-predictions.ts but data/tony-loso-stats.json was not updated. Run: npx tsx scripts/audit-tony-loso.ts && git add data/tony-loso-stats.json"
    return 1
  }
  lwgate tony-loso-snapshot tony_loso
  symlinks() {
    local BAD
    BAD=$(git ls-files --stage | grep -E "^(120000|160000)" || true)
    if [ -n "$BAD" ]; then echo "::error::Tracked symlinks or gitlinks found:"; echo "$BAD"; return 1; fi
    echo "No tracked symlinks or gitlinks"
  }
  lwgate tracked-symlinks symlinks
  local g w
  for g in prebuild core-data-pairing private-git-add merge-drivers scraping-fallback scrapingdog-pairing theatr-token demo-flags alert-ledger-commit routealert-linear-key ledger-coverage ledger-step-guard reset-soft-partial-commit; do
    lwgate "lint-workflow-guards:$g" bash scripts/lint-workflow-guards.sh "$g"
  done
  for w in review-texts reviews-json shows-json commercial-json audience-buzz-json; do
    lwgate "lint-write-routing:$w" bash scripts/lint-write-routing.sh "$w"
  done
  if [ -n "$FAILED" ]; then
    printf "::error::lint-workflows failures:%b\n" "$FAILED"
    return 1
  fi
  echo "lint-workflows: all gates green"
}
gate lint-workflows lint_workflows

# The child records only its gates' .exit/.log files; the parent writes meta.json.
[ -n "${GAUNTLET_CHILD:-}" ] && exit 0
if [ -n "$BG_PID" ]; then
  wait "$BG_PID"; echo "background lane finished (exit $?)"; BG_PID=""
  # Not wrapped in ::group:: (the lane's own gate groups would close it early).
  echo "── background lane log ($BG_GATES) ──"; cat "$OUT/background-lane.log"
  for g in ${BG_GATES//,/ }; do
    [ -f "$OUT/$g.exit" ] || { echo "::error::background lane wrote no result for $g"; echo 1 > "$OUT/$g.exit"; echo "background lane wrote no result" > "$OUT/$g.log"; }
  done
fi

T1=$(node -p 'Date.now()')
node -e '
  const [out, sha, root, t0, t1] = process.argv.slice(1);
  const gates = require("fs").readdirSync(out).filter(f => f.endsWith(".exit")).map(f => f.replace(/\.exit$/, "")).sort();
  const exits = Object.fromEntries(gates.map(g => [g, Number(require("fs").readFileSync(`${out}/${g}.exit`, "utf8").trim())]));
  require("fs").writeFileSync(`${out}/meta.json`, JSON.stringify({ sha, root, wallMs: Number(t1) - Number(t0), finishedAt: new Date().toISOString(), node: process.version, gates, exits, checkedOut: process.argv[6] === "1", depsReinstalled: process.argv[7] === "1" }, null, 2) + "\n");
' "$OUT" "$SHA" "$ROOT" "$T0" "$T1" "$([ -n "$CHECKOUT" ] && echo 1 || echo 0)" "$DEPS_CHANGED"
echo "gauntlet done: $SHA in $(( (T1 - T0) / 1000 ))s → $OUT ($(tr '\n' ' ' < <(for g in "$OUT"/*.exit; do printf '%s=%s\n' "$(basename "${g%.exit}")" "$(cat "$g")"; done)))"
exit 0
