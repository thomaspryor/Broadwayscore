/**
 * batch-drain-decision.test.mjs — 2026-08-29 wedged-batch incident.
 *
 * OpenAI batch batch_6a92c58189c88190a81297b49683df73 went terminal with
 * neither an output nor an error file. processBatchResults() refused to merge
 * the degraded 2-of-3 ensemble (correct) and kept the state for the next run
 * to retry (fatal — that fetch can never succeed). Every subsequent run
 * re-drained the same dead batch and exited 2, failing the opening-night
 * poller's stage verification 7 runs in a row; the only escape was the 48h
 * BATCH_STATE_MAX_AGE_HOURS gate, ~35h away.
 *
 * Requires the REAL exported decideBatchDrain() per CLAUDE.md rule 15 — the
 * bound is never re-implemented here, so changing the production logic fails
 * this test rather than letting two copies drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { decideBatchDrain } = require(path.join(REPO, 'scripts/lib/batch-drain-decision.js'));

test('a clean drain merges', () => {
  assert.deepEqual(decideBatchDrain({ unretrievableVendors: [] }), { action: 'merge', attempt: 0 });
});

test('a transient unretrievable leg retries rather than abandoning', () => {
  // Drain 1 and 2 of 3 must keep the state so a 429 on the results download
  // does not throw away a batch we paid for.
  assert.deepEqual(decideBatchDrain({ unretrievableVendors: ['openai'], drainCount: 0, maxDrains: 3 }), {
    action: 'retry',
    attempt: 1,
  });
  assert.deepEqual(decideBatchDrain({ unretrievableVendors: ['openai'], drainCount: 1, maxDrains: 3 }), {
    action: 'retry',
    attempt: 2,
  });
});

test('a permanently dead batch is abandoned at the bound, not left to wedge the pipeline', () => {
  const d = decideBatchDrain({ unretrievableVendors: ['openai'], drainCount: 2, maxDrains: 3 });
  assert.equal(d.action, 'abandon', 'the 3rd consecutive refused drain must abandon');
  assert.equal(d.attempt, 3);
});

test('a count already past the bound still abandons (never re-wedges)', () => {
  // The exact 2026-08-29 shape: state written by an older build with no
  // counter, or a count that somehow ran away, must not resume retrying.
  for (const drainCount of [3, 7, 99]) {
    assert.equal(
      decideBatchDrain({ unretrievableVendors: ['openai'], drainCount, maxDrains: 3 }).action,
      'abandon',
      `drainCount=${drainCount} must abandon`
    );
  }
});

test('a missing or corrupt drainCount is treated as the first refusal', () => {
  // BatchState.unretrievableDrainCount is absent on every batch submitted
  // before this change, so undefined must mean "first refusal", not NaN.
  for (const drainCount of [undefined, null, NaN, -5, 'x']) {
    assert.deepEqual(
      decideBatchDrain({ unretrievableVendors: ['openai'], drainCount, maxDrains: 3 }),
      { action: 'retry', attempt: 1 },
      `drainCount=${String(drainCount)} must read as the first refusal`
    );
  }
});

test('multiple unretrievable vendors are still one refusal', () => {
  assert.deepEqual(decideBatchDrain({ unretrievableVendors: ['openai', 'gemini'], drainCount: 0, maxDrains: 3 }), {
    action: 'retry',
    attempt: 1,
  });
});

test('a nonsensical bound degrades to abandon-immediately, never to unbounded retry', () => {
  for (const maxDrains of [0, -1, NaN]) {
    assert.equal(
      decideBatchDrain({ unretrievableVendors: ['openai'], drainCount: 0, maxDrains }).action,
      'abandon',
      `maxDrains=${String(maxDrains)} must not produce an unbounded retry loop`
    );
  }
});
