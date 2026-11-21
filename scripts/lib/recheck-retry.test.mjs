// BRO-7559: a Done card's no-verdict recheck is retried on later nights, not final.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { causeOfRecheckRow, retryCandidateIds, stillDoneCards } = require('./recheck-retry.js');

const NOW = Date.parse('2026-11-15T12:00:00Z');
const row = (cardId, daysAgo, status, detail, extra = {}) => ({ event: 'recheck', cardId, ts: new Date(NOW - daysAgo * 864e5).toISOString(), status, detail, ...extra });

test('legacy prose rows are classified in one place', () => {
  assert.equal(causeOfRecheckRow(row('A', 1, 'unverifiable', 'acceptance command names a path absent from this checkout, not evidence the fix broke: x')), 'missing-path');
  assert.equal(causeOfRecheckRow(row('A', 1, 'unverifiable', 'check killed by SIGTERM after 144951ms (timeout — no verdict)')), 'timeout');
  assert.equal(causeOfRecheckRow(row('A', 1, 'unverifiable', 'check exited 3 (cannot verify — evidence unavailable): [x] CANNOT TELL: "k" — open but quiet')), 'exit3');
  assert.equal(causeOfRecheckRow(row('A', 1, 'unverifiable', 'check exited 3 (cannot verify — evidence unavailable): [x] CANNOT TELL: "k" is in no alert ledger (/p)')), 'exit3-no-ledger');
  assert.equal(causeOfRecheckRow(row('A', 1, 'unverifiable', 'check exited 3', { cause: 'whole-suite' })), 'whole-suite');
  assert.equal(causeOfRecheckRow(row('A', 1, 'pass', null)), null);
});

test('the real 2026-11 shape: one no-verdict row, out of window, is re-selected', () => {
  const ids = retryCandidateIds([row('BRO-3344', 24, 'unverifiable', 'acceptance command names a path absent from this checkout, not evidence the fix broke: t')], { now: NOW });
  assert.deepEqual(ids, ['BRO-3344']);
});

test('a later pass or fail ends the retry', () => {
  const e = [row('A', 10, 'unverifiable', 'check exited 3 (x): open but quiet'), row('A', 2, 'pass', null), row('B', 10, 'unverifiable', 'check exited 3 (x)'), row('B', 2, 'fail', 'boom')];
  assert.deepEqual(retryCandidateIds(e, { now: NOW }), []);
});

test('timeouts retry only in the backlog sweep; Mac-only alert keys and whole-suite never', () => {
  const e = [
    row('T', 5, 'unverifiable', 'check killed by SIGTERM after 1000ms (timeout — no verdict)'),
    row('M', 5, 'unverifiable', 'check exited 3 (x): CANNOT TELL: "cmux" is in no alert ledger (/p)'),
    row('W', 5, 'unverifiable', 'x', { cause: 'whole-suite' }),
  ];
  assert.deepEqual(retryCandidateIds(e, { now: NOW }), []);
  assert.deepEqual(retryCandidateIds(e, { now: NOW, backlog: true }), ['T']);
});

test('bounded: attempts, age, same-day, exclude, limit; oldest first', () => {
  const miss = 'acceptance command names a path absent from this checkout, not evidence the fix broke: t';
  const e = [
    ...[9, 8, 7, 6].map((d) => row('MANY', d, 'unverifiable', miss)),
    row('OLD', 60, 'unverifiable', miss),
    row('TODAY', 0.2, 'unverifiable', miss),
    row('EX', 5, 'unverifiable', miss),
    row('A', 3, 'unverifiable', miss),
    row('B', 4, 'unverifiable', miss),
  ];
  assert.deepEqual(retryCandidateIds(e, { now: NOW, exclude: new Set(['EX']) }), ['B', 'A']);
  assert.deepEqual(retryCandidateIds(e, { now: NOW, exclude: new Set(['EX']), limit: 1 }), ['B']);
});

test('a retry re-checks only cards still Done; a reopened card is being worked', () => {
  const cards = [{ id: 'BRO-1', status: 'Done' }, { id: 'BRO-2', status: 'In Progress' }, { id: 'BRO-3', status: 'Todo' }, null];
  assert.deepEqual(stillDoneCards(cards).map((c) => c.id), ['BRO-1']);
  assert.deepEqual(stillDoneCards(undefined), []);
});

test('the legacy exit-3 match does not swallow other exit codes', () => {
  assert.equal(causeOfRecheckRow({ status: 'unverifiable', detail: 'check exited 3 (alert still firing)' }), 'exit3');
  assert.equal(causeOfRecheckRow({ status: 'unverifiable', detail: 'check exited 30' }), null);
});

test('cards a budget-capped run never reached are retried (BRO-7559 deferred)', () => {
  const deferredRow = { event: 'recheck-deferred', ts: new Date(NOW - 2 * 864e5).toISOString(), cardIds: ['D1', 'D2'], note: 'x' };
  const ids = retryCandidateIds([deferredRow, row('D2', 1.5, 'pass', 'ok')], { now: NOW });
  assert.deepEqual(ids, ['D1']);
  // A legacy deferred row with no cardIds names nothing.
  assert.deepEqual(retryCandidateIds([{ event: 'recheck-deferred', ts: deferredRow.ts, note: 'x' }], { now: NOW }), []);
});
