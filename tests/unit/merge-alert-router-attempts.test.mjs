// Guards push-via-git-api.sh's apiFallbackMerge path for
// data/audit/alert-router-attempts.jsonl (BRO-2413). 3 independent writers —
// pure append-only log, the dangerous failure is a race silently dropping a
// DIFFERENT writer's logged attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeAlertRouterAttempts } = require('../../scripts/lib/merge-alert-router-attempts.js');

const line = (ts, conditionKey, extra = {}) => ({ ts, conditionKey, title: conditionKey, ok: true, error: null, ...extra });

test('acceptance: two racing writers each append a different line — both survive', () => {
  const ours = [line('2026-09-01T00:00:00.000Z', 'a')];
  const remote = [line('2026-09-01T00:00:01.000Z', 'b')];
  const { merged, stats } = mergeAlertRouterAttempts(ours, remote);
  assert.deepEqual(merged.map((e) => e.conditionKey), ['a', 'b']);
  assert.equal(stats.remoteOnly, 1);
});

test('identical (ts, conditionKey) on both sides is deduped, not doubled', () => {
  const ours = [line('2026-09-01T00:00:00.000Z', 'x')];
  const remote = [line('2026-09-01T00:00:00.000Z', 'x')];
  const { merged, stats } = mergeAlertRouterAttempts(ours, remote);
  assert.equal(merged.length, 1);
  assert.equal(stats.remoteOnly, 0);
});

test('same conditionKey, different ts on each side are BOTH kept (real distinct events, not a conflict)', () => {
  const ours = [line('2026-09-01T00:00:00.000Z', 'x')];
  const remote = [line('2026-09-01T00:05:00.000Z', 'x')];
  const { merged } = mergeAlertRouterAttempts(ours, remote);
  assert.equal(merged.length, 2);
});

test('order is deterministic: local first, remote-only appended in remote order', () => {
  const ours = [line('t1', 'a'), line('t2', 'b')];
  const remote = [line('t3', 'c'), line('t2', 'b'), line('t4', 'd')];
  const { merged } = mergeAlertRouterAttempts(ours, remote);
  assert.deepEqual(merged.map((e) => e.conditionKey), ['a', 'b', 'c', 'd']);
});

test('BRO-2413 round-2 (Codex adversarial ship-check P1): a pruned (30-day retention) line is NOT resurrected by remote\'s stale unpruned copy when base is supplied', () => {
  const base = [line('2026-01-01T00:00:00.000Z', 'ancient')];
  const ours = []; // we pruned it
  const remote = [line('2026-01-01T00:00:00.000Z', 'ancient')]; // remote hasn't caught up yet
  const { merged, stats } = mergeAlertRouterAttempts(ours, remote, base);
  assert.deepEqual(merged, [], 'the pruned line must stay pruned, not come back from remote');
  assert.equal(stats.deletesHonored, 1);
  assert.equal(stats.remoteOnly, 0);
});

test('without a base argument, the OLD (more conservative) two-way behavior is preserved: remote-only lines are always restored', () => {
  const ours = [];
  const remote = [line('t', 'x')];
  const { merged, stats } = mergeAlertRouterAttempts(ours, remote);
  assert.deepEqual(merged.map((e) => e.conditionKey), ['x']);
  assert.equal(stats.remoteOnly, 1);
});

test('tolerates a missing or malformed log on either side', () => {
  assert.deepEqual(mergeAlertRouterAttempts(null, null).merged, []);
  assert.deepEqual(mergeAlertRouterAttempts([line('t', 'a')], null).merged.map((e) => e.conditionKey), ['a']);
  assert.deepEqual(mergeAlertRouterAttempts(null, [line('t', 'a')]).merged.map((e) => e.conditionKey), ['a']);
});
