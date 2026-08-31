/**
 * BRO-2608: checkWorktreeGcFreshness() / lastTimestampFromLog() (scripts/lib/
 * worktree-gc-freshness.js) is the pure decision function that flags a stale
 * data/audit/worktree-gc.log — the only automated brake on disk growth from
 * abandoned worktrees. It silently stopped logging for five days
 * (2026-08-26 to 08-31) while disk fell from 88Gi to 26Gi free, and nothing
 * anywhere noticed. worktreeGcFreshnessResults() (scripts/health-check.js)
 * formats it into a digest row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { checkWorktreeGcFreshness, lastTimestampFromLog, STALE_WARN_HOURS, STALE_ERROR_HOURS } = require('../../scripts/lib/worktree-gc-freshness.js');
const { worktreeGcFreshnessResults } = require('../../scripts/health-check.js');

const NOW = new Date('2026-08-31T12:00:00').getTime();

// gc-merged-worktrees.sh writes `date '+%Y-%m-%d %H:%M:%S'` — local wall-clock,
// no timezone marker (confirmed in scripts/gc-merged-worktrees.sh). Format
// test fixtures the same way (via local Date getters, not toISOString(),
// which is UTC) so the test is correct under any system timezone.
function toLocalLogTimestamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  const ts = toLocalLogTimestamp(NOW - 1 * 60 * 60 * 1000);
  assert.equal(checkWorktreeGcFreshness(ts, NOW), null);
});

test('checkWorktreeGcFreshness: just under warn threshold returns null', () => {
  const ts = toLocalLogTimestamp(NOW - (STALE_WARN_HOURS - 0.1) * 60 * 60 * 1000);
  assert.equal(checkWorktreeGcFreshness(ts, NOW), null);
});

test('checkWorktreeGcFreshness: past warn threshold but under error threshold is warn', () => {
  const ts = toLocalLogTimestamp(NOW - (STALE_WARN_HOURS + 1) * 60 * 60 * 1000);
  const result = checkWorktreeGcFreshness(ts, NOW);
  assert.ok(result);
  assert.equal(result.severity, 'warn');
  assert.ok(result.hoursStale >= STALE_WARN_HOURS);
});

test('checkWorktreeGcFreshness: five-day outage (this incident) is error severity', () => {
  const ts = toLocalLogTimestamp(NOW - 5 * 24 * 60 * 60 * 1000);
  const result = checkWorktreeGcFreshness(ts, NOW);
  assert.ok(result);
  assert.equal(result.severity, 'error');
  assert.ok(result.hoursStale >= STALE_ERROR_HOURS);
});

test('STALE_WARN_HOURS and STALE_ERROR_HOURS match documented thresholds', () => {
  assert.equal(STALE_WARN_HOURS, 6);
  assert.equal(STALE_ERROR_HOURS, 24);
});

// --- worktreeGcFreshnessResults (health-check.js digest formatting) ---

test('worktreeGcFreshnessResults: fresh timestamp yields nothing', () => {
  const ts = toLocalLogTimestamp(NOW - 1 * 60 * 60 * 1000);
  assert.deepEqual(worktreeGcFreshnessResults(ts, NOW), []);
});

test('worktreeGcFreshnessResults: stale log warns with an actionable hint', () => {
  const ts = toLocalLogTimestamp(NOW - 10 * 60 * 60 * 1000);
  const results = worktreeGcFreshnessResults(ts, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /10\.0h/);
  assert.match(results[0].hint, /launchctl print/);
});

test('worktreeGcFreshnessResults: five-day-stale log (this incident) is error severity', () => {
  const ts = toLocalLogTimestamp(NOW - 5 * 24 * 60 * 60 * 1000);
  const results = worktreeGcFreshnessResults(ts, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'error');
});

test('worktreeGcFreshnessResults: missing/null timestamp yields nothing (log-absent case is a separate concern)', () => {
  assert.deepEqual(worktreeGcFreshnessResults(null, NOW), []);
  assert.deepEqual(worktreeGcFreshnessResults(undefined, NOW), []);
});
