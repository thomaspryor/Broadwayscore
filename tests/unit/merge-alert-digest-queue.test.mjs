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
