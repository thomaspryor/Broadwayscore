#!/usr/bin/env node
'use strict';
//
// merge-post-merge-test-gate.js — post-merge TEST floor for merge-worktree-to-main.sh
// (task #1149).
//
// WHY THIS EXISTS
//   merge-worktree-to-main.sh already has a post-merge SYNTAX floor (`node
//   --check` on changed scripts/ files) but nothing that runs TESTS against
//   the merged tree. Syntax can't catch a semantic collision: two branches
//   can each be individually correct and pass their own pre-merge test runs,
//   yet the MERGED tree fails a colocated contract test that only exists
//   because of the OTHER branch. Reproduced 2026-08-09: a worktree branched
//   at 16:24, another session's commit (ingest-skip-classify.js + its
//   contract test) landed on origin at 16:31, local runs at 16:33-16:38 were
//   green because that test didn't exist yet at the branch point, the merge
//   script folded origin in at 16:41 and pushed, and CI went red minutes
//   later on "every skip reason review-file-writer.js emits is classified".
//   Running the full suite BEFORE the merge (what the worktree session had
//   already done) cannot catch this class — the colliding test only exists
//   WITH the merge. This module runs the colocated scripts/lib/*.test.mjs
//   suite AFTER the merge and BEFORE the push, so a real failure leaves the
//   branch intact instead of shipping it.
//
// SCOPE
//   Two change classes, each mapped to the tests that can catch its
//   collisions. A merge touching neither still runs nothing.
//
//   scripts/lib/**  -> scripts/lib/*.test.mjs (the same glob CI's "Run
//   scripts/lib tests" step already runs). That's the shape most susceptible
//   to the collision above (many independent sessions land colocated lib
//   helpers + contract tests concurrently) and it's fast (~4min, matching CI).
//
//   .github/workflows/**  -> the workflow-subject guards under tests/unit/
//   (BRO-2785). Added 2026-09-04 after a workflow-only merge reported a clean
//   green and reddened main minutes later: the floor was scoped to
//   scripts/lib/ alone, so a diff touching ONLY .github/workflows/** selected
//   no tests, and runTestGate returned {ran:false, passed:true} — a skip that
//   is indistinguishable from a pass in the log. The concrete miss was a
//   504-char line against the 500-char cap in
//   tests/unit/workflow-line-length.test.mjs; CI on main was the first signal,
//   i.e. after main was already red. Note the "Lint Workflows" job (actionlint)
//   passed that same run, so actionlint does NOT subsume these guards.
//
//   COST: a workflow-touching merge pays one ~29s run (26 files, 384 tests,
//   measured 2026-09-04) where before it ran nothing at all. Guards that
//   cannot pass locally are excluded by name — see EXCLUDED_WORKFLOW_GUARDS —
//   so the normal case passes on the merged run and never builds a baseline
//   checkout.
//
//   KNOWN LIMIT — same-key masking on AGGREGATE guards. The baseline diff
//   keys failures by <file>::<test name> (parseTapOutput), so a guard that
//   makes ONE assertion over MANY inputs reports the same key no matter which
//   input violated it. workflow-line-length.test.mjs is exactly that shape:
//   one test over every workflow file. If origin/main is ALREADY failing it,
//   a NEW violation added by the merge produces the same key, matches the
//   baseline, and is classified pre-existing — so it does not block. This is
//   a property of the #1433 baseline design rather than of workflow coverage
//   specifically, and it degrades gracefully: the floor still catches the
//   case that actually happened in BRO-2785 (main GREEN on the guard, the
//   merge breaks it). It is NOT a reason to skip the floor — before this,
//   that case was not caught either. Tracked separately; do not read a green
//   floor as proof when main is already red on an aggregate guard.
//
//   Guard selection is REQUIRED + DISCOVERED - EXCLUDED (see the three
//   definitions below listTestFiles). The required list pins the guards that
//   must never silently drop out; content discovery adds any newly written
//   guard without editing this file, keeping the self-maintaining property the
//   scripts/lib/ glob has. Measured 2026-09-04: 25 files, ~29s — cheap enough
//   for a merge gate.
//
//   A broader floor (the full suite) would slow every merge down for classes
//   these globs don't see; widen the scope here if such a class recurs.
//
// BASELINE DIFF (card #1433)
//   The floor above blocked on ANY failing test, including ones that were
//   ALREADY red on origin/main before the branch touched anything — 3
//   main-red incidents in 3 days traced to exactly that gap (a branch gets
//   refused for a stale assertion some OTHER refactor broke). When the
//   merged-tree run fails, this module now builds a disposable checkout of
//   the origin SHA the merge actually pulled in (reusing
//   scripts/lib/acceptance-check-core.js's makeFreshCheckout/removeCheckout —
//   already handles node_modules linking, shallow-fetch bounds, timeouts,
//   cleanup-on-error) and re-runs the same colocated suite there. Failures
//   from both runs are parsed into `<repo-relative-file>::<test name>` keys
//   (scripts/lib/tap-failure-parser.js) and diffed: only a failure that is
//   NEW (absent from the baseline) blocks the merge. A failure present in
//   BOTH is reported loudly (still a real bug — file a card) but does not
//   block THIS merge, which didn't cause it and often can't fix it in scope.
//   Baseline mode only runs on the (rarer) failing path — a clean merge pays
//   zero extra cost. If the baseline checkout itself can't be built (network,
//   worktree lock, missing node_modules), this fails SAFE to the pre-#1433
//   behavior: block on the merged-tree failure, since provenance can't be
//   distinguished. Kill switch: MERGE_TEST_GATE_SKIP_BASELINE=1 forces that
//   same old all-or-nothing behavior unconditionally.
//
// USAGE (CLI)
//   printf '%s\n' "${CHANGED_FILES[@]}" | node scripts/lib/merge-post-merge-test-gate.js
//   Reads newline-separated changed file paths (relative to repo root) from
//   stdin, runs the gate against CWD (must be the repo root — or a directory
//   with a scripts/lib/ subdir for tests). Exit 0 = passed or not applicable.
//   Exit 1 = a NEW colocated-test failure in the merged tree — DO NOT PUSH.
//   Optional env MERGE_TEST_GATE_BASELINE_SHA pins the baseline checkout to
//   that exact commit (merge-worktree-to-main.sh passes its own
//   $ORIGIN_BASE_SHA); without it, the baseline checkout resolves to whatever
//   origin/main is at call time.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseTapOutput } = require('./tap-failure-parser.js');
const { execErrorDetail } = require('./exec-error-detail.js');

