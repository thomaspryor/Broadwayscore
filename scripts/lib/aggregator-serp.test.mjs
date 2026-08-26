import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isEligibleForAggregatorSerp,
  checkArchiveCache,
  shouldSkipAggregatorSerp,
  recordAggregatorSerpAttempt,
  resetAggregatorSerpState,
  DEFAULT_LIFECYCLE_WINDOW_DAYS,
} = require('./aggregator-serp.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-21T00:00:00Z');

function tmpFile(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'state.json');
}

// ── isEligibleForAggregatorSerp ──────────────────────────────────────────────

test('lifecycle: open show is always eligible', () => {
  assert.equal(isEligibleForAggregatorSerp({ status: 'open' }, { now: NOW }), true);
});

test('lifecycle: closed show with no closingDate is eligible (unknown treated as recent)', () => {
  assert.equal(isEligibleForAggregatorSerp({ status: 'closed' }, { now: NOW }), true);
});

test('lifecycle: closed show 181 days ago is NOT eligible under the default 180-day window', () => {
  const closingDate = new Date(NOW - 181 * DAY_MS).toISOString();
  assert.equal(DEFAULT_LIFECYCLE_WINDOW_DAYS, 180);
  assert.equal(isEligibleForAggregatorSerp({ status: 'closed', closingDate }, { now: NOW }), false);
});

test('lifecycle: closed show 179 days ago is still eligible under the default 180-day window', () => {
  const closingDate = new Date(NOW - 179 * DAY_MS).toISOString();
  assert.equal(isEligibleForAggregatorSerp({ status: 'closed', closingDate }, { now: NOW }), true);
});

test('lifecycle: custom windowDays is honored', () => {
  const closingDate = new Date(NOW - 40 * DAY_MS).toISOString();
  assert.equal(isEligibleForAggregatorSerp({ status: 'closed', closingDate }, { now: NOW, windowDays: 30 }), false);
  assert.equal(isEligibleForAggregatorSerp({ status: 'closed', closingDate }, { now: NOW, windowDays: 90 }), true);
});

test('lifecycle: an invalid closingDate string is treated as unknown (eligible)', () => {
  assert.equal(isEligibleForAggregatorSerp({ status: 'closed', closingDate: 'not-a-date' }, { now: NOW }), true);
});

// ── checkArchiveCache ─────────────────────────────────────────────────────────

test('archive cache: missing file is a miss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-archive-'));
  const result = checkArchiveCache(path.join(dir, 'nope.html'));
  assert.equal(result.fresh, false);
  assert.equal(result.html, null);
});

test('archive cache: file younger than ttlDays is a hit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-archive-'));
  const file = path.join(dir, 'show.html');
  fs.writeFileSync(file, '<html>cached</html>');
  const result = checkArchiveCache(file, { ttlDays: 14 });
  assert.equal(result.fresh, true);
  assert.equal(result.html, '<html>cached</html>');
});

test('archive cache: file older than ttlDays is a miss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-archive-'));
  const file = path.join(dir, 'show.html');
  fs.writeFileSync(file, '<html>stale</html>');
  const staleTime = (Date.now() - 15 * DAY_MS) / 1000;
  fs.utimesSync(file, staleTime, staleTime);
  const result = checkArchiveCache(file, { ttlDays: 14 });
  assert.equal(result.fresh, false);
  assert.equal(result.html, null);
});

test('archive cache: force bypasses an otherwise-fresh cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-archive-'));
  const file = path.join(dir, 'show.html');
  fs.writeFileSync(file, '<html>cached</html>');
  const result = checkArchiveCache(file, { force: true });
  assert.equal(result.fresh, false);
});

// ── skip-state (3-strikes) ───────────────────────────────────────────────────

test('skip-state: fresh show is never skipped', () => {
  const statePath = tmpFile('agg-state-');
  assert.equal(shouldSkipAggregatorSerp('bww', 'some-show', { statePath }), false);
});

test('skip-state: 3 consecutive misses trips skip_aggregator_serp', () => {
  const statePath = tmpFile('agg-state-');
  recordAggregatorSerpAttempt('bww', 'ghost-show', { statePath, success: false, now: NOW });
  assert.equal(shouldSkipAggregatorSerp('bww', 'ghost-show', { statePath }), false);
  recordAggregatorSerpAttempt('bww', 'ghost-show', { statePath, success: false, now: NOW });
  assert.equal(shouldSkipAggregatorSerp('bww', 'ghost-show', { statePath }), false);
  const third = recordAggregatorSerpAttempt('bww', 'ghost-show', { statePath, success: false, now: NOW });
  assert.equal(third.consecutiveMisses, 3);
  assert.equal(third.skip_aggregator_serp, true);
  assert.equal(shouldSkipAggregatorSerp('bww', 'ghost-show', { statePath }), true);
});

