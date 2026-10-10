// Unit tests for the cast backfill tombstone decision.
// Per feedback_test_extraction_pattern.md — tests the real module via require().

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { shouldTombstone, shouldAbortMassWipe } = require('../../scripts/lib/cast-tombstone');

describe('cast-tombstone shouldTombstone', () => {
  it('tombstones a GENUINE empty (page loaded, production has no IBDB cast)', () => {
    // extractCastFromIBDBPage parsed the page fine but found no OpeningNightCast.
    assert.equal(shouldTombstone({ found: false, openingNightCast: [], fetchFailed: false }), true);
  });

  it('does NOT tombstone a TRANSIENT fetch failure (page did not load)', () => {
    assert.equal(shouldTombstone({ found: false, openingNightCast: [], fetchFailed: true }), false);
  });

  it('does NOT tombstone a thrown-error / network failure', () => {
    // lookupIBDBCast catch path returns fetchFailed:true.
    assert.equal(shouldTombstone({ found: false, openingNightCast: [], fetchFailed: true }), false);
  });

  it('treats a missing fetchFailed flag as genuine empty (back-compat, tombstone)', () => {
    // Old result shape with no fetchFailed key → behave as before (tombstone).
    assert.equal(shouldTombstone({ found: false, openingNightCast: [] }), true);
  });

  it('handles a null/undefined result defensively (tombstone)', () => {
    assert.equal(shouldTombstone(null), true);
    assert.equal(shouldTombstone(undefined), true);
  });
});

describe('cast-tombstone shouldAbortMassWipe', () => {
  it('does not abort under the 30% threshold', () => {
    assert.equal(shouldAbortMassWipe(30, 8), false); // ~26.7%
  });

  it('aborts once wiped share crosses the 30% threshold', () => {
    assert.equal(shouldAbortMassWipe(30, 10), true); // exactly 33.3%
  });

  it('matches the task #712 incident shape (29-30 shows, all wiped)', () => {
    assert.equal(shouldAbortMassWipe(29, 29), true);
  });

  it('does not abort with zero wipes', () => {
    assert.equal(shouldAbortMassWipe(29, 0), false);
  });

  it('never aborts when nothing was populated beforehand (nothing to protect)', () => {
    assert.equal(shouldAbortMassWipe(0, 0), false);
  });

  it('respects a custom threshold', () => {
    assert.equal(shouldAbortMassWipe(10, 2, 0.1), true); // 20% > 10%
    assert.equal(shouldAbortMassWipe(10, 1, 0.1), false); // 10% is not > 10%
  });
});