// Matches acceptance-check-core.js's own CHECK_TIMEOUT_MS convention — "a
// hang is worse than a failure" applies equally to this gate's two spawns.
const TEST_GATE_TIMEOUT_MS = 5 * 60 * 1000;

// node's TAP `location:` line reports the REAL (symlink-resolved) path, but a
// tmpdir root (e.g. acceptance-check-core.js's baseline checkout, always
// under os.tmpdir()) can be a symlink on macOS (/var/folders/... ->
// /private/var/folders/...) — path.relative(unresolved, resolved) then
// produces a bogus `../../../private/var/...` key instead of the intended
// repo-relative one, silently breaking the whole baseline diff (every
// baseline failure key stops matching its merged-tree counterpart, so
// EVERYTHING misreads as "new"). Resolve before handing to parseTapOutput;
// fail open to the original path if the root doesn't exist yet.
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// The two change-class prefixes the floor knows how to test. Kept as named
// constants because both shouldRunTestGate() and selectTestFiles() must agree
// on them: if they ever disagree, the gate either runs nothing while claiming
// to have run (the BRO-2785 failure mode) or spawns `node --test` with an
// empty file list.
const LIB_PREFIX = 'scripts/lib/';
const WORKFLOW_PREFIX = '.github/workflows/';

// Pure: did this change touch scripts/lib/ ? No I/O — trivially unit-testable.
function touchesLib(changedFiles) {
  return (changedFiles || []).some((f) => f.startsWith(LIB_PREFIX));
}

// Pure: did this change touch a workflow file? Directory prefix only — a
// path merely CONTAINING the string (say a fixture named
// docs/.github/workflows-notes.md) is not a workflow.
function touchesWorkflows(changedFiles) {
  return (changedFiles || []).some((f) => f.startsWith(WORKFLOW_PREFIX));
}

