// Guards the push-with-retry.sh conflict-resolution path for
// data/audit/feedback-request-ledger.json (task #1440). This file now has
// two independent writers (process-feedback.yml + generate-remediation-
// plan.js via auto-fix-feedback-bug.yml) — the dangerous failure is a
// conflict silently dropping the OTHER writer's newly-added or newly-
// flipped-to-live entries, recreating the exact silent-loss bug this
// ledger exists to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeFeedbackLedger } = require('../../scripts/lib/merge-feedback-ledger.js');

const entry = (key, extra = {}) => ({ key, status: 'open', ...extra });

test('acceptance: two racing writers each add a different new entry — both survive', () => {
  const ours = { entries: [entry('base1'), entry('A')] };
  const remote = { entries: [entry('base1'), entry('B')] };
  const { merged, stats } = mergeFeedbackLedger(ours, remote);
  const keys = merged.entries.map((e) => e.key).sort();
  assert.deepEqual(keys, ['A', 'B', 'base1']);
  assert.equal(stats.remoteOnly, 1);
});

test('remote-only entries are re-added (the drop this fixes)', () => {
  const ours = { entries: [entry('x')] };
  const remote = { entries: [entry('x'), entry('y'), entry('z')] };
  const { merged, stats } = mergeFeedbackLedger(ours, remote);
  assert.deepEqual(merged.entries.map((e) => e.key), ['x', 'y', 'z']);
  assert.equal(stats.remoteOnly, 2);
});

test('local wins on a shared key — a fresher status flip from THIS run survives', () => {
  const ours = { entries: [entry('x', { status: 'live', satisfiedAt: '2026-08-14T00:00:00Z' })] };
  const remote = { entries: [entry('x', { status: 'open' })] };
  const { merged } = mergeFeedbackLedger(ours, remote);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].status, 'live');
});

test('order is deterministic: local first, remote-only appended', () => {
  const ours = { entries: [entry('a'), entry('b')] };
  const remote = { entries: [entry('c'), entry('b'), entry('d')] };
  const { merged } = mergeFeedbackLedger(ours, remote);
  assert.deepEqual(merged.entries.map((e) => e.key), ['a', 'b', 'c', 'd']);
});

test('a content-fix entry newly tracked by generate-remediation-plan.js on the remote side is never dropped', () => {
  const ours = { entries: [entry('missing-show:x:sub-1')] };
  const remote = {
    entries: [
      entry('missing-show:x:sub-1'),
      entry('content-fix:wrong-award-co-winner:issue-559', { kind: 'content-fix', contentErrorType: 'wrong-award-co-winner' }),
    ],
  };
  const { merged, stats } = mergeFeedbackLedger(ours, remote);
  assert.equal(stats.remoteOnly, 1);
  assert.ok(merged.entries.some((e) => e.key === 'content-fix:wrong-award-co-winner:issue-559'));
});

test('keyless entries never drop — appended verbatim from local, remote keyless entries are just skipped (no way to dedupe them)', () => {
  const ours = { entries: [{ status: 'open' }] };
  const remote = { entries: [{ status: 'open' }, entry('real-key')] };
  const { merged } = mergeFeedbackLedger(ours, remote);
  assert.equal(merged.entries.length, 2);
  assert.ok(merged.entries.some((e) => e.key === 'real-key'));
});

test('tolerates a missing or malformed ledger on either side', () => {
  assert.deepEqual(mergeFeedbackLedger(null, null).merged, { entries: [] });
  assert.deepEqual(mergeFeedbackLedger({ entries: 'nope' }, { entries: [entry('a')] }).merged.entries.map((e) => e.key), ['a']);
  assert.deepEqual(mergeFeedbackLedger({ entries: [entry('a')] }, null).merged.entries.map((e) => e.key), ['a']);
});
