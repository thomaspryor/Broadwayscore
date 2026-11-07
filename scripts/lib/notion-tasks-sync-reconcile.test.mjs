// Task #1790: reconcileStaleMirrors (scripts/notion-tasks-sync.js) used to
// select its per-pull candidate window with a stable `.slice(0, limit)` over
// Object.entries(map) — no offset, no rotation. Anything past index `limit`
// was permanently excluded from the sweep (measured live: 196/221
// candidates). The fix is selectLeastRecentlyReconciled: pick the `limit`
// candidates least recently checked, stamping lastReconciledAt on every
// candidate actually re-checked (see reconcileStaleMirrors's own comment for
// why the stamp has to happen for the unchanged case too, not just fixed).
//
// require()s the real function per CLAUDE.md's test extraction pattern —
// never copy logic into a test file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectLeastRecentlyReconciled } = require('../notion-tasks-sync.js');

test('selectLeastRecentlyReconciled: never returns more than `limit` candidates', () => {
  const candidates = Array.from({ length: 60 }, (_, i) => [`page-${i}`, {}]);
  for (const limit of [1, 25, 59, 60, 61]) {
    const picked = selectLeastRecentlyReconciled(candidates, limit);
    assert.ok(picked.length <= limit, `limit=${limit} returned ${picked.length}`);
  }
});

test('selectLeastRecentlyReconciled: never-checked entries (no lastReconciledAt) are picked before already-checked ones', () => {
  const candidates = [
    ['a', { lastReconciledAt: 100 }],
    ['b', {}],
    ['c', { lastReconciledAt: 50 }],
    ['d', { lastReconciledAt: 0 }],
  ];
  const picked = selectLeastRecentlyReconciled(candidates, 2).map(([id]) => id);
  assert.deepEqual(picked, ['b', 'd']);
});

test('selectLeastRecentlyReconciled: a pool smaller than `limit` returns every candidate', () => {
  const candidates = Array.from({ length: 10 }, (_, i) => [`page-${i}`, {}]);
  assert.equal(selectLeastRecentlyReconciled(candidates, 25).length, 10);
});

test('selectLeastRecentlyReconciled: limit <= 0 returns nothing and never throws', () => {
  const candidates = [['a', {}]];
  assert.deepEqual(selectLeastRecentlyReconciled(candidates, 0), []);
  assert.deepEqual(selectLeastRecentlyReconciled(candidates, -5), []);
  assert.deepEqual(selectLeastRecentlyReconciled([], 25), []);
});

// The actual task #1790 regression test: simulate reconcileStaleMirrors's own
// loop (pick window -> stamp every picked entry's lastReconciledAt, whether
// or not it drifted) across repeated calls on a static pool bigger than the
// limit, and assert every candidate eventually gets examined.
test('selectLeastRecentlyReconciled: over repeated rounds, the full candidate pool is eventually reconciled (static pool)', () => {
  const total = 221;
  const limit = 25;
  let candidates = Array.from({ length: total }, (_, i) => [`page-${i}`, {}]);
  const seen = new Set();
  const rounds = Math.ceil(total / limit) + 3; // generous margin over the theoretical minimum
  for (let round = 1; round <= rounds; round++) {
    const picked = selectLeastRecentlyReconciled(candidates, limit);
    assert.ok(picked.length <= limit, `round ${round}: picked ${picked.length} > limit ${limit}`);
    const pickedIds = new Set(picked.map(([id]) => id));
    picked.forEach(([id]) => seen.add(id));
    candidates = candidates.map(([id, e]) => (pickedIds.has(id) ? [id, { ...e, lastReconciledAt: round }] : [id, e]));
  }
  assert.equal(seen.size, total, `only ${seen.size}/${total} candidates were ever reconciled across ${rounds} rounds — the original task #1790 bug`);
});

