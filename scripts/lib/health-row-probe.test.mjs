import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { probeHealthRowLive } = require('./health-row-probe.js');
const { isSafeCheckCommand } = require('./autonomous-triage-core.js');

// Task #1662: check-health-row-absent.js's SNAPSHOT constant is read at
// module-load time, so the env override must be set BEFORE requiring it — a
// throwaway mkdtemp fixture instead of mutating the real tracked
// data/audit/health-digest-snapshot.json (which CI/~20 parallel sessions
// write on their own cadence).
const SNAPSHOT_FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'health-row-probe-snapshot-'));
const SNAPSHOT_PATH = path.join(SNAPSHOT_FIXTURE_DIR, 'health-digest-snapshot.json');
process.env.HEALTH_ROW_ABSENT_SNAPSHOT_PATH = SNAPSHOT_PATH;
after(() => fs.rmSync(SNAPSHOT_FIXTURE_DIR, { recursive: true, force: true }));
const { main: checkMain } = require('../check-health-row-absent.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEALTH_CHECK_PATH = require.resolve('../health-check.js');
const DISPATCH_STATE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'dispatch-outcome-digest-state.json');

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}

// probeHealthRowLive requires('../health-check.js') fresh on every call (not
// cached at health-row-probe.js's own module load), so installing a fake
// module in require.cache under health-check.js's resolved path reliably
// intercepts it — a deterministic, hermetic way to control what "live"
// results look like without depending on this machine's real credentials,
// local data files, or network access.
async function withStubbedCoreResults(results, fn) {
  const original = require.cache[HEALTH_CHECK_PATH];
  require.cache[HEALTH_CHECK_PATH] = {
    id: HEALTH_CHECK_PATH,
    filename: HEALTH_CHECK_PATH,
    loaded: true,
    exports: { computeCoreHealthResults: async () => results },
  };
  try {
    return await fn();
  } finally {
    if (original) require.cache[HEALTH_CHECK_PATH] = original;
    else delete require.cache[HEALTH_CHECK_PATH];
  }
}

test('probeHealthRowLive: row present with status pass -> verdict absent (fixed)', async () => {
  const out = await withStubbedCoreResults(
    [{ name: 'Probe test: fixture row', status: 'pass', message: 'ok now' }],
    () => probeHealthRowLive('Probe test: fixture row'),
  );
  assert.equal(out.verdict, 'absent');
  assert.equal(out.matched.status, 'pass');
});

test('probeHealthRowLive: row present with status error/warn and a real message -> verdict present (still broken)', async () => {
  const out = await withStubbedCoreResults(
    [{ name: 'Probe test: fixture row', status: 'error', message: 'still broken' }],
    () => probeHealthRowLive('Probe test: fixture row'),
  );
  assert.equal(out.verdict, 'present');
});

test('probeHealthRowLive: row absent from every status -> verdict unknown, never a silent pass', async () => {
  const out = await withStubbedCoreResults(
    [{ name: 'Some other row', status: 'pass', message: 'unrelated' }],
    () => probeHealthRowLive('Probe test: never-computed row'),
  );
  assert.equal(out.verdict, 'unknown');
});

test('probeHealthRowLive: row only appears as a warn-status credential-skip placeholder -> verdict unknown, not present or absent', async () => {
  // Real shape checkCronHealth()/checkSecretsHealth()/etc. emit when a
  // required token is missing (see module header) — the single placeholder
  // row name can collide with a real check's own success-path name.
  const out = await withStubbedCoreResults(
    [{ name: 'Cron: health', status: 'warn', message: 'Skipped — no GH_TOKEN available (local run)' }],
    () => probeHealthRowLive('Cron: health'),
  );
  assert.equal(out.verdict, 'unknown');
});

test('probeHealthRowLive: row only appears as a PASS-status checkout-skip placeholder -> verdict unknown, not a false pass (ship-check finding)', async () => {
  // Real shape checkSync()'s "Sync: review-texts vs reviews.json" row when
  // the private review-texts repo isn't checked out — status 'pass', not
  // 'warn'. A card targeting this exact row must not exit 0 just because
  // this sandbox never actually re-ran the real check.
  const out = await withStubbedCoreResults(
    [{ name: 'Sync: review-texts vs reviews.json', status: 'pass', message: 'Skipped — review-texts not checked out (private repo)' }],
    () => probeHealthRowLive('Sync: review-texts vs reviews.json'),
  );
  assert.equal(out.verdict, 'unknown');
});

test('probeHealthRowLive: row only appears as a parenthetical PASS-status skip placeholder -> verdict unknown', async () => {
  // Real shape checkQuality()'s star-vs-score / missing-contentTier / etc.
  // rows use "Skipped (...)" (parentheses, no em dash) at status 'pass'.
  const out = await withStubbedCoreResults(
    [{ name: 'Quality: star-vs-score mismatch', status: 'pass', message: 'Skipped (review-texts not checked out)' }],
    () => probeHealthRowLive('Quality: star-vs-score mismatch'),
  );
  assert.equal(out.verdict, 'unknown');
});

test('probeHealthRowLive: name matching truncates at the same 120-char bound check-health-row-absent.js encodes with', async () => {
  const longName = 'Z'.repeat(300);
  const out = await withStubbedCoreResults(
    [{ name: longName.slice(0, 120), status: 'pass', message: 'ok' }],
    () => probeHealthRowLive(longName),
  );
  assert.equal(out.verdict, 'absent');
});

