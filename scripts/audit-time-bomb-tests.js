#!/usr/bin/env node
/**
 * audit-time-bomb-tests.js — find tests that pass today and fail by calendar.
 *
 * A "time bomb" test is one whose outcome depends on the wall clock: it stamps
 * a hardcoded date and asserts production code treats it as recent/fresh/valid,
 * against a rolling window measured from Date.now(). It passes when written and
 * fails N days later with no commit in between — so no review, lint, or test
 * run can catch it in advance. It detonates on a date.
 *
 * This ran main red for 8 straight days: two review-guards tests hardcoded
 * 2026-08-04 against AUTO_CLEAR_FRESH_DAYS = 7. Work lands directly on main
 * from many parallel sessions (~25 test.yml runs/day), so those two tests
 * re-reported as 160 separate red runs out of 200 — 9 green. Red-run COUNT
 * measures push volume, not defect count; two bugs and fifty bugs look
 * identical from the outside. That is why a single expiry can read as
 * "main breaks constantly".
 *
 * METHOD
 *   1. Run each manifest normally          → baseline failing set (per suite)
 *   2. Run it again with the clock at +Nd  → shifted failing set (per suite)
 *   3. Report (shifted \ baseline) — tests that ONLY fail once time moves.
 *
 * Covers all three manifests test.yml runs, each with the runner test.yml
 * actually uses for it: tests/unit-test-manifest.txt (node --test),
 * tests/unit-test-manifest-tsx.txt and tests/e2e-unit-test-manifest.txt (both
 * tsx's --test, invoked via its resolved CLI entry point rather than `npx
 * tsx` — see resolveTsxCli() — since plain node fails to load files that
 * import TypeScript directly). A test registered in only one manifest used
 * to be invisible to this audit (card #1657); it no longer is. The three suites are diffed
 * independently, not merged into one failure set, because a file can appear
 * in more than one manifest (e.g. a sanity test run under both node and tsx)
 * and a shared `<file>::<name>` key could then mask a real finding in one
 * runner behind an unrelated baseline failure in the other.
 *
 * Step 1 is what keeps this honest: tests already failing for unrelated reasons
 * (missing local .env, data drift) are subtracted out rather than reported as
 * time bombs, so the output stays actionable on a repo whose suite is not
 * currently green.
 *
 * FAILING LOUD RATHER THAN SILENT (second-opinion review finding)
 * The dangerous failure mode for a differ like this is the shifted run dying
 * early: a partial `shifted` set makes (shifted \ baseline) shrink, and a naive
 * implementation then prints "no time bombs" precisely when it checked almost
 * nothing. So both runs are compared on node:test's own `# tests` total, and a
 * shifted run that executed materially fewer tests than baseline is a hard
 * error (exit 2), never a pass. An audit that could not run must fail, not
 * report clean — the same philosophy check-corpus-drift.yml states.
 *
 * KEYED BY FILE, NOT BARE NAME (second-opinion review finding)
 * Test titles are not unique across the manifest — e.g. "two child processes
 * racing to save both land without corrupting the file" exists verbatim in
 * audience-buzz-write-guard, commercial-write-guard, json-write-guard and
 * shows-write-guard. Subtracting bare names would let a genuine new bomb in one
 * file be swallowed by an unrelated same-named baseline failure in another, so
 * failures are keyed `<file>::<name>` using the `location:` that node:test emits
 * in each failure's YAML block.
 *
 * Usage:
 *   node scripts/audit-time-bomb-tests.js                 # default +30d
 *   node scripts/audit-time-bomb-tests.js --days=90
 *   node scripts/audit-time-bomb-tests.js --json          # machine-readable
 *   node scripts/audit-time-bomb-tests.js --strict        # exit 1 on findings
 *
 * Fix a finding by making the stamp relative to run time, e.g.
 *   const daysAgoISO = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
 *   wrongProductionAutoClearedAt: daysAgoISO(1),
 * NOT by widening the production window to accommodate the literal.
 *
 * EXEMPTING A FILE
 * Put `// timebomb-audit-exempt: <reason>` at the top of the test file itself —
 * the same in-the-offending-file convention as `// hygiene-help-flag-ok:` used
 * by audit-help-flag-safety.js. Keeping the marker with the test means a rename
 * can't silently orphan it and the exemption is visible in any diff that touches
 * the test. Reserve it for tests that are legitimately clock-coupled (see the
 * filesystem-mtime note below), not for tests that are merely inconvenient.
 *
 * KNOWN LIMITATION — filesystem mtime is NOT shifted.
 * clock-shift.mjs moves Date.now() inside the process; it cannot move the
 * filesystem clock. Code measuring freshness as
 * `Date.now() - fs.statSync(p).mtimeMs` therefore sees every file as SHIFT_DAYS
 * old under the shifted run and reports "expired" — a false positive, because in
 * production both readings come from the same real clock. Confirmed instances:
 *   scripts/lib/ttl-cache.js:52                   Date.now() - stat.mtimeMs > ttlMs
 *   scripts/lib/infra-gate-registration-check.js  checkGuardHeartbeat via statSync
 *   scripts/validate-added-review-ownership.js:173  MERGE_HEAD staleness check
 *     (variant: the test writes a shim-backdated mtime, then execSync spawns
 *     the CLI as a separate node process with no clock-shift preload of its
 *     own — that child's real Date.now() vs the artificially-future on-disk
 *     mtime goes negative instead of stale. See the timebomb-audit-exempt
 *     marker in tests/unit/validate-added-review-ownership.test.mjs.)
 * The better long-term fix is to give those an injectable clock (the way
 * detectCWVAnomalies now takes `today`) so they can be tested honestly, rather
 * than exempting their tests forever.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseTapOutput } = require('./lib/tap-failure-parser.js');
const { MANIFESTS, readManifest } = require('./lib/test-manifest.js');

const REPO_ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(REPO_ROOT, 'tests', 'helpers', 'clock-shift.mjs');
const EXEMPT_MARKER = 'timebomb-audit-exempt:';

/**
 * tsx's own CLI entry point, resolved via node's normal module resolution
 * (walks up from __dirname same as `require`) rather than shelling out to
 * `npx tsx`. Two reasons:
 *   1. `npx` forks and re-execs internally, so a SIGKILL'd child reports
 *      status:137/signal:null instead of propagating the signal the way a
 *      directly-exec'd node process does (verified empirically) — that broke
 *      this file's own "OOM/timeout is a hard error" check for both tsx
 *      suites. Invoking the CLI script directly via `process.execPath` keeps
 *      every suite a single-hop child process, node and tsx alike.
 *   2. It still resolves correctly from a git worktree that has no
 *      node_modules of its own (this repo's normal setup — worktrees share
 *      the main checkout's node_modules via directory walk-up), same as npx.
 */
