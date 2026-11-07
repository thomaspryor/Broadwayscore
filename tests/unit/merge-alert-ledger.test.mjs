// Guards push-via-git-api.sh's apiFallbackMerge path for
// data/audit/alert-ledger.json (BRO-2413). 12 independent writers via
// routeAlert() — the dangerous failure is a race silently dropping a
// DIFFERENT writer's open condition (or its freshest lastSeen), not just
// the "duplicate email" loss class this file's loss is already accepted for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeAlertLedger } = require('../../scripts/lib/merge-alert-ledger.js');

const cond = (extra = {}) => ({ status: 'open', lastSeen: '2026-09-01T00:00:00.000Z', notifyCount: 1, ...extra });

test('acceptance: two racing writers each add a different new condition — both survive', () => {
  const ours = { conditions: { base: cond(), a: cond() } };
  const remote = { conditions: { base: cond(), b: cond() } };
  const { merged, stats } = mergeAlertLedger(ours, remote);
  assert.deepEqual(Object.keys(merged.conditions).sort(), ['a', 'b', 'base']);
  assert.equal(stats.remoteOnly, 1);
});

test('same conditionKey on both sides: the fresher lastSeen wins', () => {
  const ours = { conditions: { x: cond({ lastSeen: '2026-09-01T00:00:00.000Z', notifyCount: 1 }) } };
  const remote = { conditions: { x: cond({ lastSeen: '2026-09-02T00:00:00.000Z', notifyCount: 2 }) } };
  const { merged, stats } = mergeAlertLedger(ours, remote);
  assert.equal(merged.conditions.x.notifyCount, 2);
  assert.equal(stats.conflictsResolvedToRemote, 1);
});

test('same conditionKey, ours is fresher — ours wins, not remote', () => {
  const ours = { conditions: { x: cond({ lastSeen: '2026-09-05T00:00:00.000Z', notifyCount: 5 }) } };
  const remote = { conditions: { x: cond({ lastSeen: '2026-09-01T00:00:00.000Z', notifyCount: 1 }) } };
  const { merged } = mergeAlertLedger(ours, remote);
  assert.equal(merged.conditions.x.notifyCount, 5);
});

test('exact tie or unparsable lastSeen keeps ours (deterministic tie-break)', () => {
  const ours = { conditions: { x: cond({ lastSeen: 'not-a-date', notifyCount: 9 }) } };
  const remote = { conditions: { x: cond({ lastSeen: 'also-not-a-date', notifyCount: 1 }) } };
  const { merged } = mergeAlertLedger(ours, remote);
  assert.equal(merged.conditions.x.notifyCount, 9);
});

test('BRO-2413 round-2 (Codex adversarial ship-check P0): a hard-deleted condition (deleteCondition()) is NOT resurrected by remote\'s stale copy when base is supplied', () => {
  const base = { conditions: { canary: cond() } };
  const ours = { conditions: {} }; // we deleteCondition()'d it (e.g. E2E canary reset)
  const remote = { conditions: { canary: cond() } }; // remote hasn't caught up yet
  const { merged, stats } = mergeAlertLedger(ours, remote, base);
  assert.deepEqual(merged.conditions, {}, 'the deleted condition must stay deleted, not come back from remote');
  assert.equal(stats.deletesHonored, 1);
  assert.equal(stats.remoteOnly, 0);
});

test('without a base argument, the OLD (more conservative) two-way behavior is preserved: remote-only conditions are always restored', () => {
  const ours = { conditions: {} };
  const remote = { conditions: { x: cond() } };
  const { merged, stats } = mergeAlertLedger(ours, remote);
  assert.deepEqual(Object.keys(merged.conditions), ['x']);
  assert.equal(stats.remoteOnly, 1);
});

test('tolerates a missing or malformed ledger on either side', () => {
  assert.deepEqual(mergeAlertLedger(null, null).merged.conditions, {});
  assert.deepEqual(Object.keys(mergeAlertLedger({ conditions: { a: cond() } }, null).merged.conditions), ['a']);
  assert.deepEqual(Object.keys(mergeAlertLedger(null, { conditions: { a: cond() } }).merged.conditions), ['a']);
});

test('real-corpus sanity: merging a large real ledger against a small remote addition never loses existing keys', () => {
  // Simulates the actual production shape (187+ conditions) without reading
  // the real file (keeps this test hermetic) — a large local object plus one
  // remote-only addition.
  const localConditions = {};
  for (let i = 0; i < 200; i++) localConditions[`k${i}`] = cond();
  const ours = { conditions: localConditions };
  const remote = { conditions: { 'new-from-other-writer': cond() } };
  const { merged, stats } = mergeAlertLedger(ours, remote);
  assert.equal(Object.keys(merged.conditions).length, 201);
  assert.ok('new-from-other-writer' in merged.conditions);
  assert.equal(stats.remoteOnly, 1);
});
