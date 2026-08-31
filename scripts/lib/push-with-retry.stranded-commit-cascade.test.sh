#!/usr/bin/env bash
# BRO-2538 / BRO-2588: push-with-retry.sh's Git Data API fallback disqualifier
# was reported to fire on a step whose OWN commit only touched apiFallbackSafe
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
# FOUR separate commit+push-with-retry.sh steps in ONE job/checkout. If one of
# them commits a path that is NOT registered apiFallbackSafe and its own
# push-with-retry.sh call exhausts BOTH the local retry loop and the Git Data
# API fallback, that commit stays on local HEAD, UNPUSHED (a GitHub Actions
# runner never rolls back a step's git state — and a `continue-on-error: true`
# step does not even fail the job on the way out). A LATER commit+push-with-
# retry.sh step in the SAME job/checkout then inherits that stranded commit as
# an ancestor of its own SCRIPT_ENTRY_HEAD — so its "own diff" legitimately
# includes the earlier non-safe file, and the disqualifier (working exactly as
# designed: bundling an unaudited data/audit/ path into an "ours wins
# outright" force-overlay push genuinely IS unsafe, regardless of which step's
# commit introduced it) refuses the fallback for a later step whose OWN work
# was 100% safe.
#
# PART A reproduces this end-to-end against the real, unmodified
# push-with-retry.sh — it documents a real, BY-DESIGN property of the script
# (not a bug to fix there). Its stranding fixture uses
# data/audit/alert-ledger.json: a genuinely multi-writer (12 writers), NOT-
# apiFallbackSafe path that data-health-check.yml really does stage in its
# bulk commit step. It deliberately no longer uses data/audit/autonomous-
# recheck-ledger.jsonl — BRO-2588 registered that file apiFallbackSafe, so it
# stopped disqualifying anything and would have silently turned PART A into a
# no-op assertion. PART A is expected to PASS regardless of the workflow's
# step order — it is not the regression guard.
#
# PART B is the actual regression guard, and it is REGISTRY-DRIVEN rather than
# order-by-name (BRO-2588 replaced BRO-2538's "the ledger step must be last"
# assertion, which contradicted BRO-386's own acceptance property that the
# ledger commit lands BEFORE the bulk commit — two suites asserting mutually
# exclusive orderings, so one of them was always red). The property it asserts
# is the real safety invariant underneath both:
#
#   For every step in data-health-check.yml that calls push-with-retry.sh,
#   every path it `git add`s must be registered apiFallbackSafe in
#   scripts/lib/core-data-merge-registry.js — UNLESS it is the LAST such step
#   in the job (nothing after it can inherit its stranding).
#
# That single property fails on BOTH failure modes: a bad reorder (a step
# staging unaudited paths moved ahead of another commit+push step) AND a
# rollback of an apiFallbackSafe flag that a non-last step depends on.
#
# Run: bash scripts/lib/push-with-retry.stranded-commit-cascade.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUSH_SCRIPT="$SCRIPT_DIR/push-with-retry.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Single source for the registry module both PART A's premise probe and PART B
# read (scripts/lib/reconcile-merged-json.js re-exports API_FALLBACK_SAFE from
# core-data-merge-registry.js — the same list push-with-retry.sh's runtime
# disqualifier consults).
REGISTRY_PROBE_MODULE="$SCRIPT_DIR/reconcile-merged-json.js"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

gitc() { git -C "$1" "${@:2}"; }
REAL_GIT_BIN="$(command -v git)"

echo "=== PART A: reproduce the stranded-commit cascade against the real script ==="

