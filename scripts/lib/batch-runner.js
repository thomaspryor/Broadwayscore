#!/usr/bin/env node
// scripts/lib/batch-runner.js — batch a long write run, and stop at the first
// batch that produced an unexpected failure (S3-T7b).
//
// WHY THIS IS ITS OWN FILE. The behaviour being asserted is "the run stops at
// the right boundary and everything before it is intact". Testing that against
// linear-import-corpus.js directly would mean testing against the live Linear
// API, which is exactly the thing the batching exists to protect. So the
// control flow is here, pure and injectable, and the importer drives it — the
// test exercises the REAL function rather than a copy of its shape
// (CLAUDE.md rule 15).
//
// WHY ABORT AT THE BATCH BOUNDARY AND NOT IMMEDIATELY. Two reasons, both about
// a board with no bulk delete:
//   * Not immediately: an in-flight batch is already partly written. Stopping
//     mid-batch to "save" the remaining few items buys nothing and makes the
//     resume point harder to reason about, because the ledger append and the
//     create are not one transaction.
//   * Not at the end of the run: continuing past the first unexpected failure
//     means making the same mistake up to 1,800 more times. Whatever went
//     wrong on item 7 is overwhelmingly likely to be wrong on item 800.

'use strict';

/**
 * @param {Array} items
 * @param {number} batchSize
 * @param {(item, index) => Promise<{ok: boolean, [k: string]: any}>} onItem
 *        Resolve with ok:false to record an unexpected failure. THROWING is
 *        different and deliberately not caught here: a thrown error is a bug or
 *        an unrecoverable condition, and it should take the process down rather
 *        than be counted as one bad card.
 * @param {(info) => Promise<void>|void} [onBatchEnd]
 * @param {() => Promise<void>|void} [betweenItems]  pacing hook
 * @returns {Promise<{processed, failures, batches, aborted}>}
 */
async function runBatched({ items, batchSize = 100, onItem, onBatchEnd, betweenItems }) {
  if (!Array.isArray(items)) throw new TypeError('runBatched: items must be an array');
  if (!(batchSize > 0)) throw new RangeError('runBatched: batchSize must be positive');

  const failures = [];
  let processed = 0;
  let batches = 0;
  let aborted = false;

  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    batches++;
    for (let i = 0; i < batch.length; i++) {
      const index = start + i;
      const result = await onItem(batch[i], index);
      processed++;
      if (result && result.ok === false) failures.push({ index, item: batch[i], ...result });
      if (betweenItems) await betweenItems();
    }
    if (onBatchEnd) await onBatchEnd({ batch: batches, processed, failures: failures.slice() });
    if (failures.length) {
      // Everything already processed stays processed — the caller has appended
      // its ledger rows and a re-run resumes from them. Nothing is rolled back
      // here; that is --rollback's job and it is an explicit, separate decision.
      aborted = true;
      break;
    }
  }

  return { processed, failures, batches, aborted };
}

module.exports = { runBatched };