// Pure: does this set of changed files require running the test floor at all?
// No I/O — trivially unit-testable.
function shouldRunTestGate(changedFiles) {
  return touchesLib(changedFiles) || touchesWorkflows(changedFiles);
}

// List the scripts/lib/*.test.mjs files present in `cwd` (same glob as CI's
// "Run scripts/lib tests" step). Returns [] if the dir doesn't exist or has
// no test files — a scripts/lib/ change with no colocated test to run yet.
function listColocatedTestFiles(cwd) {
  const dir = path.join(cwd, 'scripts', 'lib');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => path.join('scripts', 'lib', f));
}

// Guards that MUST be in the selected set for any workflow change, named
// explicitly because content discovery below cannot be relied on to find
// them. workflow-line-length.test.mjs — the guard whose miss IS BRO-2785 —
// builds its path from separate '.github' and 'workflows' path.join()
// segments, so the only contiguous ".github/workflows" in the file is its
// human-readable TEST TITLE. Discovery matches it by accident; rewording that
// title would silently drop the exact guard this gate exists to run, which is
// the same invisible-non-execution failure as the original bug (Codex
// adversarial review, 2026-09-04).
//
// A required guard that is missing from the tree is NOT thrown on here — a
// baseline checkout of an older sha can legitimately predate a guard, and
// throwing mid-merge would block every session. The invariant is enforced
// loudly instead by a colocated test ("every REQUIRED_WORKFLOW_GUARDS entry
// exists"), which runs in CI and in this same floor.
const REQUIRED_WORKFLOW_GUARDS = [path.join('tests', 'unit', 'workflow-line-length.test.mjs')];

// Guards deliberately kept OUT of the floor, each with the reason it cannot
// run here. These are excluded on their cost/soundness as a PRE-PUSH LOCAL
// gate only; they still run in CI, where the credentials exist.
//
//   branch-protection.test.mjs — calls the live GitHub API and asserts on
//   branch-protection settings that need an ADMIN token. On a developer
//   machine it fails on essentially every run. Left in, it would (a) push
//   every workflow merge down the failing path, paying a baseline checkout
//   plus a second full run purely to re-learn that it was already failing,
//   and (b) turn MERGE_TEST_GATE_SKIP_BASELINE=1 into a trap: that hatch
//   disables the diff and restores all-or-nothing blocking, so this known
//   failure would block every workflow merge outright.
const EXCLUDED_WORKFLOW_GUARDS = new Set([path.join('tests', 'unit', 'branch-protection.test.mjs')]);

// Pure: does this test file's SOURCE refer to the workflows directory?
//
// Two spellings, because matching only the first missed real guards. The
// repo norm is to build the path with path.join(..., '.github', 'workflows',
// ...) — 13 of 39 workflow-mentioning tests use it and never contain the
// contiguous string, among them assert-broadcast-step-order.test.mjs and
// stale-announced-audit-scheduled.test.mjs, both genuine subject guards that
// a literal-only scan silently skipped (independent Claude + Codex reviews,
// 2026-09-04). A false negative here is invisible, which is the whole failure
// class BRO-2785 is about, so this errs toward matching.
function mentionsWorkflowsDir(source) {
  if (!source) return false;
  if (source.includes('.github/workflows') || source.includes('.github\\workflows')) return true;
  // path.join('.github', 'workflows', ...) / path.join(".github", "workflows")
  return /['"]\.github['"]\s*,\s*['"]workflows['"]/.test(source);
}

// List the workflow-subject guards present in `cwd`: the REQUIRED ones above,
// plus any tests/unit/*.test.mjs that mentions the .github/workflows
// directory, minus the EXCLUDED ones. Content discovery supplements the
// explicit list rather than replacing it — it picks up a newly added guard
// for free (a purely hardcoded list would rot silently), while the required
// list means the guard that matters most cannot go missing by accident.
//
// Reads each candidate once (~667 files, string search, no parse). Any file
// that can't be read is skipped rather than throwing: this runs mid-merge,
// and an unreadable test file must not abort the merge.
function listWorkflowGuardTestFiles(cwd) {
  const out = new Set();
  for (const rel of REQUIRED_WORKFLOW_GUARDS) {
    if (fs.existsSync(path.join(cwd, rel))) out.add(rel);
  }
  const dir = path.join(cwd, 'tests', 'unit');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.test.mjs')) continue;
      const rel = path.join('tests', 'unit', f);
      let body;
      try {
        body = fs.readFileSync(path.join(cwd, rel), 'utf8');
      } catch {
        continue;
      }
      if (mentionsWorkflowsDir(body)) out.add(rel);
    }
  }
  for (const rel of EXCLUDED_WORKFLOW_GUARDS) out.delete(rel);
  return [...out].sort();
}

