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
 *   1. Run the unit manifest normally      → baseline failing set
 *   2. Run it again with the clock at +Nd  → shifted failing set
 *   3. Report (shifted \ baseline) — tests that ONLY fail once time moves.
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
 * The better long-term fix is to give those an injectable clock (the way
 * detectCWVAnomalies now takes `today`) so they can be tested honestly, rather
 * than exempting their tests forever.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseTapOutput } = require('./lib/tap-failure-parser.js');

const REPO_ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(REPO_ROOT, 'tests', 'unit-test-manifest.txt');
const PRELOAD = path.join(REPO_ROOT, 'tests', 'helpers', 'clock-shift.mjs');
const EXEMPT_MARKER = 'timebomb-audit-exempt:';

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

function readManifest() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`Manifest not found: ${MANIFEST}`);
    process.exit(2);
  }
  return fs
    .readFileSync(MANIFEST, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
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
 * Run the suite and return { failures, totals, status, sawTap, unlocated }.
 *
 * TAP parsing itself lives in scripts/lib/tap-failure-parser.js (shared with
 * scripts/lib/merge-post-merge-test-gate.js, card #1433, which needs the
 * identical before/after failing-set-diff technique) — this function owns
 * only the spawn (clock-shift env/preload) and result plumbing.
 */
function runSuite(files, shiftDays) {
  const args = [];
  if (shiftDays) args.push('--import', PRELOAD);
  args.push('--test', '--test-reporter=tap', ...files);

  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: {
      ...process.env,
      BSC_CLOCK_SHIFT_DAYS: String(shiftDays || 0),
      // Matches test.yml: keeps unit fixtures out of the committed prod
      // stage-latency telemetry.
      BSC_STAGE_LATENCY_MUTE: '1',
    },
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

  const files = readManifest();
  if (files.length === 0) {
    console.error('Manifest is empty — refusing to report "no time bombs".');
    process.exit(2);
  }
  const exemptFiles = readExemptFiles(files);

  if (!opts.json) {
    console.log(`Time-bomb audit: ${files.length} test files, clock shift +${opts.days}d`);
    if (exemptFiles.size) console.log(`  ${exemptFiles.size} file(s) carry an in-file exemption marker`);
    console.log('\n  [1/2] baseline run (current clock)...');
  }
  const base = runSuite(files, 0);

  if (!opts.json) console.log(`  [2/2] shifted run (+${opts.days}d)...`);
  const shifted = runSuite(files, opts.days);

  // Fail loud rather than reporting a clean sheet off a run that died early.
  const problems = [];
  if (!base.sawTap) problems.push('baseline run produced no TAP output at all');
  if (!shifted.sawTap) problems.push('shifted run produced no TAP output at all');
  // status === null means killed by a signal (OOM, timeout). A plain non-zero
  // exit is EXPECTED here — node --test exits 1 whenever any test fails, and
  // this repo's suite is not currently green — so only the signal case is a
  // reliable "the run was destroyed" signal.
  if (base.status === null) problems.push('baseline run was killed by a signal (OOM/timeout?)');
  if (shifted.status === null) problems.push('shifted run was killed by a signal (OOM/timeout?)');
  if (base.totals.tests == null) problems.push('baseline run never printed a "# tests" total');
  if (shifted.totals.tests == null) problems.push('shifted run never printed a "# tests" total');
  if (
    base.totals.tests != null &&
    shifted.totals.tests != null &&
    shifted.totals.tests < base.totals.tests * MIN_SHIFTED_TEST_RATIO
  ) {
    problems.push(
      `shifted run executed ${shifted.totals.tests} tests vs baseline ${base.totals.tests} ` +
        `(<${Math.round(MIN_SHIFTED_TEST_RATIO * 100)}%) — it died early, so "no findings" would be meaningless`
    );
  }
  if (problems.length) {
    console.error('TIME-BOMB AUDIT COULD NOT RUN RELIABLY:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`  baseline exit=${base.status}  shifted exit=${shifted.status}`);
    process.exit(2);
  }

  const exempted = [];
  const bombs = [];
  for (const [key, { file, name }] of shifted.failures) {
    if (base.failures.has(key)) continue;
    if (exemptFiles.has(file)) {
      exempted.push({ file, name, reason: exemptFiles.get(file) });
      continue;
    }
    bombs.push({ file, name });
  }
  bombs.sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          shiftDays: opts.days,
          filesChecked: files.length,
          baseline: { tests: base.totals.tests, fail: base.totals.fail, unlocatedFailures: base.unlocated },
          shifted: { tests: shifted.totals.tests, fail: shifted.totals.fail, unlocatedFailures: shifted.unlocated },
          exempted,
          timeBombs: bombs,
        },
        null,
        2
      )
    );
  } else {
    console.log(
      `\nBaseline: ${base.totals.fail} failing of ${base.totals.tests}   ` +
        `Shifted: ${shifted.totals.fail} failing of ${shifted.totals.tests}` +
        (exempted.length ? `   (${exempted.length} exempted)` : '') +
        '\n'
    );
    if (shifted.unlocated || base.unlocated) {
      console.log(
        `  note: ${base.unlocated} baseline / ${shifted.unlocated} shifted failure(s) had no location: line,\n` +
          '        so they are matched by test NAME only — same-titled ones collapse and could mask a finding.\n'
      );
    }
    if (bombs.length === 0) {
      console.log(`PASS — no test changes outcome when the clock moves +${opts.days}d.`);
    } else {
      console.log(`FOUND ${bombs.length} time-bomb test(s) — pass now, fail at +${opts.days}d:\n`);
      for (const b of bombs) console.log(`  ✗ ${b.file} — ${b.name}`);
      console.log(
        '\nFix: make the stamp relative to run time (daysAgoISO(1)), not a hardcoded literal.'
      );
      console.log('Do NOT widen the production freshness window to fit the literal.');
    }
  }

  if (bombs.length > 0 && opts.strict) process.exit(1);
}

main();
