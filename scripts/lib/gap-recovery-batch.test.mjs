// BRO-7944: chained batch runner decisions. Run: node --test scripts/lib/gap-recovery-batch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const B = require('./gap-recovery-batch.js');

test('checkpointCadence: defaults, env override, and the 10 accepts / 10 minutes ceiling', () => {
  assert.deepEqual(B.checkpointCadence({}), { everyAccepts: 5, maxMs: 120000 });
  assert.deepEqual(B.checkpointCadence({ GAP_CHECKPOINT_EVERY: '3', GAP_CHECKPOINT_MAX_MIN: '1' }), { everyAccepts: 3, maxMs: 60000 });
  assert.deepEqual(B.checkpointCadence({ GAP_CHECKPOINT_EVERY: '500', GAP_CHECKPOINT_MAX_MIN: '99' }), { everyAccepts: 10, maxMs: 600000 });
  assert.deepEqual(B.checkpointCadence({ GAP_CHECKPOINT_EVERY: 'x', GAP_CHECKPOINT_MAX_MIN: '-4' }), { everyAccepts: 5, maxMs: 120000 });
});

test('orphanAccepts: uncommitted text of the accepted length is adopted; landed skipped; missing/clean reported gone', () => {
  const pending = new Map([
    ['s/a.json', { bytesAfter: 5 }], ['s/b.json', { bytesAfter: 5 }], ['s/c.json', { bytesAfter: 5 }],
    ['s/d.json', { bytesAfter: 5 }], ['s/e.json', { bytesAfter: 5 }],
  ]);
  const files = { 's/a.json': 'hello', 's/b.json': 'hello', 's/c.json': 'hellooo', 's/e.json': 'hello' };
  const dirty = { 's/a.json': true, 's/b.json': true, 's/c.json': true, 's/e.json': false };
  const r = B.orphanAccepts(pending, { readText: (k) => (k in files ? files[k] : null), isDirty: (k) => !!dirty[k], landed: new Set(['s/b.json']) });
  assert.deepEqual(r.adopt, ['s/a.json']);
  assert.deepEqual(r.gone, ['s/c.json', 's/d.json', 's/e.json']); // c = dirty but length differs
});

test('stopDecision: two failed pushes, either spend cap, rounds done, an idle round', () => {
  const base = { failedPushes: 0, spend: { bd: 0, serp: 0 }, cap: { bd: 25, serp: 60 }, roundsDone: 1, rounds: 3, lastRoundWork: 4 };
  assert.equal(B.stopDecision(base).stop, false);
  assert.match(B.stopDecision({ ...base, failedPushes: 1 }).why || 'go', /go/);
  assert.match(B.stopDecision({ ...base, failedPushes: 2 }).why, /failed pushes/);
  assert.match(B.stopDecision({ ...base, spend: { bd: 25, serp: 0 } }).why, /Bright Data/);
  assert.match(B.stopDecision({ ...base, spend: { bd: 0, serp: 61 } }).why, /SERP/);
  assert.match(B.stopDecision({ ...base, roundsDone: 3 }).why, /rounds complete/);
  assert.match(B.stopDecision({ ...base, lastRoundWork: 0 }).why, /nothing eligible/);
  assert.equal(B.stopDecision({ ...base, cap: { bd: null, serp: null }, spend: { bd: 999, serp: 999 } }).stop, false);
});

test('remainingBudget + buildRoundRow', () => {
  assert.deepEqual(B.remainingBudget({ bd: 25, serp: null }, { bd: 10, serp: 5 }), { bd: 15, serp: null });
  assert.deepEqual(B.remainingBudget({ bd: 5, serp: 5 }, { bd: 10, serp: 5 }), { bd: 0, serp: 0 });
  const row = B.buildRoundRow({ batchId: 'b', round: 2, startedAt: 's', endedAt: 'e', exit: 0, summary: { attempted: 3, accepted: 1, landed: 1, byStrategy: { ARCHIVE: { attempted: 3, accepted: 1, outcomes: { x: 1 } } }, pushRetryFailed: true } });
  assert.equal(row.pushFailed, true);
  assert.deepEqual(row.byStrategy, { ARCHIVE: { attempted: 3, accepted: 1 } });
});

test('orphanAccepts: an equal-length dirty file with a different hash is NOT adopted (not our accepted text)', () => {
  const pending = new Map([['s/a.json', { bytesAfter: 5, acceptedHash: 'h-hello' }], ['s/b.json', { bytesAfter: 5, acceptedHash: 'h-world' }]]);
  const files = { 's/a.json': 'hello', 's/b.json': 'hello' };
  const r = B.orphanAccepts(pending, { readText: (k) => files[k], isDirty: () => true, hashText: (t) => `h-${t}` });
  assert.deepEqual(r.adopt, ['s/a.json']);
  assert.deepEqual(r.gone, ['s/b.json']);
});

test('BRO-7962: a round that is allowed to run never gets a 0 budget (0 means "no cap" to the driver)', () => {
  for (const cb of [null, 0, 1, 25]) for (const cs of [null, 0, 1, 60]) for (const ub of [0, 1, 24, 25, 30]) for (const us of [0, 1, 59, 60, 70]) {
    const cap = { bd: cb, serp: cs }; const spend = { bd: ub, serp: us };
    const d = B.stopDecision({ failedPushes: 0, spend, cap, roundsDone: 0, rounds: 3, lastRoundWork: 1 });
    if (d.stop) continue;
    const rem = B.remainingBudget(cap, spend);
    assert.ok(rem.bd !== 0 && rem.serp !== 0, JSON.stringify({ cap, spend, rem }));
  }
});