function resolveTsxCli() {
  const pkgPath = require.resolve('tsx/package.json');
  const pkg = require(pkgPath);
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tsx;
  return path.join(path.dirname(pkgPath), binRel);
}

/**
 * Every manifest test.yml actually runs tests from, paired with the runner
 * test.yml uses for it (card #1657 — this audit used to read only the node
 * manifest, so a test registered ONLY in the tsx or e2e-unit manifest was
 * invisible to it). Plain `node --test` fails to load files that import
 * TypeScript directly, so the tsx/e2e-unit manifests need tsx's loader, not
 * just a longer file list. Manifest paths come from scripts/lib/test-manifest.js's
 * MANIFESTS (shared with audit-orphan-tests.js and test-manifest-integrity.test.mjs)
 * instead of being hardcoded a 4th time here — see that file for why.
 */
const TSX_CLI = resolveTsxCli();
const SUITES = [
  {
    key: 'unit',
    label: 'unit (node --test)',
    manifest: path.join(REPO_ROOT, MANIFESTS[0]),
    command: process.execPath,
    baseArgs: [],
  },
  {
    key: 'unit-tsx',
    label: 'unit-tsx (tsx --test)',
    manifest: path.join(REPO_ROOT, MANIFESTS[1]),
    command: process.execPath,
    baseArgs: [TSX_CLI],
  },
  {
    key: 'e2e-unit',
    label: 'e2e-unit (tsx --test)',
    manifest: path.join(REPO_ROOT, MANIFESTS[2]),
    command: process.execPath,
    baseArgs: [TSX_CLI],
  },
];

// A shifted run that executed fewer than this fraction of baseline's tests is
// treated as "did not really run" rather than "found nothing".
const MIN_SHIFTED_TEST_RATIO = 0.95;

