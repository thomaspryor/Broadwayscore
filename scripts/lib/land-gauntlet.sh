#!/usr/bin/env bash
# land-gauntlet.sh — run land.yml's check gauntlet against a checkout and
# record each gate's exit code + output, without failing itself.
#
#   bash land-gauntlet.sh <out-dir> [--checkout <sha> --return-to <sha>] [--deps-changed]
#
# Writes <out-dir>/<gate>.exit, <out-dir>/<gate>.log per gate and
# <out-dir>/meta.json ({sha, root, wallMs, gates, exits}). ALWAYS exits 0
# (except on a failed --checkout): the verdict is not "did any gate exit
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
#   with the same node_modules (Codex adversarial review).
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
# Env: LAND_BASE — the origin/main sha the tree was rebased onto (tony-loso
#   gate diffs against it; unset/empty → that gate is skipped with a note).
#   GH_TOKEN — for the audits that read the API. BSC_STAGE_LATENCY_MUTE=1 set
#   here as test.yml does.
set -uo pipefail

OUT="${1:?usage: land-gauntlet.sh <out-dir> [--checkout <sha> --return-to <sha>] [--deps-changed]}"
shift
CHECKOUT="" RETURN_TO="" DEPS_CHANGED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --checkout) CHECKOUT="${2:?--checkout needs a sha}"; shift 2 ;;
    --return-to) RETURN_TO="${2:?--return-to needs a sha}"; shift 2 ;;
    --deps-changed) DEPS_CHANGED=1; shift ;;
    *) echo "land-gauntlet.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [ -n "$CHECKOUT" ] && [ -z "$RETURN_TO" ]; then echo "land-gauntlet.sh: --checkout needs --return-to" >&2; exit 2; fi

npm_ci() { npm ci --prefer-offline --no-audit --no-fund > "$OUT/prep-npm-ci-$1.log" 2>&1 || echo "::warning::npm ci ($1) failed — see $OUT/prep-npm-ci-$1.log"; }
if [ -n "$CHECKOUT" ]; then
  return_to() {
    git checkout -q -f --detach "$RETURN_TO" || { echo "::error::could not return to ${RETURN_TO:0:10}"; exit 1; }
    [ "$DEPS_CHANGED" = 1 ] && npm_ci return
    echo "back on ${RETURN_TO:0:10}"
  }
  trap return_to EXIT
  git checkout -q -f --detach "$CHECKOUT" || { echo "::error::could not check out ${CHECKOUT:0:10}"; exit 1; }
  [ "$DEPS_CHANGED" = 1 ] && npm_ci checkout
  echo "judging ${CHECKOUT:0:10} (will return to ${RETURN_TO:0:10})"
fi

mkdir -p "$OUT"
ROOT=$(git rev-parse --show-toplevel)
SHA=$(git rev-parse HEAD)
T0=$(node -p 'Date.now()')
export BSC_STAGE_LATENCY_MUTE=1

# gate <name> <cmd…>: capture the command's stdout+stderr to <name>.log (and
# echo it into a collapsed log group), record the exit code, never abort.
gate() {
  local name="$1"; shift
  echo "::group::gate $name — $*"
  "$@" 2>&1 | tee "$OUT/$name.log"
  local rc=${PIPESTATUS[0]}
  echo "::endgroup::"
  echo "$rc" > "$OUT/$name.exit"
  echo "gate $name: exit $rc"
}

# ── prep (not gates): gold lists + gitignored manifests ────────────────────
node scripts/compute-gold-lists.js > "$OUT/prep-gold-lists.log" 2>&1 || echo "::warning::compute-gold-lists.js failed (see $OUT/prep-gold-lists.log) — data-dependent tests may fail"

# ── TypeScript Check ───────────────────────────────────────────────────────
gate tsc npx tsc --noEmit
gate tsc-llm-scoring npx tsc --noEmit -p scripts/llm-scoring/tsconfig.json
gate next-lint npx next lint