# Guard the fixture's own premise: this path must NOT be registered
# apiFallbackSafe, or step 1's stranded commit would be audited and the
# disqualifier this part exists to observe would (correctly) never fire —
# leaving PART A silently asserting nothing, which is exactly how the previous
# fixture (autonomous-recheck-ledger.jsonl) would have decayed under BRO-2588.
STRANDED_PATH="data/audit/alert-ledger.json"
# The probe must not fail OPEN. Running it bare inside `if ... 2>/dev/null`
# collapsed two very different outcomes into the same "exit non-zero" branch:
# the intended PASS (path genuinely not registered, exit 1) and the probe
# itself throwing (module renamed, API_FALLBACK_SAFE export renamed, syntax
# error — exit 1 from node with the stderr swallowed). The second case would
# have printed PASS[A-premise] forever, which is exactly the silent decay this
# block exists to prevent. So: capture the exit code, and treat anything that
# is not a clean 0 or 1 — or ANY stderr output at all — as a hard FAIL.
PREMISE_ERR="$TMP/a-premise.stderr"
node -e '
    const { API_FALLBACK_SAFE } = require(process.argv[1]);
    if (!Array.isArray(API_FALLBACK_SAFE)) throw new Error("API_FALLBACK_SAFE is not an array");
    process.exit(API_FALLBACK_SAFE.some((e) => e.file === process.argv[2]) ? 0 : 1);
  ' "$REGISTRY_PROBE_MODULE" "$STRANDED_PATH" 2>"$PREMISE_ERR"
premise_code=$?
premise_err="$(cat "$PREMISE_ERR" 2>/dev/null)"
if [ "$premise_code" -gt 1 ] || [ -n "$premise_err" ]; then
  echo "FAIL[A-premise]: the apiFallbackSafe registration probe itself FAILED (exit $premise_code) — it could"
  echo "         not answer whether $STRANDED_PATH is registered, so this fixture's premise is"
  echo "         unverified, NOT confirmed. Most likely $REGISTRY_PROBE_MODULE was renamed/moved or"
  echo "         its API_FALLBACK_SAFE export was renamed. Probe stderr:"
  echo "${premise_err:-(none)}" | sed 's/^/           /'
  fail=1
elif [ "$premise_code" -eq 0 ]; then
  echo "FAIL[A-premise]: $STRANDED_PATH IS registered apiFallbackSafe — this fixture needs a"
  echo "         genuinely unregistered data/audit/ path to strand, or PART A asserts nothing."
  fail=1
else
  echo "PASS[A-premise]: $STRANDED_PATH is not apiFallbackSafe — a valid stranding fixture"
fi

mkdir -p "$TMP/fakebin"
cat > "$TMP/fakebin/git" <<WRAPPER
#!/usr/bin/env bash
for a in "\$@"; do
  [ "\$a" = "push" ] && { echo "fake-git: forcing push to fail" >&2; exit 1; }
done
exec "$REAL_GIT_BIN" "\$@"
WRAPPER
chmod +x "$TMP/fakebin/git"

# A broken fixture must NEVER reach the PART A assertion: an assertion that
# fires on a repo the script never really got to inspect reports the wrong
# cause and sends the next reader hunting a disqualifier bug that isn't there.
# So every environment assumption below is checked, and any missing one aborts
# HERE, naming the precondition.
die_precondition() {
  echo "FAIL[A-precondition]: $1"
  echo "         The PART A fixture is not in the state this test requires, so its disqualifier"
  echo "         assertion would be meaningless (pass OR fail). Refusing to report either."
  echo
  echo "=== push-with-retry.stranded-commit-cascade.test.sh FAILED ==="
  exit 1
}

# --initial-branch=main is LOAD-BEARING, not cosmetic (CI failure, 2026-08-31).
# `git init --bare` points the new repo's HEAD at init.defaultBranch. On this
# repo's dev Macs Xcode's system gitconfig sets that to `main`, but a stock
# GitHub Actions runner has it unset, so HEAD became refs/heads/master while
# the seed pushed refs/heads/main. `git clone` of that origin then warned
# "remote HEAD refers to nonexistent ref, unable to checkout" and produced an
# EMPTY working tree on an UNBORN master: every later `printf > runner/...`
# failed, every commit was a no-op, and push-with-retry.sh's orphan guard
# (assert_no_orphan_commit, push-with-retry.sh:318 — `git rev-list --parents
# origin/main..HEAD` on an unborn HEAD) aborted BOTH steps before the
# apiFallbackSafe disqualifier was ever consulted. PART A then failed with
# "expected the disqualifier to fire", pointing at the wrong subsystem.
git init -q --bare --initial-branch=main "$TMP/origin.git" \
  || die_precondition "could not create the bare origin at \$TMP/origin.git with --initial-branch=main (git >= 2.28 required)"
git init -q --initial-branch=main "$TMP/seed" \
  || die_precondition "could not create the seed repo at \$TMP/seed with --initial-branch=main (git >= 2.28 required)"