function parseArgs(argv) {
  const opts = { days: 30, json: false, strict: false };
  for (const arg of argv.slice(2)) {
    const m = /^--days=(\d+)$/.exec(arg);
    if (m) opts.days = Number(m[1]);
    else if (arg === '--json') opts.json = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

// Thin wrapper over the shared lib readManifest(): adds the "fail loud on a
// missing manifest" guard this script wants (the lib version, shared with the
// CI integrity test which checks existence itself, doesn't do this).
function readManifestOrExit(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(2);
  }
  return readManifest(manifestPath);
}

/**
 * Files carrying the in-file exemption marker, keyed by manifest-relative path.
 *
 * The marker must appear on a genuine comment line (`//` or a `*` continuation
 * inside a block comment). Matching the bare substring anywhere would let a
 * fixture string, a doc example, or a test asserting ON this marker exempt its
 * whole file by accident.
 */
function readExemptFiles(files) {
  const exempt = new Map();
  for (const rel of files) {
    let src;
    try {
      src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch (err) {
      // A manifest entry we cannot read is a real problem elsewhere (the
      // manifest-integrity test covers existence); say so rather than silently
      // treating the file as un-exempt.
      console.error(`  warning: could not read ${rel} for exemption marker (${err.code || err.message})`);
      continue;
    }
    const line = src
      .split('\n')
      .find((l) => /^\s*(\/\/|\*)/.test(l) && l.includes(EXEMPT_MARKER));
    if (line) {
      exempt.set(rel, line.slice(line.indexOf(EXEMPT_MARKER) + EXEMPT_MARKER.length).trim());
    }
  }
  return exempt;
}

/**
 * Run one suite (a manifest + its runner) and return
 * { failures, totals, status, sawTap, unlocated }.
 *
 * TAP parsing itself lives in scripts/lib/tap-failure-parser.js (shared with
 * scripts/lib/merge-post-merge-test-gate.js, card #1433, which needs the
 * identical before/after failing-set-diff technique) — this function owns
 * only the spawn (clock-shift env/preload) and result plumbing.
 */
function runSuite(command, baseArgs, files, shiftDays) {
  const args = [...baseArgs];
  if (shiftDays) args.push('--import', PRELOAD);
  args.push('--test', '--test-reporter=tap', ...files);

  // NODE_TEST_CONTEXT (set by node's own --test runner on itself) makes a
  // NESTED `node --test` child assume it's a subtest reporting results back
  // over an inherited IPC channel rather than a standalone run — it then
  // exits 0 regardless of failures. This script isn't normally invoked from
  // inside another `node --test` run, but scripts/lib/merge-post-merge-test-gate.js
  // strips it for the identical spawn shape for exactly that reason, and this
  // now has 3x the spawn call sites that would silently inherit the gap.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.BSC_CLOCK_SHIFT_DAYS = String(shiftDays || 0);
  // Matches test.yml: keeps unit fixtures out of the committed prod
  // stage-latency telemetry.
  env.BSC_STAGE_LATENCY_MUTE = '1';

  const res = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env,
  });

  if (res.error) {
    console.error(`Failed to spawn test run (shift ${shiftDays}d): ${res.error.message}`);
    process.exit(2);
  }

  const { failures, totals, sawTap, unlocated } = parseTapOutput(res.stdout || '', REPO_ROOT);
  return { failures, totals, status: res.status, sawTap, unlocated };
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }

  const suites = SUITES.map((s) => ({ ...s, files: readManifestOrExit(s.manifest) }));
  for (const s of suites) {
    if (s.files.length === 0) {
      console.error(`Manifest is empty — refusing to report "no time bombs": ${s.manifest}`);
      process.exit(2);
    }
  }

  // Files can legitimately appear in more than one manifest (e.g. a sanity
  // test registered in both the node and tsx batches) — dedup both for the
  // exemption-marker scan (only cares about file content, not runner) and for
  // the file count report (a shared file is still one file, not two).
  const allFiles = [...new Set(suites.flatMap((s) => s.files))];
  const exemptFiles = readExemptFiles(allFiles);

  if (!opts.json) {
    console.log(
      `Time-bomb audit: ${allFiles.length} test files across ${suites.length} manifests, clock shift +${opts.days}d`
    );
    if (exemptFiles.size) console.log(`  ${exemptFiles.size} file(s) carry an in-file exemption marker`);
  }

  // Each suite is run baseline+shifted independently — NOT merged into one
  // failure set — because the same file can appear in more than one manifest
  // (see allFiles above), so a bare `<file>::<name>` key could otherwise
  // collide across suites and mask a real finding in one runner behind an
  // unrelated baseline failure in the other. Bombs/exemptions are also
  // computed per-suite as soon as that suite finishes, rather than only after
  // ALL suites finish — so a reliability problem in one suite (below) can
  // never discard an already-computed real finding from a suite that ran fine.
  const problems = [];
  const results = [];
  const exempted = [];
  const bombs = [];
  for (const s of suites) {
    if (!opts.json) console.log(`\n  [${s.key}] baseline run (current clock)...`);
    const base = runSuite(s.command, s.baseArgs, s.files, 0);

    if (!opts.json) console.log(`  [${s.key}] shifted run (+${opts.days}d)...`);
    const shifted = runSuite(s.command, s.baseArgs, s.files, opts.days);

    // Fail loud rather than reporting a clean sheet off a run that died early.
    const suiteProblems = [];
    if (!base.sawTap) suiteProblems.push(`[${s.key}] baseline run produced no TAP output at all`);
    if (!shifted.sawTap) suiteProblems.push(`[${s.key}] shifted run produced no TAP output at all`);
    // status === null means killed by a signal (OOM, timeout). A plain
    // non-zero exit is EXPECTED here — the test runner exits 1 whenever any
    // test fails, and this repo's suite is not currently green — so only the
    // signal case is a reliable "the run was destroyed" signal.
    if (base.status === null) suiteProblems.push(`[${s.key}] baseline run was killed by a signal (OOM/timeout?)`);
    if (shifted.status === null) suiteProblems.push(`[${s.key}] shifted run was killed by a signal (OOM/timeout?)`);
    if (base.totals.tests == null) suiteProblems.push(`[${s.key}] baseline run never printed a "# tests" total`);
    if (shifted.totals.tests == null) suiteProblems.push(`[${s.key}] shifted run never printed a "# tests" total`);
    if (
      base.totals.tests != null &&
      shifted.totals.tests != null &&
      shifted.totals.tests < base.totals.tests * MIN_SHIFTED_TEST_RATIO
    ) {
      suiteProblems.push(
        `[${s.key}] shifted run executed ${shifted.totals.tests} tests vs baseline ${base.totals.tests} ` +
          `(<${Math.round(MIN_SHIFTED_TEST_RATIO * 100)}%) — it died early, so "no findings" would be meaningless`
      );
    }

    problems.push(...suiteProblems);
    results.push({ suite: s.key, label: s.label, base, shifted });

    if (suiteProblems.length === 0) {
      for (const [key, { file, name }] of shifted.failures) {
        if (base.failures.has(key)) continue;
        if (exemptFiles.has(file)) {
          exempted.push({ suite: s.key, file, name, reason: exemptFiles.get(file) });
          continue;
        }
        bombs.push({ suite: s.key, file, name });
      }
    }
  }

  if (problems.length) {
    console.error('TIME-BOMB AUDIT COULD NOT RUN RELIABLY:');
    for (const p of problems) console.error(`  - ${p}`);
    for (const r of results) {
      console.error(`  [${r.suite}] baseline exit=${r.base.status}  shifted exit=${r.shifted.status}`);
    }
    if (bombs.length) {
      console.error(
        `\n${bombs.length} time-bomb(s) WERE found in suite(s) that ran reliably before the failure ` +
          'above — fix these even though the run overall is untrusted:'
      );
      for (const b of bombs) console.error(`  ✗ [${b.suite}] ${b.file} — ${b.name}`);
    }
    process.exit(2);
  }

  bombs.sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));

  const totalUnlocated = results.reduce((n, r) => n + r.base.unlocated + r.shifted.unlocated, 0);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          shiftDays: opts.days,
          filesChecked: allFiles.length,
          suites: results.map((r) => ({
            suite: r.suite,
            label: r.label,
            baseline: { tests: r.base.totals.tests, fail: r.base.totals.fail, unlocatedFailures: r.base.unlocated },
            shifted: {
              tests: r.shifted.totals.tests,
              fail: r.shifted.totals.fail,
              unlocatedFailures: r.shifted.unlocated,
            },
          })),
          exempted,
          timeBombs: bombs,
        },
        null,
        2
      )
    );
  } else {
    console.log('');
    for (const r of results) {
      console.log(
        `[${r.suite}] Baseline: ${r.base.totals.fail} failing of ${r.base.totals.tests}   ` +
          `Shifted: ${r.shifted.totals.fail} failing of ${r.shifted.totals.tests}`
      );
    }
    if (exempted.length) console.log(`(${exempted.length} exempted across all suites)`);
    if (totalUnlocated) {
      console.log(
        `\n  note: ${totalUnlocated} failure(s) across all suites had no location: line,\n` +
          '        so they are matched by test NAME only — same-titled ones collapse and could mask a finding.\n'
      );
    }
    if (bombs.length === 0) {
      console.log(`\nPASS — no test changes outcome when the clock moves +${opts.days}d.`);
    } else {
      console.log(`\nFOUND ${bombs.length} time-bomb test(s) — pass now, fail at +${opts.days}d:\n`);
      for (const b of bombs) console.log(`  ✗ [${b.suite}] ${b.file} — ${b.name}`);
      console.log(
        '\nFix: make the stamp relative to run time (daysAgoISO(1)), not a hardcoded literal.'
      );
      console.log('Do NOT widen the production freshness window to fit the literal.');
    }
  }

  if (bombs.length > 0 && opts.strict) process.exit(1);
}

main();