// The old `.slice(0, limit)` behavior would fail this same assertion after a
// single round, since it always returns page-0..page-24 regardless of round.
test('selectLeastRecentlyReconciled: repeated rounds do NOT keep returning the same fixed window (regression guard for the old slice(0, limit) bug)', () => {
  const total = 100;
  const limit = 25;
  let candidates = Array.from({ length: total }, (_, i) => [`page-${i}`, {}]);
  const round1 = selectLeastRecentlyReconciled(candidates, limit).map(([id]) => id);
  candidates = candidates.map(([id, e]) => (round1.includes(id) ? [id, { ...e, lastReconciledAt: 1 }] : [id, e]));
  const round2 = selectLeastRecentlyReconciled(candidates, limit).map(([id]) => id);
  assert.equal(new Set([...round1, ...round2]).size, 50, 'round 2 should pick 25 candidates disjoint from round 1');
});

// Membership churn: candidates that "fix" and drop out of the pool between
// rounds (their status changed, so reconcileStaleMirrors's own
// Object.entries(map).filter(...) no longer includes them) must not desync
// coverage of what remains — the failure mode a persisted index/cursor has,
// since selectLeastRecentlyReconciled is identity-keyed instead.
test('selectLeastRecentlyReconciled: still converges when candidates drop out of the pool between rounds', () => {
  const total = 221;
  const limit = 25;
  let candidates = Array.from({ length: total }, (_, i) => [`page-${i}`, {}]);
  const seen = new Set();
  let round = 0;
  while (candidates.length > 0 && round < 60) {
    round++;
    const picked = selectLeastRecentlyReconciled(candidates, limit);
    assert.ok(picked.length <= limit, `round ${round}: picked ${picked.length} > limit ${limit}`);
    const pickedIds = picked.map(([id]) => id);
    pickedIds.forEach((id) => seen.add(id));
    // Every 3rd picked entry this round "fixes" and drops out of the pool —
    // mirrors reconcileStaleMirrors's fixed[] entries leaving the candidate
    // filter on the next call because their task status changed.
    const droppedThisRound = new Set(pickedIds.filter((_, i) => i % 3 === 0));
    candidates = candidates
      .filter(([id]) => !droppedThisRound.has(id))
      .map(([id, e]) => (pickedIds.includes(id) && !droppedThisRound.has(id) ? [id, { ...e, lastReconciledAt: round }] : [id, e]));
  }
  assert.equal(seen.size, total, `only ${seen.size}/${total} candidates were ever examined despite pool churn across ${round} rounds`);
});

// Ship-check adversarial review (2026-08-18): a poison-pill subset that
// PERSISTENTLY fails its Notion GET must not starve the rest of the pool.
// reconcileStaleMirrors now calls its stampReconciled() helper on the
// fetch-failure path too, not just success — from this pure function's
// perspective a "failed but examined" candidate and a "succeeded and
// examined" candidate are identical (both get lastReconciledAt stamped), so
// this test models 40 permanently-broken candidates (> the 25-item limit)
// mixed into the pool and asserts the healthy majority still converges.
test('selectLeastRecentlyReconciled: a persistently-failing subset (>= limit) does not starve the rest of the pool', () => {
  const total = 221;
  const limit = 25;
  const brokenIds = new Set(Array.from({ length: 40 }, (_, i) => `page-${i}`)); // first 40 always "fail"
  let candidates = Array.from({ length: total }, (_, i) => [`page-${i}`, {}]);
  const seen = new Set();
  const rounds = Math.ceil(total / limit) + 5;
  for (let round = 1; round <= rounds; round++) {
    const picked = selectLeastRecentlyReconciled(candidates, limit);
    assert.ok(picked.length <= limit, `round ${round}: picked ${picked.length} > limit ${limit}`);
    const pickedIds = new Set(picked.map(([id]) => id));
    picked.forEach(([id]) => seen.add(id)); // "examined" regardless of the simulated GET outcome
    candidates = candidates.map(([id, e]) => (pickedIds.has(id) ? [id, { ...e, lastReconciledAt: round }] : [id, e]));
  }
  const healthyTotal = total - brokenIds.size;
  const healthySeen = [...seen].filter((id) => !brokenIds.has(id)).length;
  assert.equal(healthySeen, healthyTotal, `only ${healthySeen}/${healthyTotal} healthy candidates were ever examined — the persistently-broken subset starved them`);
});