gitc "$TMP/seed" config user.email t@t.t; gitc "$TMP/seed" config user.name t
mkdir -p "$TMP/seed/data/audit"
printf '{}\n' > "$TMP/seed/$STRANDED_PATH"
printf '{"runs":[1]}\n' > "$TMP/seed/data/audit/health-check-history.json"
gitc "$TMP/seed" add -A; gitc "$TMP/seed" commit -q -m seed
gitc "$TMP/seed" branch -M main; gitc "$TMP/seed" push -q "$TMP/origin.git" main \
  || die_precondition "seed push of branch main to \$TMP/origin.git failed"

git clone -q "file://$TMP/origin.git" "$TMP/runner" \
  || die_precondition "clone of the bare origin into \$TMP/runner failed"
gitc "$TMP/runner" config user.email t@t.t; gitc "$TMP/runner" config user.name t

# Preconditions the rest of PART A silently depended on until 2026-08-31.
gitc "$TMP/runner" rev-parse --verify --quiet HEAD >/dev/null \
  || die_precondition "the runner clone has an UNBORN HEAD (nothing checked out). The bare origin's HEAD does not point at the branch the seed pushed, so clone checked nothing out. Every commit below would be a no-op and push-with-retry.sh's orphan guard would abort before the disqualifier."
gitc "$TMP/runner" rev-parse --verify --quiet origin/main >/dev/null \
  || die_precondition "the runner clone has no origin/main ref. push-with-retry.sh's assert_no_orphan_commit fails open without it and its diff/disqualifier logic has no base to compare against."
[ "$(gitc "$TMP/runner" symbolic-ref --short -q HEAD)" = "main" ] \
  || die_precondition "the runner clone is not on branch main (on '$(gitc "$TMP/runner" symbolic-ref --short -q HEAD || echo "detached/unborn")'), but push-with-retry.sh is invoked below with branch 'main'."
for required in "$STRANDED_PATH" "data/audit/health-check-history.json"; do
  [ -f "$TMP/runner/$required" ] \
    || die_precondition "$required is missing from the runner clone's working tree — the seeded checkout is incomplete, so the commits below would stage nothing."
done

# Commits are the fixture, not incidental setup: a `git commit` that no-ops
# (nothing staged) leaves HEAD where it was and turns the whole cascade into a
# test of an empty range. Assert each one actually advanced HEAD.
commit_step() {  # commit_step <repo> <message> <label>
  local repo="$1" msg="$2" label="$3" before after
  before="$(gitc "$repo" rev-parse HEAD)"
  gitc "$repo" commit -q -m "$msg" || die_precondition "$label: git commit failed"
  after="$(gitc "$repo" rev-parse HEAD)"
  [ "$before" != "$after" ] \
    || die_precondition "$label: git commit did not advance HEAD (nothing was staged) — the fixture has no commit to strand."
}

# A "Commit health check + triage data"-shaped step: it stages a genuinely
# multi-writer, NOT-apiFallbackSafe path. Its own push-with-retry.sh call
# always fails here (simulated contention), so its commit strands.
printf '{"n":1}\n' > "$TMP/runner/$STRANDED_PATH"
gitc "$TMP/runner" add -A
commit_step "$TMP/runner" "data: Update health check + triage state [skip ci]" "step 1 (stranding commit)"

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
  # A non-zero exit alone is NOT evidence the fixture worked: push-with-retry.sh
  # also exits non-zero when one of its corruption guards aborts, which is
  # exactly how the broken-clone bug above hid for so long (this branch printed
  # PASS while the run had actually died in assert_no_orphan_commit).
  grep -q "an outgoing commit has NO parent" <<<"$step1_out" \
    && die_precondition "step 1 died in push-with-retry.sh's orphan-commit guard, not in the simulated push contention this fixture intends. Guard output:
