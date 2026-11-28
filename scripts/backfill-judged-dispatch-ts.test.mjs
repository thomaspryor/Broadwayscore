import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { backfillRows } = require('./backfill-judged-dispatch-ts.js');

function dispatch(ts, cardId, contentHash) {
  return { ts, event: 'auto-dispatch', taskId: cardId, contentHash };
}
function outcome(ts, cardId, contentHash, extra = {}) {
  return { ts, event: 'card-fail', cardId, contentHash, ...extra };
}

test('backfillRows stamps an outcome with the latest dispatch at or before it, in true chronological order', () => {
  const rows = [
    dispatch('2026-08-14T01:00:00Z', 'c1', 'h1'),
    dispatch('2026-08-14T02:00:00Z', 'c1', 'h1'), // later dispatch, same key
    outcome('2026-08-14T03:00:00Z', 'c1', 'h1'),
  ];
  const { out, stamped, unmatched } = backfillRows(rows, 'auto-dispatch');
  assert.equal(stamped, 1);
  assert.equal(unmatched, 0);
  assert.equal(out[2].judgedDispatchTs, '2026-08-14T02:00:00Z');
});

// BRO-3868: digest-autofix-ledger.jsonl is now merge=union — a sync's union
// recovery can leave rows in non-chronological array order. The old
// implementation walked rows by ARRAY POSITION and treated "last seen" as
// "latest", which a scrambled order corrupts. This is the literal regression
// guard for that fix.
test('backfillRows is invariant to row order — a shuffled/union-scrambled array produces the same judgedDispatchTs as the true chronological one', () => {
  const chronological = [
    dispatch('2026-08-14T01:00:00Z', 'c1', 'h1'),
    dispatch('2026-08-14T02:00:00Z', 'c1', 'h1'),
    outcome('2026-08-14T03:00:00Z', 'c1', 'h1'),
    dispatch('2026-08-15T01:00:00Z', 'c2', 'h2'),
    outcome('2026-08-15T02:00:00Z', 'c2', 'h2'),
  ];
  const expected = backfillRows(chronological, 'auto-dispatch');
  assert.equal(expected.stamped, 2);

  // A union merge appends locally-saved rows after origin's, in whatever
  // order each side had them — not a single hand-picked shuffle.
  const shuffled = [chronological[3], chronological[0], chronological[4], chronological[2], chronological[1]];
  const actual = backfillRows(shuffled, 'auto-dispatch');
  assert.equal(actual.stamped, 2);
  assert.equal(actual.unmatched, 0);
  // Match each row back to its judgedDispatchTs by identity, since backfillRows
  // preserves each row's own position in ITS OWN input array (shuffled here).
  const idx = shuffled.indexOf(chronological[2]); // c1's outcome
  assert.equal(actual.out[idx].judgedDispatchTs, '2026-08-14T02:00:00Z');
  const idx2 = shuffled.indexOf(chronological[4]); // c2's outcome
  assert.equal(actual.out[idx2].judgedDispatchTs, '2026-08-15T01:00:00Z');
});

test('backfillRows leaves an outcome unmatched when no dispatch shares its key', () => {
  const rows = [outcome('2026-08-14T03:00:00Z', 'c1', 'h1')];
  const { out, unmatched } = backfillRows(rows, 'auto-dispatch');
  assert.equal(unmatched, 1);
  assert.equal(out[0].judgedDispatchTs, undefined);
});

test('backfillRows never rewrites a row that already carries judgedDispatchTs (idempotent)', () => {
  const rows = [
    dispatch('2026-08-14T01:00:00Z', 'c1', 'h1'),
    outcome('2026-08-14T03:00:00Z', 'c1', 'h1', { judgedDispatchTs: '2026-08-14T01:00:00Z' }),
  ];
  const { out, alreadyStamped, stamped } = backfillRows(rows, 'auto-dispatch');
  assert.equal(alreadyStamped, 1);
  assert.equal(stamped, 0);
  assert.equal(out[1], rows[1]); // untouched, same reference
});

test('backfillRows preserves original row order and non-object entries in output', () => {
  const rows = [null, dispatch('2026-08-14T01:00:00Z', 'c1', 'h1'), outcome('2026-08-14T02:00:00Z', 'c1', 'h1')];
  const { out } = backfillRows(rows, 'auto-dispatch');
  assert.equal(out.length, 3);
  assert.equal(out[0], null);
  assert.equal(out[2].judgedDispatchTs, '2026-08-14T01:00:00Z');
});

test('backfillRows: a dispatch row with an unparseable ts never wins "latest at or before" over a real earlier dispatch', () => {
  const rows = [
    dispatch('2026-08-14T01:00:00Z', 'c1', 'h1'),
    dispatch('not-a-real-timestamp', 'c1', 'h1'),
    outcome('2026-08-14T02:00:00Z', 'c1', 'h1'),
  ];
  assert.doesNotThrow(() => backfillRows(rows, 'auto-dispatch'));
  const { out } = backfillRows(rows, 'auto-dispatch');
  // The malformed-ts dispatch sorts last (never chronologically "before" the
  // outcome), so the real, parseable dispatch is what gets matched.
  assert.equal(out[2].judgedDispatchTs, '2026-08-14T01:00:00Z');
});
