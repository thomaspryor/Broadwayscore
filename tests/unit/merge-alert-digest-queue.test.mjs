// Guards push-via-git-api.sh's apiFallbackMerge path for
// data/audit/alert-digest-queue.json (BRO-2413). 8 independent writers via
// queueDigestLine() — the dangerous failure is a race silently dropping a
// DIFFERENT writer's queued digest row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeAlertDigestQueue } = require('../../scripts/lib/merge-alert-digest-queue.js');

const row = (conditionKey, extra = {}) => ({
  conditionKey, title: conditionKey, description: 'd', severity: 'warning',
  url: null, decision: false, decisionPrompt: null, model: null, fields: [],
  queuedAt: '2026-09-01T00:00:00.000Z', ...extra,
});

test('acceptance: two racing writers each queue a different row — both survive', () => {
  const ours = [row('a')];
  const remote = [row('b')];
  const { merged, stats } = mergeAlertDigestQueue(ours, remote);
  assert.deepEqual(merged.map((e) => e.conditionKey).sort(), ['a', 'b']);
  assert.equal(stats.remoteOnly, 1);
});

test('same conditionKey on both sides: the fresher queuedAt wins', () => {
  const ours = [row('x', { queuedAt: '2026-09-01T00:00:00.000Z', title: 'old' })];
  const remote = [row('x', { queuedAt: '2026-09-02T00:00:00.000Z', title: 'new' })];
  const { merged, stats } = mergeAlertDigestQueue(ours, remote);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, 'new');
  assert.equal(stats.conflictsResolvedToRemote, 1);
});

test('same conditionKey, ours is fresher — ours wins', () => {
  const ours = [row('x', { queuedAt: '2026-09-05T00:00:00.000Z', title: 'ours' })];
  const remote = [row('x', { queuedAt: '2026-09-01T00:00:00.000Z', title: 'remote' })];
  const { merged } = mergeAlertDigestQueue(ours, remote);
  assert.equal(merged[0].title, 'ours');
});

test('tolerates a missing or malformed queue on either side', () => {
  assert.deepEqual(mergeAlertDigestQueue(null, null).merged, []);
  assert.deepEqual(mergeAlertDigestQueue([row('a')], null).merged.map((e) => e.conditionKey), ['a']);
  assert.deepEqual(mergeAlertDigestQueue(null, [row('a')]).merged.map((e) => e.conditionKey), ['a']);
});

test('BRO-2413 round-2 (Codex adversarial ship-check P0): a drained row (clearDigestQueue/removeDigestLines) is NOT resurrected by remote\'s stale copy when base is supplied', () => {
  const base = [row('x')];
  const ours = []; // we drained it
  const remote = [row('x')]; // remote hasn't caught up yet
  const { merged, stats } = mergeAlertDigestQueue(ours, remote, base);
  assert.deepEqual(merged, [], 'the drained row must stay drained, not come back from remote');
  assert.equal(stats.deletesHonored, 1);
  assert.equal(stats.remoteOnly, 0);
});

test('without a base argument, the OLD (more conservative) two-way behavior is preserved: remote-only rows are always restored', () => {
  const ours = [];
  const remote = [row('x')];
  const { merged, stats } = mergeAlertDigestQueue(ours, remote);
  assert.deepEqual(merged.map((e) => e.conditionKey), ['x']);
  assert.equal(stats.remoteOnly, 1);
});

test('a GENUINE remote-only addition (never in base) still survives even when base is supplied', () => {
  const base = [row('untouched')];
  const ours = [row('untouched')];
  const remote = [row('untouched'), row('brand-new-from-other-writer')];
  const { merged, stats } = mergeAlertDigestQueue(ours, remote, base);
  assert.ok(merged.some((e) => e.conditionKey === 'brand-new-from-other-writer'));
  assert.equal(stats.remoteOnly, 1);
  assert.equal(stats.deletesHonored, 0);
});

test('keyless remote entries are skipped (no dedupe key), keyless local entries are kept', () => {
  const ours = [{ title: 'no key' }];
  const remote = [{ title: 'no key either' }, row('real')];
  const { merged } = mergeAlertDigestQueue(ours, remote);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((e) => e.conditionKey === 'real'));
});

// ── BRO-2955 ship-check: the CALLERS must pass a base, not just the merger ──
// merge-alert-digest-queue.js has honoured a three-way base since BRO-2413,
// but both call sites invoked it with two arguments — reconcile-merged-json.js
// (which push-with-retry.sh now calls unconditionally for this file) and
// merge-commercial-conflict.js (the resolve_conflicts case arm). Two-way turns
// health-check.js's post-send drain into a no-op: the remote still holds the
// pre-drain rows, the union puts them back, and the owner re-receives a digest
// they already got. Both callers now dispatch on merge.length >= 3. This test
// pins the property at the merger so a caller reverting to two args is at
// least visibly choosing the weaker behaviour.
test('BRO-2955: a drained queue stays drained when the base is supplied, and is resurrected without it', () => {
  const row = { conditionKey: 'k1', title: 'already delivered', queuedAt: '2026-09-01T00:00:00.000Z' };
  const drainedLocal = [];
  const staleRemote = [row];

  const twoWay = mergeAlertDigestQueue(drainedLocal, staleRemote);
  assert.equal(twoWay.merged.length, 1,
    'two-way genuinely cannot tell a drain from a remote-only addition — this is WHY the callers must pass a base');

  const threeWay = mergeAlertDigestQueue(drainedLocal, staleRemote, [row]);
  assert.deepEqual(threeWay.merged, [],
    'with the base, the deletion wins: an already-delivered digest row must not come back');
});

test('BRO-2955: a GENUINE remote addition still survives the three-way path', () => {
  // The base must not become a licence to drop rows the other side really added.
  const old = { conditionKey: 'k1', queuedAt: '2026-09-01T00:00:00.000Z' };
  const fresh = { conditionKey: 'k2', queuedAt: '2026-09-02T00:00:00.000Z' };
  const merged = mergeAlertDigestQueue([old], [old, fresh], [old]).merged;
  assert.deepEqual(merged.map((e) => e.conditionKey).sort(), ['k1', 'k2']);
});