# ── Unit Tests: the two in-repo batches, each its own gate, BOTH always run ──
# Same manifests and per-test timeout as test.yml's "Run unit tests
# (no-data-dependency)". --test-reporter=tap pinned so land-gate-delta.js can
# key failures by file::name regardless of the Node default reporter.
unit_tests_node() {
  local -a tests
  mapfile -t tests < tests/unit-test-manifest.txt 2>/dev/null
  if [ ${#tests[@]} -eq 0 ]; then echo "::error::tests/unit-test-manifest.txt is empty or missing"; return 1; fi
  echo "# node batch: ${#tests[@]} files"
  node --test --test-reporter=tap --test-timeout 300000 "${tests[@]}"
}
gate unit-tests-node unit_tests_node

unit_tests_tsx() {
  local -a tests
  mapfile -t tests < tests/unit-test-manifest-tsx.txt 2>/dev/null
  if [ ${#tests[@]} -eq 0 ]; then echo "::error::tests/unit-test-manifest-tsx.txt is empty or missing"; return 1; fi
  echo "# tsx batch: ${#tests[@]} files"
  npx tsx --test --test-reporter=tap --test-timeout 300000 "${tests[@]}"
}
gate unit-tests-tsx unit_tests_tsx

scripts_lib_tests() {
  shopt -s nullglob
  local -a tests=(scripts/lib/*.test.mjs)
  if [ ${#tests[@]} -eq 0 ]; then echo "no scripts/lib tests"; return 0; fi
  node --test --test-reporter=tap --test-timeout 300000 "${tests[@]}"
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
# gate that still has to run after this one. GAUNTLET_DEADLINE_SEC (default
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
  echo "# bash integration: ${#tests[@]} files (derived from test.yml)"
  local deadline="${GAUNTLET_DEADLINE_SEC:-1800}"
  local reserve="${LINT_WORKFLOWS_RESERVE_SEC:-300}"
  local elapsed_so_far=$(( ($(node -p 'Date.now()') - T0) / 1000 ))
  local budget="${BASH_INTEGRATION_BUDGET_SEC:-$(( deadline - elapsed_so_far - reserve ))}"
  [ "$budget" -lt 60 ] && budget=60  # floor: always give this gate a real chance, even under a tight deadline
  echo "# bash-integration budget: ${budget}s (deadline ${deadline}s - ${elapsed_so_far}s already spent on earlier gates - ${reserve}s reserved for lint-workflows)"
  local nonce; nonce="$$-$(date +%s)"
  local start; start=$(date +%s)
  local FAILED="" f rf rc i=0 elapsed
  for f in "${tests[@]}"; do
    i=$((i + 1))
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$budget" ]; then
      echo "::error::bash-integration total budget (${budget}s) exceeded after ${elapsed}s — $(( ${#tests[@]} - i + 1 )) file(s) never ran"
      for rf in "${tests[@]:$((i - 1))}"; do
        echo "::error::bash-integration gate failed: $rf [budget-exceeded-${nonce}] (exit 124)"
        FAILED="$FAILED\n  - $rf (not run — budget exceeded)"
      done
      break
    fi
    echo "── $f"
    timeout 180 bash "$f"
    rc=$?
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
  if echo "$MSG" | grep -Fq "[skip-actionlint]"; then
    echo "::warning::actionlint check skipped via [skip-actionlint] commit-message tag"
  else
    lwgate actionlint actionlint -color -shellcheck="" -ignore 'maximum number of inputs' .github/workflows/*.yml
  fi
  if echo "$MSG" | grep -Fq "[skip-orphan-audit]"; then
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
    audit-data-gate-heal-paths \
    audit-workflow-hygiene \
    assert-broadcast-step-order \
    audit-test-yml-lib-deps \
    audit-test-yml-manifest-paths \
    audit-workflow-secret-gaps \
    audit-review-texts-test-yml-coverage \
    audit-toplevel-script-test-yml-coverage \
    audit-run-budget-coverage \
    audit-alert-reachability \
    audit-push-core-data-audit-gap \
    audit-errexit-unguarded-substitution \
    audit-same-job-breadcrumb-coverage \
    audit-delete-without-breadcrumb \
    audit-push-retry-budgets \
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
    lint-resend-calls \
    lint-wrongproduction-provenance \
    audit-digest-clip-safety \
    lint-committed-pii \
    audit-tests-vs-derived-data \
    audit-playwright-evaluate-click \
    test-data-write-guard; do
    lwgate "$s" node "scripts/$s.js"
  done
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
  if echo "$MSG" | grep -Fq "[skip-cron-audit]"; then
    echo "::warning::cron-health coverage audit skipped via [skip-cron-audit] commit-message tag"
  else
    lwgate audit-cron-health-coverage node scripts/audit-cron-health-coverage.js
  fi
  local PWC
  PWC=$(node scripts/audit-playwright-count-assertions.js || true)
  echo "$PWC"
  if echo "$PWC" | grep -q "unguarded count() assignment"; then
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
  for g in prebuild core-data-pairing private-git-add merge-drivers scraping-fallback scrapingdog-pairing theatr-token demo-flags alert-ledger-commit ledger-coverage ledger-step-guard reset-soft-partial-commit; do
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

T1=$(node -p 'Date.now()')
node -e '
  const [out, sha, root, t0, t1] = process.argv.slice(1);
  const gates = require("fs").readdirSync(out).filter(f => f.endsWith(".exit")).map(f => f.replace(/\.exit$/, "")).sort();
  const exits = Object.fromEntries(gates.map(g => [g, Number(require("fs").readFileSync(`${out}/${g}.exit`, "utf8").trim())]));
  require("fs").writeFileSync(`${out}/meta.json`, JSON.stringify({ sha, root, wallMs: Number(t1) - Number(t0), finishedAt: new Date().toISOString(), node: process.version, gates, exits, checkedOut: process.argv[6] === "1", depsReinstalled: process.argv[7] === "1" }, null, 2) + "\n");
' "$OUT" "$SHA" "$ROOT" "$T0" "$T1" "$([ -n "$CHECKOUT" ] && echo 1 || echo 0)" "$DEPS_CHANGED"
echo "gauntlet done: $SHA in $(( (T1 - T0) / 1000 ))s → $OUT ($(tr '\n' ' ' < <(for g in "$OUT"/*.exit; do printf '%s=%s\n' "$(basename "${g%.exit}")" "$(cat "$g")"; done)))"
exit 0
