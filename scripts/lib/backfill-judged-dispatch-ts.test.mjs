/**
 * Pins the correlation rule of the BRO-3321 one-time backfill.
 *
 * The rule has to match what reconciliation itself would have written, because
 * the whole point is to fill in rows the reconciler produced before it carried
 * the field. Getting it wrong would silently re-date real outcomes — the same
 * class of bug the backfill exists to repair, pointed the other way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { backfillRows } = require('../backfill-judged-dispatch-ts.js');

const D = (ts, taskId, contentHash) => ({ event: 'auto-dispatch', taskId, contentHash, ts });
const F = (ts, cardId, contentHash, extra = {}) => ({ event: 'card-fail', cardId, contentHash, ts, ...extra });

test('stamps an outcome with the ts of the dispatch it judges', () => {
  const rows = [
    D('2026-08-14T11:30:46Z', 'BRO-303', 'h1'),
    F('2026-09-14T11:37:13Z', 'BRO-303', 'h1'),
  ];
  const { out, stamped } = backfillRows(rows, 'auto-dispatch');
  assert.equal(stamped, 1);
  assert.equal(out[1].judgedDispatchTs, '2026-08-14T11:30:46Z');
  assert.equal(out[1].ts, '2026-09-14T11:37:13Z', 'the write time must be preserved, not overwritten');
});

test('matches on contentHash as well as id — a re-dispatch of DIFFERENT content is a different dispatch', () => {
  const rows = [
    D('2026-08-01T00:00:00Z', 'c', 'old-content'),
    D('2026-09-01T00:00:00Z', 'c', 'new-content'),
    F('2026-09-14T00:00:00Z', 'c', 'new-content'),
  ];
  const { out } = backfillRows(rows, 'auto-dispatch');
  assert.equal(out[2].judgedDispatchTs, '2026-09-01T00:00:00Z', 'must not attach to the older, unrelated dispatch');
});

test('picks the LATEST matching dispatch at or before the outcome', () => {
  // Same card, same content, dispatched twice — attempt-memory's repeated-
  // failure case. The outcome resolves the most recent one.
  const rows = [
    D('2026-09-01T00:00:00Z', 'c', 'h'),
    D('2026-09-10T00:00:00Z', 'c', 'h'),
    F('2026-09-14T00:00:00Z', 'c', 'h'),
  ];
  const { out } = backfillRows(rows, 'auto-dispatch');
  assert.equal(out[2].judgedDispatchTs, '2026-09-10T00:00:00Z');
});

test('leaves an outcome with no matching dispatch completely alone', () => {
  // Guessing would be worse than the existing `ts` fallback, which is at least
  // honest about being a write time.
  const rows = [F('2026-09-14T00:00:00Z', 'orphan', 'h')];
  const { out, stamped, unmatched } = backfillRows(rows, 'auto-dispatch');
  assert.equal(stamped, 0);
  assert.equal(unmatched, 1);
  assert.deepEqual(out[0], rows[0], 'row must be byte-identical when unmatched');
});

test('never rewrites a row that is already stamped (idempotent)', () => {
  const rows = [
    D('2026-08-14T11:30:46Z', 'c', 'h'),
    F('2026-09-14T11:37:13Z', 'c', 'h', { judgedDispatchTs: '2026-01-01T00:00:00Z' }),
  ];
  const { out, stamped, alreadyStamped } = backfillRows(rows, 'auto-dispatch');
  assert.equal(stamped, 0);
  assert.equal(alreadyStamped, 1);
  assert.equal(out[1].judgedDispatchTs, '2026-01-01T00:00:00Z', 'an existing value is authoritative');
});

test('does not stamp a dispatch that appears AFTER the outcome', () => {
  // Ledgers are append-only and chronological, but a corrupted or merged file
  // could be out of order. A later dispatch cannot be what an earlier outcome
  // judged, so the outcome must stay unmatched rather than borrow its ts.
  const rows = [
    F('2026-09-01T00:00:00Z', 'c', 'h'),
    D('2026-09-10T00:00:00Z', 'c', 'h'),
  ];
  const { out, stamped } = backfillRows(rows, 'auto-dispatch');
  assert.equal(stamped, 0);
  assert.equal(out[0].judgedDispatchTs, undefined);
});

test('honours the ledger\'s own dispatch-event name', () => {
  // backlog-drain and linear-drain-parked use 'drain-dispatch', not
  // 'auto-dispatch'. Passing the wrong one must match nothing rather than
  // silently treat outcome rows as dispatches.
  const rows = [
    { event: 'drain-dispatch', taskId: 'c', contentHash: 'h', ts: '2026-09-01T00:00:00Z' },
    F('2026-09-14T00:00:00Z', 'c', 'h'),
  ];
  assert.equal(backfillRows(rows, 'drain-dispatch').stamped, 1);
  assert.equal(backfillRows(rows, 'auto-dispatch').stamped, 0);
});

test('passes non-outcome, non-dispatch rows through untouched', () => {
  const rows = [{ event: 'recovery', note: 'fail: something', ts: '2026-09-14T00:00:00Z' }, null, 'junk'];
  const { out } = backfillRows(rows, 'auto-dispatch');
  assert.deepEqual(out[0], rows[0]);
  assert.equal(out[1], null);
  assert.equal(out[2], 'junk');
});

test('stamps card-pass and card-stranded, not just card-fail', () => {
  const rows = [
    D('2026-09-01T00:00:00Z', 'a', 'h'),
    { event: 'card-pass', cardId: 'a', contentHash: 'h', ts: '2026-09-14T00:00:00Z' },
    D('2026-09-02T00:00:00Z', 'b', 'h2'),
    { event: 'card-stranded', cardId: 'b', contentHash: 'h2', ts: '2026-09-14T00:00:00Z' },
  ];
  const { out, stamped } = backfillRows(rows, 'auto-dispatch');
  assert.equal(stamped, 2);
  assert.equal(out[1].judgedDispatchTs, '2026-09-01T00:00:00Z');
  assert.equal(out[3].judgedDispatchTs, '2026-09-02T00:00:00Z');
});
