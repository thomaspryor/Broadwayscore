// Unit tests for the cast backfill tombstone decision.
// Per feedback_test_extraction_pattern.md — tests the real module via require().

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { shouldTombstone } = require('../../scripts/lib/cast-tombstone');

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
