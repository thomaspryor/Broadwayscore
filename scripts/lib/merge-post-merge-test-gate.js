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
//   Deliberately narrow: only scripts/lib/*.test.mjs (the same glob CI's
//   "Run scripts/lib tests" step already runs — see .github/workflows/test.yml).
//   That's the shape most susceptible to this collision (many independent
//   sessions land colocated lib helpers + contract tests concurrently) and
//   it's fast (~4min, matching CI). A broader floor (full suite, tests/unit/)
//   would slow every merge down for a class of collision this glob doesn't
//   see; widen the scope here if that class recurs outside scripts/lib/.
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

// Pure: does this set of changed files require running the scripts/lib/
// colocated test floor? No I/O — trivially unit-testable.
function shouldRunTestGate(changedFiles) {
  return (changedFiles || []).some((f) => f.startsWith('scripts/lib/'));
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
    return { ran: false, passed: true, output: '', reason: 'no scripts/lib/ files changed' };
  }
  const testFiles = listColocatedTestFiles(cwd);
  if (testFiles.length === 0) {
    return { ran: false, passed: true, output: '', reason: 'no scripts/lib/*.test.mjs files found' };
  }
  const result = execFn(cwd, testFiles);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const mergedPassed = result.status === 0;

  if (mergedPassed || !makeBaselineCheckout) {
    return {
      ran: true,
      passed: mergedPassed,
      output,
      reason: `ran ${testFiles.length} file(s): ${testFiles.join(', ')}`,
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
      reason: `ran ${testFiles.length} file(s); merged run failed unparseably (status=${result.status})`,
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
    const baselineTestFiles = listColocatedTestFiles(baselineRoot);
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
        throw new Error('baseline run exited non-zero but no individual test failure could be parsed (crash/timeout) — cannot trust it as "zero pre-existing failures"');
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

module.exports = { shouldRunTestGate, listColocatedTestFiles, runTestGate, diffFailingSets };

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
