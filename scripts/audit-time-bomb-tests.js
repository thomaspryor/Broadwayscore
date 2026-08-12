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
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(REPO_ROOT, 'tests', 'unit-test-manifest.txt');
const PRELOAD = path.join(REPO_ROOT, 'tests', 'helpers', 'clock-shift.mjs');

// KNOWN LIMITATION — filesystem mtime is NOT shifted.
//
// clock-shift.mjs moves Date.now() inside the process; it cannot move the
// filesystem clock. Any code that measures freshness as
// `Date.now() - fs.statSync(p).mtimeMs` therefore sees every file as
// SHIFT_DAYS old under the shifted run and reports "expired" — a false
// positive, because in production both readings come from the same real clock.
//
// Two confirmed instances of that pattern in this repo:
//   scripts/lib/ttl-cache.js:52                  Date.now() - stat.mtimeMs > ttlMs
//   scripts/lib/infra-gate-registration-check.js checkGuardHeartbeat via statSync
//
// Their tests are exempted below by exact name. Every entry is a test the
// detector can no longer protect, so keep the list short and give each a
// reason. Before adding one, confirm the failure really is the mtime artifact
// (read the code for a statSync/mtime comparison) — do NOT exempt a test just
// because it is inconvenient.
const ALLOWLIST = new Map([
  // scripts/lib/ttl-cache.js + serp-cache.js — disk-backed caches keyed on file mtime.
  ['warm hit returns cached value', 'ttl-cache: mtime vs shifted Date.now'],
  ['entries expire after ttlMs', 'ttl-cache: mtime vs shifted Date.now'],
  ['empty array IS cached (valid "no results" answer)', 'ttl-cache: mtime vs shifted Date.now'],
  ['empty array/object IS cached (a negative result is a valid answer)', 'ttl-cache: mtime vs shifted Date.now'],
  ['opts distinguish otherwise-identical keys', 'ttl-cache: mtime vs shifted Date.now'],
  ['whitespace and case normalized in key', 'ttl-cache: mtime vs shifted Date.now'],
  ['stats track hits/misses/writes', 'ttl-cache: mtime vs shifted Date.now'],
  ['stats track hits/misses/writes independently per instance', 'ttl-cache: mtime vs shifted Date.now'],
  // scripts/lib/infra-gate-registration-check.js — heartbeat freshness from statSync.
  [
    'checkGuardHeartbeat PASSES when the job is loaded and the heartbeat is fresh',
    'heartbeat: statSync mtime vs shifted Date.now',
  ],
]);

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
 * Run the suite and return the set of failing test names.
 *
 * node:test's TAP output prints `not ok <n> - <name>` for each failure,
 * including parent suites. Parent-suite lines are harmless here: a suite only
 * appears in the diff if one of its children newly failed, and it names the
 * right file either way.
 */
function runSuite(files, shiftDays) {
  const args = [];
  if (shiftDays) args.push('--import', PRELOAD);
  args.push('--test', '--test-reporter=tap', ...files);

  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      BSC_CLOCK_SHIFT_DAYS: String(shiftDays || 0),
      // Matches test.yml: keeps unit fixtures out of the committed prod
      // stage-latency telemetry.
      BSC_STAGE_LATENCY_MUTE: '1',
    },
  });

  if (res.error) {
    console.error(`Failed to spawn test run: ${res.error.message}`);
    process.exit(2);
  }

  const failing = new Set();
  for (const line of (res.stdout || '').split('\n')) {
    const m = /^\s*not ok \d+ - (.+?)\s*$/.exec(line);
    if (m) failing.add(m[1]);
  }
  return failing;
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

  if (!opts.json) {
    console.log(`Time-bomb audit: ${files.length} test files, clock shift +${opts.days}d\n`);
    console.log('  [1/2] baseline run (current clock)...');
  }
  const baseline = runSuite(files, 0);

  if (!opts.json) console.log(`  [2/2] shifted run (+${opts.days}d)...`);
  const shifted = runSuite(files, opts.days);

  const bombs = [...shifted]
    .filter((name) => !baseline.has(name))
    .filter((name) => !ALLOWLIST.has(name))
    .sort();

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          shiftDays: opts.days,
          filesChecked: files.length,
          baselineFailures: baseline.size,
          shiftedFailures: shifted.size,
          exempt: [...ALLOWLIST.keys()].filter((n) => shifted.has(n)),
          timeBombs: bombs,
        },
        null,
        2
      )
    );
  } else {
    console.log(
      `\nBaseline failures: ${baseline.size}   Shifted failures: ${shifted.size}\n`
    );
    if (bombs.length === 0) {
      console.log(`PASS — no test changes outcome when the clock moves +${opts.days}d.`);
    } else {
      console.log(`FOUND ${bombs.length} time-bomb test(s) — pass now, fail at +${opts.days}d:\n`);
      for (const b of bombs) console.log(`  ✗ ${b}`);
      console.log(
        '\nFix: make the stamp relative to run time (daysAgoISO(1)), not a hardcoded literal.'
      );
      console.log('Do NOT widen the production freshness window to fit the literal.');
    }
  }

  if (bombs.length > 0 && opts.strict) process.exit(1);
}

main();
