// Guards push-via-git-api.sh's apiFallbackMerge path for
// data/audit/guard-escalation-state.json (BRO-447). 3 independent writers
// (check-corpus-drift.js, check-rebuild-staleness.js,
// check-vercel-build-guard.js), each owning a distinct top-level guard-id
// key — the dangerous failure is a race silently dropping a DIFFERENT
// guard's key, not just this run's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeGuardEscalationState } = require('../../scripts/lib/merge-guard-escalation-state.js');

const state = (extra = {}) => ({ consecutiveBlocks: 1, firstBlockedAt: 1000, lastBlockedAt: 1000, lastClearedAt: null, ...extra });

test('acceptance: two racing guards each write a different key — both survive', () => {
  const ours = { 'corpus-drift-audit-crash': state() };
  const remote = { 'vercel-build-guard-restore-failed': state() };
  const { merged, stats } = mergeGuardEscalationState(ours, remote);
  assert.deepEqual(Object.keys(merged).sort(), ['corpus-drift-audit-crash', 'vercel-build-guard-restore-failed']);
  assert.equal(stats.remoteOnly, 1);
});

test('same key on both sides: the fresher state (max of lastBlockedAt/lastClearedAt) wins', () => {
  const ours = { x: state({ lastBlockedAt: 1000, consecutiveBlocks: 1 }) };
  const remote = { x: state({ lastBlockedAt: 2000, consecutiveBlocks: 2 }) };
  const { merged, stats } = mergeGuardEscalationState(ours, remote);
  assert.equal(merged.x.consecutiveBlocks, 2);
  assert.equal(stats.conflictsResolvedToRemote, 1);
});

test('same key, ours is fresher via lastClearedAt — ours wins, not remote', () => {
  const ours = { x: state({ lastBlockedAt: 1000, lastClearedAt: 5000, consecutiveBlocks: 0 }) };
  const remote = { x: state({ lastBlockedAt: 4000, lastClearedAt: null, consecutiveBlocks: 3 }) };
  const { merged } = mergeGuardEscalationState(ours, remote);
  assert.equal(merged.x.consecutiveBlocks, 0);
});

test('exact tie or missing timestamps on both sides keeps ours (deterministic tie-break)', () => {
  const ours = { x: state({ lastBlockedAt: null, lastClearedAt: null, consecutiveBlocks: 9 }) };
  const remote = { x: state({ lastBlockedAt: null, lastClearedAt: null, consecutiveBlocks: 1 }) };
  const { merged } = mergeGuardEscalationState(ours, remote);
  assert.equal(merged.x.consecutiveBlocks, 9);
});

test('tolerates a missing or malformed doc on either side', () => {
  assert.deepEqual(mergeGuardEscalationState(null, null).merged, {});
  assert.deepEqual(Object.keys(mergeGuardEscalationState({ a: state() }, null).merged), ['a']);
  assert.deepEqual(Object.keys(mergeGuardEscalationState(null, { a: state() }).merged), ['a']);
  assert.deepEqual(mergeGuardEscalationState([1, 2], null).merged, {});
});

test('a retired guard key deleted locally is NOT resurrected by remote\'s stale copy when base is supplied', () => {
  const base = { 'retired-guard': state() };
  const ours = {}; // guard script removed/retired, key deliberately dropped
  const remote = { 'retired-guard': state() }; // remote hasn't caught up yet
  const { merged, stats } = mergeGuardEscalationState(ours, remote, base);
  assert.deepEqual(merged, {}, 'the deleted key must stay deleted, not come back from remote');
  assert.equal(stats.deletesHonored, 1);
  assert.equal(stats.remoteOnly, 0);
});

test('without a base argument, remote-only keys are always restored (old, more conservative behavior)', () => {
  const ours = {};
  const remote = { x: state() };
  const { merged, stats } = mergeGuardEscalationState(ours, remote);
  assert.deepEqual(Object.keys(merged), ['x']);
  assert.equal(stats.remoteOnly, 1);
});

test('real-corpus sanity: merging the real 3-guard shape against a remote addition never loses existing keys', () => {
  const ours = {
    'corpus-drift-audit-crash': state(),
    'stale-checkout-staleness': state(),
  };
  const remote = { 'vercel-build-guard-restore-failed': state() };
  const { merged, stats } = mergeGuardEscalationState(ours, remote);
  assert.equal(Object.keys(merged).length, 3);
  assert.ok('vercel-build-guard-restore-failed' in merged);
  assert.equal(stats.remoteOnly, 1);
});