$(echo "$step1_out" | sed 's/^/           /')"
  # The stranded commit must genuinely still be on local HEAD and absent from origin.
  [ "$(gitc "$TMP/runner" rev-list --count origin/main..HEAD)" -ge 1 ] \
    || die_precondition "step 1's commit is not stranded ahead of origin/main — there is nothing for step 2 to inherit."
  gitc "$TMP/runner" diff --name-only origin/main..HEAD | grep -qx "$STRANDED_PATH" \
    || die_precondition "the commit stranded ahead of origin/main does not touch $STRANDED_PATH, so it cannot disqualify step 2's fallback."
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
gitc "$TMP/runner" add -- data/audit/health-check-history.json \
  || die_precondition "step 2: could not stage data/audit/health-check-history.json in the runner clone"
commit_step "$TMP/runner" "data: Update health check audit snapshots [skip ci]" "step 2 (apiFallbackSafe-only commit)"

step2_out=$(
  cd "$TMP/runner" && \
  PATH="$TMP/fakebin:$PATH" \
  GITHUB_ACTIONS=true PUSH_SKIP_UNSHALLOW=1 GIT_NET_TIMEOUT_SEC=10 PUSH_DEADLINE_SEC=30 \
  bash "$PUSH_SCRIPT" 3 main 2>&1
); step2_code=$?

# Same reasoning as step 1: if step 2 never got past a corruption guard, the
# disqualifier was never consulted and "it did not fire" says nothing about the
# disqualifier.
grep -q "an outgoing commit has NO parent" <<<"$step2_out" \
  && die_precondition "step 2 died in push-with-retry.sh's orphan-commit guard before the apiFallbackSafe disqualifier was reached. Guard output:
$(echo "$step2_out" | sed 's/^/           /')"

if grep -q "skipping Git Data API fallback — our outgoing diff touches" <<<"$step2_out"; then
  echo "PASS[A]: reproduced — step 2's OWN commit was 100% apiFallbackSafe, but its fallback was"
  echo "         disqualified by step 1's stranded, unrelated, non-safe commit (expected, by design)."
else
  echo "FAIL[A]: expected the disqualifier to fire (documenting the by-design cascade) but it did not."
  echo "$step2_out" | sed 's/^/    /'
  fail=1
fi

echo
echo "=== PART B: regression guard — every non-last commit+push step stages only apiFallbackSafe paths ==="

# Codex adversarial review finding (BRO-2538): checking that one named step
# merely sits after a second named step and before a third is fragile — a
# FIFTH commit+push-with-retry.sh step inserted between them would silently
# defeat the fix and still pass. BRO-2588 goes one further and drops step
# NAMES from the assertion entirely: enumerate every step whose OWN `run:`
# body actually invokes push-with-retry.sh, read the paths it `git add`s, and
# require every one of them to be registered apiFallbackSafe — except for the
# LAST such step, which has nothing after it to poison. Name-free, so it keeps
# holding through renames, insertions and reorders, and it reads the SAME
# registry the runtime disqualifier reads (scripts/lib/reconcile-merged-
# json.js's API_FALLBACK_SAFE, derived from core-data-merge-registry.js) — so
# a flag rollback fails here too, not only a reorder.
WORKFLOW="$REPO_ROOT/.github/workflows/data-health-check.yml"
if [ ! -f "$WORKFLOW" ]; then
  echo "FAIL[B]: $WORKFLOW not found"
  fail=1
