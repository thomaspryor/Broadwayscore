/**
 * BRO-2608: checkWorktreeGcFreshness() / lastTimestampFromLog() (scripts/lib/
 * worktree-gc-freshness.js) is the pure decision function that flags a stale
 * data/audit/worktree-gc.log — the only automated brake on disk growth from
 * abandoned worktrees. It silently stopped logging for five days
 * (2026-08-26 to 08-31) while disk fell from 88Gi to 26Gi free, and nothing
 * anywhere noticed. worktreeGcFreshnessResults() (scripts/health-check.js)
 * formats it into a digest row.
 *
 * gc-merged-worktrees.sh writes `date -u '+%Y-%m-%d %H:%M:%S'` (UTC, no
 * offset marker) precisely because the writer (Mac Studio, local TZ) and the
 * reader (health-check.js's daily digest, ubuntu-latest GitHub Actions
 * runner, always UTC) are different hosts — an earlier local-time version of
 * this log/checker pair misfired daily on the UTC runner (a naive
 * offset-less parse reads local-Mac-Studio time back as UTC). Fixture
 * timestamps below are built via Date.UTC so this test is correct under any
 * TZ the test itself happens to run in, exercising the exact real-world
 * write-in-NY/read-in-UTC split.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { checkWorktreeGcFreshness, lastTimestampFromLog, STALE_WARN_HOURS, STALE_ERROR_HOURS } = require('../../scripts/lib/worktree-gc-freshness.js');
const { worktreeGcFreshnessResults } = require('../../scripts/health-check.js');

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0); // 2026-08-31T12:00:00Z

// Formats a UTC instant the same way gc-merged-worktrees.sh's `date -u` does:
// "YYYY-MM-DD HH:MM:SS", no offset marker.
function toUtcLogTimestamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// --- lastTimestampFromLog ---

test('lastTimestampFromLog: extracts the newest bracketed timestamp', () => {
  const log = [
    '[2026-08-26 10:50:37] SKIP-RUN',
    '[2026-08-26 10:57:00] DONE  removed=1 kept=2 skipped=0 freed=0KB (dry_run=1)',
  ].join('\n');
  assert.equal(lastTimestampFromLog(log), '2026-08-26 10:57:00');
});

test('lastTimestampFromLog: ignores trailing blank lines and unbracketed noise', () => {
  const log = '[2026-08-31 11:20:22] DONE  removed=0 kept=0 skipped=0 freed=0KB (dry_run=1)\nsome trailing note without brackets\n\n';
  assert.equal(lastTimestampFromLog(log), '2026-08-31 11:20:22');
});

test('lastTimestampFromLog: null/undefined/empty returns null', () => {
  assert.equal(lastTimestampFromLog(null), null);
  assert.equal(lastTimestampFromLog(undefined), null);
  assert.equal(lastTimestampFromLog(''), null);
  assert.equal(lastTimestampFromLog('no timestamps here'), null);
});

// --- checkWorktreeGcFreshness ---

test('checkWorktreeGcFreshness: null/undefined/unparseable timestamp returns null', () => {
  assert.equal(checkWorktreeGcFreshness(null, NOW), null);
  assert.equal(checkWorktreeGcFreshness(undefined, NOW), null);
  assert.equal(checkWorktreeGcFreshness('not-a-date', NOW), null);
});

test('checkWorktreeGcFreshness: fresh (within an hourly cycle) returns null', () => {
  const ts = toUtcLogTimestamp(NOW - 1 * 60 * 60 * 1000);
  assert.equal(checkWorktreeGcFreshness(ts, NOW), null);
});

test('checkWorktreeGcFreshness: just under warn threshold returns null', () => {
  const ts = toUtcLogTimestamp(NOW - (STALE_WARN_HOURS - 0.1) * 60 * 60 * 1000);
  assert.equal(checkWorktreeGcFreshness(ts, NOW), null);
});

test('checkWorktreeGcFreshness: past warn threshold but under error threshold is warn', () => {
  const ts = toUtcLogTimestamp(NOW - (STALE_WARN_HOURS + 1) * 60 * 60 * 1000);
  const result = checkWorktreeGcFreshness(ts, NOW);
  assert.ok(result);
  assert.equal(result.severity, 'warn');
  assert.ok(result.hoursStale >= STALE_WARN_HOURS);
});

test('checkWorktreeGcFreshness: five-day outage (this incident) is error severity', () => {
  const ts = toUtcLogTimestamp(NOW - 5 * 24 * 60 * 60 * 1000);
  const result = checkWorktreeGcFreshness(ts, NOW);
  assert.ok(result);
  assert.equal(result.severity, 'error');
  assert.ok(result.hoursStale >= STALE_ERROR_HOURS);
});

test('checkWorktreeGcFreshness: result is identical regardless of the calling process\'s TZ (the actual bug this fix closes)', () => {
  // health-check.js writes the log locally (Mac Studio, America/New_York)
  // but reads it for freshness on a UTC GitHub Actions runner
  // (data-health-check.yml). An earlier offset-less Date.parse read the
  // timestamp back as the CALLING process's local time, so the same log
  // line computed a different hoursStale depending on which host asked —
  // silently misfiring the WARN threshold on the UTC runner. Spawn child
  // processes with different TZ env vars (can't be simulated in-process —
  // Node reads TZ once at startup) and assert every one agrees.
  const ts = toUtcLogTimestamp(NOW - 3 * 60 * 60 * 1000); // 3h stale, always < 6h warn
  const script = `
    const { checkWorktreeGcFreshness } = require(${JSON.stringify(require.resolve('../../scripts/lib/worktree-gc-freshness.js'))});
    const r = checkWorktreeGcFreshness(${JSON.stringify(ts)}, ${NOW});
    console.log(JSON.stringify(r));
  `;
  const results = ['UTC', 'America/New_York', 'Pacific/Kiritimati'].map((tz) =>
    execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim()
  );
  assert.equal(results[0], 'null');
  assert.equal(results[1], results[0]);
  assert.equal(results[2], results[0]);
});

test('STALE_WARN_HOURS and STALE_ERROR_HOURS match documented thresholds', () => {
  assert.equal(STALE_WARN_HOURS, 6);
  assert.equal(STALE_ERROR_HOURS, 24);
});

// --- worktreeGcFreshnessResults (health-check.js digest formatting) ---

test('worktreeGcFreshnessResults: fresh timestamp yields nothing', () => {
  const ts = toUtcLogTimestamp(NOW - 1 * 60 * 60 * 1000);
  assert.deepEqual(worktreeGcFreshnessResults(ts, NOW), []);
});

test('worktreeGcFreshnessResults: stale log warns with an actionable hint', () => {
  const ts = toUtcLogTimestamp(NOW - 10 * 60 * 60 * 1000);
  const results = worktreeGcFreshnessResults(ts, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /10\.0h/);
  assert.match(results[0].hint, /launchctl print/);
});

test('worktreeGcFreshnessResults: five-day-stale log (this incident) is error severity', () => {
  const ts = toUtcLogTimestamp(NOW - 5 * 24 * 60 * 60 * 1000);
  const results = worktreeGcFreshnessResults(ts, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'error');
});

test('worktreeGcFreshnessResults: missing/null timestamp yields nothing (log-absent case is a separate concern)', () => {
  assert.deepEqual(worktreeGcFreshnessResults(null, NOW), []);
  assert.deepEqual(worktreeGcFreshnessResults(undefined, NOW), []);
});
