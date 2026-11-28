import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseArgs, evaluateThroughputGate, readFreshSnapshot, SNAPSHOT_MAX_AGE_MS } = require('./check-linear-drain-throughput.js');

test('parseArgs: reads flags with and without values', () => {
  assert.deepEqual(parseArgs(['--min-done-per-day', '15', '--live']), { 'min-done-per-day': '15', live: true });
});

test('evaluateThroughputGate: above the bar passes', () => {
  const v = evaluateThroughputGate(20, 15);
  assert.equal(v.ok, true);
});

test('evaluateThroughputGate: exactly at the bar passes', () => {
  const v = evaluateThroughputGate(15, 15);
  assert.equal(v.ok, true);
});

test('evaluateThroughputGate: below the bar fails', () => {
  const v = evaluateThroughputGate(8.5, 15);
  assert.equal(v.ok, false);
});

test('evaluateThroughputGate: non-finite donePerDay is unverifiable, not a fail', () => {
  assert.equal(evaluateThroughputGate(null, 15).ok, null);
  assert.equal(evaluateThroughputGate(NaN, 15).ok, null);
  assert.equal(evaluateThroughputGate(undefined, 15).ok, null);
});

test('evaluateThroughputGate: a bad bar (non-positive) is unverifiable, not a false pass', () => {
  assert.equal(evaluateThroughputGate(20, 0).ok, null);
  assert.equal(evaluateThroughputGate(20, -5).ok, null);
  assert.equal(evaluateThroughputGate(20, NaN).ok, null);
});

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-throughput-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('readFreshSnapshot: a snapshot within the staleness window is returned', () => {
  withTmpDir((dir) => {
    const snapshotPath = path.join(dir, 'snapshot.json');
    const nowMs = Date.now();
    fs.writeFileSync(snapshotPath, JSON.stringify({ computedAt: new Date(nowMs - 1000).toISOString(), donePerDay: 12.3, windowDays: 7 }));
    const result = readFreshSnapshot(snapshotPath, nowMs);
    assert.equal(result.donePerDay, 12.3);
  });
});

test('readFreshSnapshot: a fresh snapshot with no donePerDay (a failed digest run) falls back to null, not a stuck "fresh" cache miss', () => {
  withTmpDir((dir) => {
    const snapshotPath = path.join(dir, 'snapshot.json');
    const nowMs = Date.now();
    fs.writeFileSync(snapshotPath, JSON.stringify({ computedAt: new Date(nowMs - 1000).toISOString(), donePerDay: null, windowDays: null }));
    assert.equal(readFreshSnapshot(snapshotPath, nowMs), null);
  });
});

test('readFreshSnapshot: a snapshot past SNAPSHOT_MAX_AGE_MS is treated as missing (null)', () => {
  withTmpDir((dir) => {
    const snapshotPath = path.join(dir, 'snapshot.json');
    const nowMs = Date.now();
    const staleComputedAt = new Date(nowMs - SNAPSHOT_MAX_AGE_MS - 60_000).toISOString();
    fs.writeFileSync(snapshotPath, JSON.stringify({ computedAt: staleComputedAt, donePerDay: 12.3, windowDays: 7 }));
    assert.equal(readFreshSnapshot(snapshotPath, nowMs), null);
  });
});

test('readFreshSnapshot: an unparseable computedAt is treated as missing (null), not a thrown error', () => {
  withTmpDir((dir) => {
    const snapshotPath = path.join(dir, 'snapshot.json');
    fs.writeFileSync(snapshotPath, JSON.stringify({ computedAt: 'not-a-date', donePerDay: 12.3 }));
    assert.equal(readFreshSnapshot(snapshotPath), null);
  });
});

test('readFreshSnapshot: invalid JSON is treated as missing (null), not a thrown error', () => {
  withTmpDir((dir) => {
    const snapshotPath = path.join(dir, 'snapshot.json');
    fs.writeFileSync(snapshotPath, '{not json');
    assert.equal(readFreshSnapshot(snapshotPath), null);
  });
});

test('readFreshSnapshot: missing file returns null, not a thrown error', () => {
  withTmpDir((dir) => {
    assert.equal(readFreshSnapshot(path.join(dir, 'does-not-exist.json')), null);
  });
});