test('isSafeCheckCommand accepts the --row-b64 ... --live form used to invoke this probe', () => {
  const token = b64url('Probe test: fixture row');
  assert.equal(isSafeCheckCommand(`node scripts/check-health-row-absent.js --row-b64 ${token} --live`), true);
});

test('check-health-row-absent.js --live: exit code follows the probe verdict (0 absent, 1 present, 3 unknown)', async () => {
  const row = 'Probe test: fixture row';
  const token = b64url(row);
  const argv = ['node', 'check-health-row-absent.js', '--row-b64', token, '--live'];

  assert.equal(
    await withStubbedCoreResults([{ name: row, status: 'pass', message: 'ok' }], () => checkMain(argv)),
    0,
  );
  assert.equal(
    await withStubbedCoreResults([{ name: row, status: 'error', message: 'broken' }], () => checkMain(argv)),
    1,
  );
  assert.equal(
    await withStubbedCoreResults([], () => checkMain(argv)),
    3,
  );
});

test('check-health-row-absent.js: --live reports fixed even while a stale/fake snapshot still lists the row as present (acceptance criterion)', async () => {
  const row = `Probe test: acceptance fixture ${process.pid}`;
  const token = b64url(row);

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    errors: [],
    warns: [{ name: row, status: 'warn', message: 'still broken (fixture)' }],
  }, null, 2));

  // Non-live: reads the (fixture) snapshot, which still lists the row -> FAIL.
  const staleCode = await checkMain(['node', 'check-health-row-absent.js', '--row-b64', token]);
  assert.equal(staleCode, 1, 'non-live path should still see the fixture snapshot as present');

  // Live: the fix already landed (stubbed as status pass) -> PASS, despite
  // the snapshot file on disk not having caught up yet.
  const liveCode = await withStubbedCoreResults(
    [{ name: row, status: 'pass', message: 'fixed' }],
    () => checkMain(['node', 'check-health-row-absent.js', '--row-b64', token, '--live']),
  );
  assert.equal(liveCode, 0, '--live should report the row fixed despite the stale snapshot');
});

test('a probe run performs zero real fs writes (spy on the REAL, unpatched fs)', async () => {
  const realFs = require('node:fs');
  let realWriteCalls = 0;
  const originalWrite = realFs.writeFileSync;
  const originalAppend = realFs.appendFileSync;
  realFs.writeFileSync = (...args) => { realWriteCalls++; return originalWrite(...args); };
  realFs.appendFileSync = (...args) => { realWriteCalls++; return originalAppend(...args); };
  try {
    // Real (unstubbed) computeCoreHealthResults — exercises the actual
    // checkDispatchOutcomes dryRun path and the fs monkey-patch backstop
    // together, against this machine's real local data.
    await probeHealthRowLive('__health-row-probe-test-zero-writes__');
  } finally {
    realFs.writeFileSync = originalWrite;
    realFs.appendFileSync = originalAppend;
  }
  assert.equal(realWriteCalls, 0, `probeHealthRowLive performed ${realWriteCalls} real fs write(s)`);
});

test('a probe run never touches the dispatch-outcome-digest-state.json trend cache (regression pin on the one known writer among the 22 checks)', async () => {
  const before = fs.existsSync(DISPATCH_STATE_PATH) ? fs.statSync(DISPATCH_STATE_PATH).mtimeMs : null;
  await probeHealthRowLive('__health-row-probe-test-no-state-write__');
  const after = fs.existsSync(DISPATCH_STATE_PATH) ? fs.statSync(DISPATCH_STATE_PATH).mtimeMs : null;
  assert.equal(after, before, 'dispatch-outcome-digest-state.json mtime changed across a probe run');
});

test('two concurrent in-process probe calls stay side-effect-free (reentrancy — ship-check finding, task #1224)', async () => {
  // The original write-disable window was not reentrant: the first of two
  // overlapping calls to finish would restore the REAL fs.writeFileSync
  // while the second call was still mid-flight, un-protecting it. Real
  // usage always runs --live as a fresh CLI process (never overlapping
  // in-process calls), but Promise.all-ing two probes in the same process
  // must still never leak a real write.
  const realFs = require('node:fs');
  let realWriteCalls = 0;
  const originalWrite = realFs.writeFileSync;
  realFs.writeFileSync = (...args) => { realWriteCalls++; return originalWrite(...args); };
  try {
    // One shared stub (not two nested withStubbedCoreResults calls) — the
    // require.cache-swap trick this test file uses for stubbing is itself
    // not reentrant, so overlapping it would test the test harness's race,
    // not health-row-probe.js's. The fs-write-disable reentrancy under test
    // lives entirely inside health-row-probe.js's own withWritesDisabled.
    const [a, b] = await withStubbedCoreResults(
      [
        { name: 'Row A', status: 'pass', message: 'ok' },
        { name: 'Row B', status: 'error', message: 'broken' },
      ],
      () => Promise.all([probeHealthRowLive('Row A'), probeHealthRowLive('Row B')]),
    );
    assert.equal(a.verdict, 'absent');
    assert.equal(b.verdict, 'present');
  } finally {
    realFs.writeFileSync = originalWrite;
  }
  assert.equal(realWriteCalls, 0, `overlapping probes performed ${realWriteCalls} real fs write(s)`);
});