test('skip-state: a success resets the streak', () => {
  const statePath = tmpFile('agg-state-');
  recordAggregatorSerpAttempt('bww', 'flaky-show', { statePath, success: false, now: NOW });
  recordAggregatorSerpAttempt('bww', 'flaky-show', { statePath, success: false, now: NOW });
  const afterHit = recordAggregatorSerpAttempt('bww', 'flaky-show', { statePath, success: true, now: NOW });
  assert.equal(afterHit.consecutiveMisses, 0);
  assert.equal(afterHit.skip_aggregator_serp, false);
  // Two more misses after a reset should NOT trip the flag (needs 3 fresh in a row).
  recordAggregatorSerpAttempt('bww', 'flaky-show', { statePath, success: false, now: NOW });
  const stillOk = recordAggregatorSerpAttempt('bww', 'flaky-show', { statePath, success: false, now: NOW });
  assert.equal(stillOk.skip_aggregator_serp, false);
});

test('skip-state: sources are namespaced independently for the same showId', () => {
  const statePath = tmpFile('agg-state-');
  for (let i = 0; i < 3; i++) recordAggregatorSerpAttempt('bww', 'shared-show', { statePath, success: false, now: NOW });
  assert.equal(shouldSkipAggregatorSerp('bww', 'shared-show', { statePath }), true);
  assert.equal(shouldSkipAggregatorSerp('playbill-verdict', 'shared-show', { statePath }), false);
});

test('skip-state: custom maxMisses is honored', () => {
  const statePath = tmpFile('agg-state-');
  recordAggregatorSerpAttempt('lbo', 'show-x', { statePath, success: false, now: NOW, maxMisses: 1 });
  assert.equal(shouldSkipAggregatorSerp('lbo', 'show-x', { statePath }), true);
});

test('skip-state: resetAggregatorSerpState clears an entry', () => {
  const statePath = tmpFile('agg-state-');
  for (let i = 0; i < 3; i++) recordAggregatorSerpAttempt('bww', 'reset-me', { statePath, success: false, now: NOW });
  assert.equal(shouldSkipAggregatorSerp('bww', 'reset-me', { statePath }), true);
  resetAggregatorSerpState('bww', 'reset-me', { statePath });
  assert.equal(shouldSkipAggregatorSerp('bww', 'reset-me', { statePath }), false);
});

test('skip-state: concurrent writes to different keys from the same process do not lose updates', () => {
  // Simulates the real hazard: BWW and Playbill Verdict workflows overlapping
  // in wall-clock time, both writing the same state file for different
  // showIds. Without the file-lock, an unlocked load-mutate-save would let
  // one writer's save clobber the other's concurrent update.
  const statePath = tmpFile('agg-state-');
  const writers = [];
  for (let i = 0; i < 20; i++) {
    writers.push(() => recordAggregatorSerpAttempt(i % 2 === 0 ? 'bww' : 'playbill-verdict', `show-${i}`, { statePath, success: false, now: NOW }));
  }
  // Interleave synchronously (Node is single-threaded, but withFileLock's
  // busy-wait spin means overlapping calls from async contexts would race —
  // this proves the sequential/lock-protected path preserves every key).
  writers.forEach(w => w());
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(Object.keys(raw).length, 20);
  for (let i = 0; i < 20; i++) {
    const key = `${i % 2 === 0 ? 'bww' : 'playbill-verdict'}::show-${i}`;
    assert.equal(raw[key].consecutiveMisses, 1);
  }
});

test('skip-state: concurrent writes from SEPARATE OS processes do not lose updates', async () => {
  // The real-world hazard the reviewer flagged: scrape-bww-reviews.yml and
  // a Playbill Verdict run are independent workflows on independent cron
  // schedules/concurrency groups that can genuinely overlap in wall-clock
  // time, each in its own process, both read-modify-write the SAME state
  // file. A single-process test (Node is cooperatively single-threaded)
  // can't reproduce a true interleaved read-modify-write race — this spawns
  // real child processes to prove the file-lock actually protects across
  // process boundaries, not just across async callbacks in one process.
  const statePath = tmpFile('agg-state-mp-');
  const libPath = fileURLToPath(new URL('./aggregator-serp.js', import.meta.url));
  const N = 8;
  const child = (i) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['-e', `
      const { recordAggregatorSerpAttempt } = require(${JSON.stringify(libPath)});
      recordAggregatorSerpAttempt('bww', 'mp-show-${i}', { statePath: ${JSON.stringify(statePath)}, success: false, now: ${NOW} });
    `]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`child ${i} exited ${code}: ${stderr}`)));
  });
  await Promise.all(Array.from({ length: N }, (_, i) => child(i)));
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(Object.keys(raw).length, N, `expected all ${N} concurrent child-process writes to survive, got ${Object.keys(raw).length}`);
  for (let i = 0; i < N; i++) {
    assert.equal(raw[`bww::mp-show-${i}`].consecutiveMisses, 1);
  }
});

test('skip-state: persists to disk across separate loads (survives process restart)', () => {
  const statePath = tmpFile('agg-state-');
  for (let i = 0; i < 3; i++) recordAggregatorSerpAttempt('bww', 'durable-show', { statePath, success: false, now: NOW });
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(raw['bww::durable-show'].skip_aggregator_serp, true);
  // A fresh "process" reading the same path sees the same answer.
  assert.equal(shouldSkipAggregatorSerp('bww', 'durable-show', { statePath }), true);
});
