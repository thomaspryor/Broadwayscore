import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  DEFAULT_REFETCH_CONFIG,
  checkRefetchAllowed,
  decideRefetch,
  recordRefetch,
  rolloverDay,
  fileAttempts,
  emptyState,
  loadRecoveryState,
  saveRecoveryState,
} = require('./refetch-circuit-breaker.js');

const NOW = new Date('2026-07-22T12:00:00Z');

test('defaults: 10/day global cap, per-file cap matches FLAGGED_RECOVERY_CAP (3)', () => {
  const { FLAGGED_RECOVERY_CAP } = require('./flagged-recovery.js');
  assert.equal(DEFAULT_REFETCH_CONFIG.dailyGlobalCap, 10);
  assert.equal(DEFAULT_REFETCH_CONFIG.perFileCap, FLAGGED_RECOVERY_CAP);
  assert.equal(DEFAULT_REFETCH_CONFIG.perFileCap, 3);
});

test('pure decision: allows under both caps', () => {
  assert.deepEqual(checkRefetchAllowed({ globalToday: 0, attempts: 0 }), { allowed: true, reason: 'ok' });
  assert.equal(checkRefetchAllowed({ globalToday: 9, attempts: 2 }).allowed, true);
});

test('11th request of the day is denied (global cap)', () => {
  // 10 already used today → the 11th is denied.
  const d = checkRefetchAllowed({ globalToday: 10, attempts: 0 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'daily-global-cap');
  assert.equal(d.limit, 10);
});

test('per-file 4th attempt is denied (per-file cap = 3)', () => {
  // 3 attempts already logged for this file → the 4th is denied, even with budget.
  const d = checkRefetchAllowed({ globalToday: 0, attempts: 3 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'per-file-cap');
  assert.equal(d.limit, 3);
});

test('global cap is checked before per-file cap', () => {
  // Both breached → global wins (ordering matters for the reason label).
  const d = checkRefetchAllowed({ globalToday: 10, attempts: 3 });
  assert.equal(d.reason, 'daily-global-cap');
});

test('rolloverDay resets globalCount on a new UTC day but preserves per-file history', () => {
  const stale = { day: '2026-07-21', globalCount: 8, files: { 'a/b.json': { attempts: 2 } } };
  const rolled = rolloverDay(stale, NOW);
  assert.equal(rolled.day, '2026-07-22');
  assert.equal(rolled.globalCount, 0);
  assert.equal(fileAttempts(rolled, 'a', 'b.json'), 2); // history survives
});

test('rolloverDay keeps globalCount on the same UTC day', () => {
  const same = { day: '2026-07-22', globalCount: 5, files: {} };
  assert.equal(rolloverDay(same, NOW).globalCount, 5);
});

test('recordRefetch bumps global + per-file counters', () => {
  let s = emptyState(NOW);
  s = recordRefetch(s, { showId: 'grace', fileName: 'nytimes--jesse-green.json', now: NOW });
  assert.equal(s.globalCount, 1);
  assert.equal(fileAttempts(s, 'grace', 'nytimes--jesse-green.json'), 1);
  s = recordRefetch(s, { showId: 'grace', fileName: 'nytimes--jesse-green.json', now: NOW });
  assert.equal(s.globalCount, 2);
  assert.equal(fileAttempts(s, 'grace', 'nytimes--jesse-green.json'), 2);
  assert.ok(s.files['grace/nytimes--jesse-green.json'].lastAttemptAt);
});

test('per-file cap denies the 4th attempt after 3 records', () => {
  let s = emptyState(NOW);
  for (let i = 0; i < 3; i++) {
    const d = decideRefetch(s, { showId: 'x', fileName: 'times--clive.json', now: NOW });
    assert.equal(d.allowed, true, `attempt ${i + 1} should be allowed`);
    s = recordRefetch(d.state, { showId: 'x', fileName: 'times--clive.json', now: NOW });
  }
  const d4 = decideRefetch(s, { showId: 'x', fileName: 'times--clive.json', now: NOW });
  assert.equal(d4.allowed, false);
  assert.equal(d4.reason, 'per-file-cap');
});

test('global cap denies the 11th distinct-file attempt in a day', () => {
  let s = emptyState(NOW);
  for (let i = 0; i < 10; i++) {
    const d = decideRefetch(s, { showId: 's', fileName: `outlet${i}--c.json`, now: NOW });
    assert.equal(d.allowed, true, `refetch ${i + 1} should be allowed`);
    s = recordRefetch(d.state, { showId: 's', fileName: `outlet${i}--c.json`, now: NOW });
  }
  const d11 = decideRefetch(s, { showId: 's', fileName: 'outlet10--c.json', now: NOW });
  assert.equal(d11.allowed, false);
  assert.equal(d11.reason, 'daily-global-cap');
});

test('state survives across invocations (load/save roundtrip)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refetch-state-'));
  const p = path.join(dir, 't1-recovery-state.json');
  try {
    // Invocation 1: record two attempts and persist.
    let s = loadRecoveryState(p, NOW); // missing file → fresh
    assert.equal(s.globalCount, 0);
    s = recordRefetch(s, { showId: 'grace', fileName: 'nytimes--x.json', now: NOW });
    s = recordRefetch(s, { showId: 'grace', fileName: 'nytimes--x.json', now: NOW });
    saveRecoveryState(p, s);

    // Invocation 2: a fresh load sees the persisted counters.
    const reloaded = loadRecoveryState(p, NOW);
    assert.equal(reloaded.globalCount, 2);
    assert.equal(fileAttempts(reloaded, 'grace', 'nytimes--x.json'), 2);

    // And the 3rd is allowed, 4th denied — cap persists across the reload.
    const d3 = decideRefetch(reloaded, { showId: 'grace', fileName: 'nytimes--x.json', now: NOW });
    assert.equal(d3.allowed, true);
    let s3 = recordRefetch(d3.state, { showId: 'grace', fileName: 'nytimes--x.json', now: NOW });
    saveRecoveryState(p, s3);
    const d4 = decideRefetch(loadRecoveryState(p, NOW), { showId: 'grace', fileName: 'nytimes--x.json', now: NOW });
    assert.equal(d4.allowed, false);
    assert.equal(d4.reason, 'per-file-cap');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRecoveryState on missing/garbage file returns fresh empty state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refetch-state-'));
  try {
    const missing = loadRecoveryState(path.join(dir, 'nope.json'), NOW);
    assert.equal(missing.globalCount, 0);
    assert.deepEqual(missing.files, {});
    const gp = path.join(dir, 'garbage.json');
    fs.writeFileSync(gp, 'not json{');
    const garbage = loadRecoveryState(gp, NOW);
    assert.equal(garbage.globalCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