// Pure-ish (fs reads only): the test files to run for this change set, in a
// stable order with no duplicates.
//
// MUST be used for BOTH the merged tree and the baseline checkout. The
// baseline diff in runTestGate() classifies a merged-tree failure as
// pre-existing by looking it up in the baseline's failure map; if the two
// runs executed DIFFERENT file sets, a pre-existing failure that simply
// wasn't run in the baseline would be reported as NEW and block the merge.
// Passing the same changedFiles to both calls keeps the two sets aligned.
function selectTestFiles(cwd, changedFiles) {
  const files = [];
  if (touchesLib(changedFiles)) files.push(...listColocatedTestFiles(cwd));
  if (touchesWorkflows(changedFiles)) files.push(...listWorkflowGuardTestFiles(cwd));
  return [...new Set(files)].sort();
}

function defaultExec(cwd, testFiles) {
  // NODE_TEST_CONTEXT (set by node's own --test runner on itself) makes a
  // NESTED `node --test` child assume it's a subtest reporting results back
  // over an inherited IPC channel rather than a standalone run — it then
  // exits 0 regardless of failures. Caller can be this file's own
  // .test.mjs (running under `node --test` already) or, in principle, this
  // gate invoked from inside some other test-runner wrapper — strip it so
  // the child always reports its own real exit code.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // --test-reporter=tap (not the default spec reporter) so parseTapOutput()
  // can key failures by <repo-relative-file>::<test name> for the baseline
  // diff below. `not ok N - <test name>` still carries the literal test name,
  // so any caller matching on that substring in `output` is unaffected.
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: TEST_GATE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Pure: which of `mergedFailures` are NOT present in `baselineFailures`, and
// which are present in both. Both args are Maps (or anything Map-constructible
// — iterables of [key, value]) keyed the same way parseTapOutput() keys its
// `failures` map. No I/O — this is the unit the acceptance criteria's "two
// fixture failing-sets" test targets directly.
function diffFailingSets(baselineFailures, mergedFailures) {
  const baseline = baselineFailures instanceof Map ? baselineFailures : new Map(baselineFailures || []);
  const merged = mergedFailures instanceof Map ? mergedFailures : new Map(mergedFailures || []);
  const newFailures = [];
  const preExisting = [];
  for (const [key, value] of merged) {
    // Unlocated failures (`?::<name>`, see tap-failure-parser.js) can't be
    // reliably matched against the baseline's own unlocated failures — two
    // DIFFERENT failures sharing a title collapse to the same key across two
    // separate process runs. Matching them against baseline would let a
    // genuinely NEW unlocated failure read as "pre-existing" merely because
    // origin/main happened to have some unrelated unlocated failure with the
    // same title — a silent false pass (Codex adversarial review, card
    // #1433). Always classify unlocated merged failures as NEW instead.
    const isNew = key.startsWith('?::') || !baseline.has(key);
    (isNew ? newFailures : preExisting).push(value);
  }
  return { newFailures, preExisting };
}

function formatFailureList(label, items) {
  return `${label} ${items.length} failure(s):\n${items.map((f) => `    - ${f.file}::${f.name}`).join('\n')}`;
}

// How the child ACTUALLY ended, as a short suffix for `reason`. BRO-2874: the
// gate used to report only `status=${result.status}`, which prints the literal
// string "status=null" whenever spawnSync fails at the spawn layer rather than
// the child exiting — a timeout (SIGTERM via TEST_GATE_TIMEOUT_MS) or a spawn
// error such as ENOBUFS. `result.error` was read NOWHERE in this file, so the
// one field naming the real cause was discarded, and the caller in
// scripts/merge-worktree-to-main.sh then asserted a cause it could not know.
//
// Reason-string only, deliberately: `mergedPassed` is `result.status === 0` and
// nothing here feeds a predicate. A spawn error already yields status !== 0
// (null), so it already blocks; naming it changes no decision, only the message.
// Do NOT add `|| result.error` to any predicate — that WOULD change behavior.
//
// Kept ABOVE runTestGate's contract block on purpose: a comment block binds to
// the NEXT declaration, so slotting this between that block and its function
// silently re-pointed the whole documented contract at this helper (the exact
// defect an adversarial review caught in the first draft of this change).
function describeExit(result) {
  const r = result || {};
  // Template-literal stringification is deliberate and covers every shape:
  // 0 -> "status=0", null -> "status=null", absent -> "status=undefined".
  // Never collapse a null status to a falsy default — "status=null" IS the
  // signal that the child never ran, and hiding it is the original bug.
  const parts = [`status=${r.status}`];
  if (r.signal) parts.push(`signal=${r.signal}`);
  if (r.error) parts.push(`spawn error: ${execErrorDetail(r.error, 200)}`);
  return parts.join(', ');
}

// Run the post-merge test floor. Returns { ran, passed, output, reason }.
//   ran     — whether tests were actually executed
//   passed  — true when ran is false (nothing to fail) OR the run exited 0
//             OR (baseline mode) no NEW failure was found
//   output  — captured stdout+stderr of the merged-tree run (empty if not ran),
//             plus a baseline-diff summary block when baseline mode ran
//   reason  — human-readable note for why the gate did/didn't run
// `execFn` is injectable so tests can point at a scratch directory's fixture
// tests instead of spawning the real repo's (slow, ~4min) suite.
//
// BASELINE MODE (card #1433): pass `makeBaselineCheckout` (and, to actually
// clean up, `removeBaselineCheckout`) to distinguish a NEW merged-tree
// failure from one that was already red before this merge. Both are null by
// default, which reproduces the exact pre-#1433 behavior (block on ANY
// merged-tree failure) — every existing caller/test that doesn't pass them
// is unaffected. Only invoked when the merged-tree run FAILS; a clean merge
// never builds a baseline checkout.
function runTestGate({ cwd, changedFiles, execFn = defaultExec, makeBaselineCheckout = null, removeBaselineCheckout = null } = {}) {
  if (!shouldRunTestGate(changedFiles)) {
    return { ran: false, passed: true, output: '', reason: 'no scripts/lib/ or .github/workflows/ files changed' };
  }
  const testFiles = selectTestFiles(cwd, changedFiles);
  if (testFiles.length === 0) {
    // A workflow change that selects ZERO guards is a DISCOVERY failure, not
    // an "all clear": the repo carries workflow guards, so finding none means
    // the selection broke (guards renamed, tests/unit moved, discovery regex
    // stopped matching). Passing there would silently reproduce the exact
    // BRO-2785 bug this gate exists to close, so fail instead. A lib change
    // with no colocated tests is genuinely benign and still passes.
    if (touchesWorkflows(changedFiles)) {
      return {
        ran: false,
        passed: false,
        output: '',
        reason:
          'workflow files changed but ZERO workflow guards were selected — discovery is broken (renamed guards, moved tests/unit, or a stale match). Refusing to report a pass that validated nothing; see REQUIRED_WORKFLOW_GUARDS in scripts/lib/merge-post-merge-test-gate.js',
      };
    }
    return {
      ran: false,
      passed: true,
      output: '',
      reason: 'no test files found for changed paths (scripts/lib/*.test.mjs)',
    };
  }
  const result = execFn(cwd, testFiles);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const mergedPassed = result.status === 0;

  if (mergedPassed || !makeBaselineCheckout) {
    // This branch serves BOTH the passing and failing halves, so the reason
    // format changed for both — on a pass nothing reads it (main() prints
    // `reason` only on the skip and fail paths), which is why the change is
    // invisible in practice, but "only the failure message changed" would be
    // an inaccurate description of the edit.
    //
    // On the FAILING half (MERGE_TEST_GATE_SKIP_BASELINE=1, or no
    // baseline available) `reason` is what main() prints as
    // "post-merge test floor: FAILED (...)" — the one line the operator reads.
    // It used to enumerate all ~402 selected filenames and carry no exit detail,
    // so the escape hatch the die text recommends produced a message with no
    // cause in it at all. Counts + how the child ended.
    //
    // The filenames are NOT unconditionally recoverable from `output`: an
    // earlier revision of this comment claimed they were, and that is false in
    // exactly the case that matters most — a spawn-layer failure produces EMPTY
    // stdout/stderr, so `output` is empty too (caught by an adversarial review
    // of this very change). The scope is still reconstructible, because
    // selectTestFiles() is a pure function of `cwd` + `changedFiles`, but that
    // is a re-derivation, not a recovery. The count is what goes in the reason;
    // naming the cause matters more than naming 402 files.
    return {
      ran: true,
      passed: mergedPassed,
      output,
      reason: `ran ${testFiles.length} file(s); ${describeExit(result)}`,
    };
  }

  // Merged tree failed AND baseline mode is available — figure out whether
  // any failure is NEW (not present before this merge).
  const mergedParsed = parseTapOutput(output, safeRealpath(cwd));
  const mergedFailures = mergedParsed.failures;
  // Fail-open guard (Codex adversarial review, card #1433): a nonzero exit
  // with ZERO parsed failures means something broke the run itself — a
  // syntax error, a crash before any test executed, an unsupported
  // --test-reporter, a spawn timeout — not "every test passed except an
  // unattributable one". diffFailingSets against an empty mergedFailures Map
  // trivially finds zero new failures and would silently PASS a run that
  // never actually validated anything, exactly backwards from the pre-#1433
  // behavior (block on ANY merged-tree failure). Skip baseline diffing
  // entirely in this case and fall back to that original safe behavior.
  if (mergedFailures.size === 0) {
    return {
      ran: true,
      passed: false,
      output: `${output}\n\n⚠ post-merge test floor: merged tree exited non-zero but no individual test failure could be parsed (crash/timeout/syntax error, not a normal assertion failure) — blocking as a fail-safe rather than risk a silent pass`,
      reason: `ran ${testFiles.length} file(s); merged run failed unparseably (${describeExit(result)})`,
    };
  }
  let checkout = null;
  try {
    checkout = makeBaselineCheckout();
    const baselineRoot = checkout && (checkout.wt || checkout.dir);
    // Mirrors acceptance-check-core.js's own runVerify(): a checkout whose
    // node_modules link failed makes every test fail on `require`, not on a
    // real assertion — trusting that as "baseline" would make a masked
    // environment failure read as "everything's pre-existing, don't block",
    // exactly backwards from fail-safe. Treat it the same as a checkout that
    // couldn't be built at all.
    if (!checkout || checkout.prepared === false) {
      throw new Error('baseline checkout is missing node_modules (unprepared) — cannot trust its test results');
    }
    const baselineTestFiles = selectTestFiles(baselineRoot, changedFiles);
    let baselineFailures = new Map();
    if (baselineTestFiles.length > 0) {
      const baselineResult = execFn(baselineRoot, baselineTestFiles);
      const baselineParsed = parseTapOutput(`${baselineResult.stdout || ''}`, safeRealpath(baselineRoot));
      // Same fail-safe guard as the merged run above, mirrored for the
      // baseline: a baseline run that exited non-zero but parsed zero
      // failures (crash/timeout there too) is not trustworthy evidence of
      // "zero pre-existing failures" — treating it as such would make every
      // one of the merged tree's real failures misread as "new" (which
      // fails toward blocking, not toward a silent pass, but still isn't the
      // honest "baseline unavailable" signal this gate should give).
      if (baselineResult.status !== 0 && baselineParsed.failures.size === 0) {
        // describeExit here too, not just on the merged run (BRO-2874): the
        // baseline child dies from the same timeouts and spawn errors, and this
        // message is the ONLY place its cause can ever surface — the catch below
        // folds it into "baseline checkout unavailable", which reads like broken
        // baseline INFRASTRUCTURE rather than a crashed test process.
        throw new Error(`baseline run exited non-zero but no individual test failure could be parsed (${describeExit(baselineResult)}) — cannot trust it as "zero pre-existing failures"`);
      }
      baselineFailures = baselineParsed.failures;
    }
    const { newFailures, preExisting } = diffFailingSets(baselineFailures, mergedFailures);
    let combinedOutput = output;
    if (preExisting.length > 0) {
      combinedOutput += `\n\n⚠ post-merge test floor: pre-existing on origin/main, NOT caused by this merge, NOT blocking — but still real bugs, file a card:\n${formatFailureList('  ', preExisting)}`;
    }
    if (newFailures.length > 0) {
      combinedOutput += `\n\n✗ post-merge test floor: NEW since origin/main — this merge introduced or exposed these, BLOCKING:\n${formatFailureList('  ', newFailures)}`;
    }
    return {
      ran: true,
      passed: newFailures.length === 0,
      output: combinedOutput,
      reason: `ran ${testFiles.length} file(s) vs origin/main baseline: ${newFailures.length} new, ${preExisting.length} pre-existing`,
    };
  } catch (err) {
    // Baseline infra failed (network, worktree lock, unprepared checkout) —
    // cannot distinguish pre-existing from new. Fail SAFE toward the ORIGINAL
    // (pre-#1433) behavior: block on the merged-tree failure, rather than
    // silently passing a possibly-new bug through just because the baseline
    // machinery broke.
    return {
      ran: true,
      passed: false,
      output: `${output}\n\n⚠ post-merge test floor: could not build an origin/main baseline to distinguish pre-existing failures (${err.message}) — blocking on the merged-tree failure as a fail-safe`,
      reason: `ran ${testFiles.length} file(s); baseline checkout unavailable`,
    };
  } finally {
    if (checkout && removeBaselineCheckout) removeBaselineCheckout(checkout);
  }
}

module.exports = {
  REQUIRED_WORKFLOW_GUARDS,
  EXCLUDED_WORKFLOW_GUARDS,
  shouldRunTestGate,
  touchesLib,
  touchesWorkflows,
  listColocatedTestFiles,
  listWorkflowGuardTestFiles,
  selectTestFiles,
  runTestGate,
  diffFailingSets,
};

if (require.main === module) {
  const input = fs.readFileSync(0, 'utf8');
  const changedFiles = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Wire in the real baseline-checkout functions, LAZILY (only if the gate
  // actually needs them — i.e. only reached from inside runTestGate's failing
  // path) so a scratch repo that doesn't carry acceptance-check-core.js (or
  // its deps) never crashes on require() when the merged tree simply passes
  // or the kill switch is set. Any require() failure here — missing file,
  // syntax error — degrades to makeBaselineCheckout=null, i.e. the pre-#1433
  // all-or-nothing behavior, not a crash.
  let makeBaselineCheckout = null;
  let removeBaselineCheckout = null;
  if (process.env.MERGE_TEST_GATE_SKIP_BASELINE !== '1') {
    makeBaselineCheckout = () => {
      const { makeFreshCheckout } = require('./acceptance-check-core.js');
      return makeFreshCheckout({
        prefix: 'merge-test-gate-baseline-',
        sha: process.env.MERGE_TEST_GATE_BASELINE_SHA || null,
      });
    };
    removeBaselineCheckout = (checkout) => {
      try {
        const { removeCheckout } = require('./acceptance-check-core.js');
        removeCheckout(checkout);
      } catch { /* best effort — a leftover worktree is picked up by `git worktree prune` */ }
    };
  }

  const { ran, passed, output, reason } = runTestGate({
    cwd: process.cwd(),
    changedFiles,
    makeBaselineCheckout,
    removeBaselineCheckout,
  });
  if (ran) {
    process.stdout.write(output);
  } else {
    console.log(`post-merge test floor: skipped (${reason})`);
  }
  if (!passed) {
    console.error(`post-merge test floor: FAILED (${reason})`);
    process.exitCode = 1;
  }
}
