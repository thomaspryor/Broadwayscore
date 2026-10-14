// scripts/lib/batch-runner.test.mjs — S3-T7b's abort threshold.
//
// The acceptance criterion is "a fixture with one unexpected disposition aborts
// after its batch, leaving prior batches intact". That is asserted here against
// the REAL runBatched the importer drives (CLAUDE.md rule 15), not a re-typed
// copy of its shape — the alternative would be exercising it against the live
// Linear API, which is the thing the batching exists to protect.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { runBatched } = require('./batch-runner.js');

const items = Array.from({ length: 25 }, (_, i) => `item-${i}`);

test('one unexpected failure aborts AFTER its batch, prior batches intact', async () => {
  const seen = [];
  // item-12 sits in batch 3 (0-4, 5-9, 10-14): batches 1 and 2 must complete,
  // batch 3 must run to its end, and batches 4-5 must never start.
  const out = await runBatched({
    items,
    batchSize: 5,
    onItem: async (item) => {
      seen.push(item);
      return item === 'item-12' ? { ok: false, error: 'unexpected disposition' } : { ok: true };
    },
  });

  assert.equal(out.aborted, true);
  assert.equal(out.batches, 3, 'stopped at the batch containing the failure');
  assert.equal(out.processed, 15, 'the failing batch ran to its end, and nothing beyond it started');
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].item, 'item-12');
  assert.equal(out.failures[0].index, 12, 'the failure knows its absolute position, not its position in the batch');

  // Prior batches intact: every item up to the end of batch 3 was processed...
  assert.deepEqual(seen, items.slice(0, 15));
  // ...and nothing after it was touched.
  assert.ok(!seen.includes('item-15'), 'batch 4 must never start');
  assert.ok(!seen.includes('item-24'));
});

test('a clean run processes everything and reports no abort', async () => {
  const out = await runBatched({ items, batchSize: 10, onItem: async () => ({ ok: true }) });
  assert.equal(out.aborted, false);
  assert.equal(out.processed, 25);
  assert.equal(out.batches, 3);
  assert.equal(out.failures.length, 0);
});

test('two failures in the SAME batch are both reported before the abort', async () => {
  // Otherwise the operator fixes one cause, re-runs, and hits the second.
  const out = await runBatched({
    items,
    batchSize: 10,
    onItem: async (item) => (item === 'item-2' || item === 'item-7' ? { ok: false, error: 'x' } : { ok: true }),
  });
  assert.equal(out.failures.length, 2);
  assert.equal(out.processed, 10);
  assert.equal(out.batches, 1);
});

test('a THROW is not swallowed as a failed item', async () => {
  // A thrown error is a bug or an unrecoverable condition — an auth failure, a
  // missing workflow state — and must take the process down rather than be
  // counted as one bad card and retried 1,800 times.
  await assert.rejects(
    () =>
      runBatched({
        items,
        batchSize: 5,
        onItem: async (item) => {
          if (item === 'item-3') throw new Error('LINEAR_API_KEY invalid');
          return { ok: true };
        },
      }),
    /LINEAR_API_KEY invalid/
  );
});

test('the pacing hook runs between items', async () => {
  // Without spacing the S1-T1 backoff becomes the de-facto pacer — up to five
  // sleeps per request, which across 1,949 items looks exactly like a hang.
  let paced = 0;
  const out = await runBatched({
    items: items.slice(0, 6),
    batchSize: 3,
    onItem: async () => ({ ok: true }),
    betweenItems: () => {
      paced++;
    },
  });
  assert.equal(out.processed, 6);
  assert.equal(paced, 6, 'every item is paced, across batch boundaries too');
});

test('bad arguments fail loudly rather than silently doing nothing', async () => {
  await assert.rejects(() => runBatched({ items: null, onItem: async () => ({ ok: true }) }), /must be an array/);
  await assert.rejects(
    () => runBatched({ items, batchSize: 0, onItem: async () => ({ ok: true }) }),
    /batchSize must be positive/
  );
});