else
  B_RESULT=$(node -e '
    const fs = require("fs");
    const { API_FALLBACK_SAFE } = require(process.argv[2]);
    const SAFE = new Set(API_FALLBACK_SAFE.map((e) => e.file));
    const lines = fs.readFileSync(process.argv[1], "utf8").split("\n");
    const stepStartRe = /^\s{6}- name: (.+?)\s*$/; // steps in this job are indented 6 spaces
    const steps = [];
    lines.forEach((line, i) => {
      const m = line.match(stepStartRe);
      if (m) steps.push({ name: m[1], start: i }); // 0-indexed
    });
    if (steps.length === 0) { console.log("ERROR|no steps found"); process.exit(1); }

    // Only lines from an ACTUAL run: block count (indented 8+ spaces here, vs.
    // 6-space step-level comments) — a step slice runs to the NEXT step start,
    // so it also sweeps in that next steps header comments, which in this
    // workflow routinely mention push-with-retry.sh and name the files a
    // commit step stages. Neither may be mistaken for a real call or a real
    // git add.
    const runBody = (s) => lines.slice(s.start, s.end).filter((line) => {
      const trimmed = line.replace(/^\s+/, "");
      const indent = line.length - trimmed.length;
      return indent >= 8 && !trimmed.startsWith("#");
    });

    // Paths staged by a line, covering both shapes used in this repo:
    // `git add <paths...>` and `bash scripts/lib/git-add-existing.sh <paths...>`.
    //
    // A stage-EVERYTHING invocation is an automatic violation, never "zero
    // paths, nothing to check": `git add -A` (or --all / -u / --update) stages
    // every changed path in the tree, which in this job means every unaudited
    // data/audit/* file the health-check run happened to touch — precisely the
    // stranded-poisoning-commit regression this guard exists to catch. Simply
    // skipping tokens that start with "-" made the guard blind to it: the
    // extracted path list came back EMPTY and the step passed. The same
    // reasoning applies to any matched `git add` that yields no concrete path
    // (an unrecognised shape is not evidence of safety), so an empty list is
    // reported too. `git add .` and `git add data/audit/` were already caught,
    // since "." and "data/audit/" are concrete tokens absent from the registry.
    const STAGE_ALL_FLAGS = new Set(["-A", "--all", "-u", "--update"]);
    const STAGE_ALL_MARKER = "EVERY changed path (stage-everything `git add`, e.g. -A/--all/-u)";
    const pathsFrom = (line) => {
      const m = line.match(/\bgit add\s+(.*)$/) || line.match(/git-add-existing\.sh\s+(.*)$/);
      if (!m) return [];
      const out = [];
      let stagesEverything = false;
      for (const tok of m[1].trim().split(/\s+/)) {
        if (/^(2>|1>|>|\|\||&&|;|#)/.test(tok) || tok === "true") break;
        if (tok.startsWith("-")) {
          if (STAGE_ALL_FLAGS.has(tok)) stagesEverything = true;
          continue; // other flags: --, -f, ...
        }
        out.push(tok.replace(/^["\x27]+|["\x27]+$/g, ""));
      }
      if (stagesEverything || out.length === 0) return [STAGE_ALL_MARKER];
      return out;
    };

    steps.forEach((s, i) => {
      s.end = i + 1 < steps.length ? steps[i + 1].start : lines.length;
      const body = runBody(s);
      s.callsPushRetry = body.some((line) => /push-with-retry\.sh/.test(line));
      s.adds = body.flatMap(pathsFrom);
    });

    const callers = steps.filter((s) => s.callsPushRetry);
    if (callers.length === 0) { console.log("ERROR|no step calls push-with-retry.sh"); process.exit(1); }
    if (callers.length < 2) { console.log("ERROR|only one push-with-retry.sh-calling step remains — this property is vacuous, the workflow changed shape"); process.exit(1); }

    const names = callers.map((s) => `${s.name}@L${s.start + 1}`).join(" -> ");
    const violations = [];
    for (const s of callers.slice(0, -1)) {
      for (const p of s.adds) {
        if (!SAFE.has(p)) violations.push(`"${s.name}"@L${s.start + 1} stages ${p}`);
      }
    }
    if (violations.length === 0) {
      console.log(`OK|${names}`);
    } else {
      console.log(`FAIL|${names}|${violations.join("; ")}`);
    }
  ' "$WORKFLOW" "$REGISTRY_PROBE_MODULE")
  B_STATUS="${B_RESULT%%|*}"
  B_REST="${B_RESULT#*|}"
  if [ "$B_STATUS" = "OK" ]; then
    echo "PASS[B]: every push-with-retry.sh-calling step except the last stages only apiFallbackSafe"
    echo "         paths, in this job's execution order: $B_REST"
  else
    echo "FAIL[B]: $B_REST"
    echo "         This is the BRO-2538/BRO-2588 regression: a step that can strand a commit"
    echo "         touching a non-apiFallbackSafe path must be the LAST commit+push step in this"
    echo "         job — otherwise its stranded commit poisons a later step's Git Data API"
    echo "         fallback. Either register those paths (with real single-writer verification)"
    echo "         in scripts/lib/core-data-merge-registry.js, or move that step to the end."
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then echo; echo "=== push-with-retry.stranded-commit-cascade.test.sh FAILED ==="; exit 1; fi
echo
echo "=== push-with-retry.stranded-commit-cascade.test.sh PASSED ==="
