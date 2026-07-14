/**
 * Regression test for task #158 (P0-3): getShowsApproachingRecoupment() was
 * returning zero shows year-round because the exclusion gate reused the
 * display-badge's trend threshold (±2% avg WoW), which trips 'declining' on
 * almost every open show during ordinary seasonal softness (summer,
 * post-Tony). The fix widens the gate's threshold so only a genuine
 * downward trajectory excludes a show — this locks getRecoupmentTrend's
 * threshold parameter against regressing back to the shared default.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getRecoupmentTrend, getShowsApproachingRecoupment, getAllCommercialSlugs } from '../../src/lib/data-commercial';

test('getRecoupmentTrend: a coarser threshold is never MORE likely to call a show declining', () => {
  // Property test rather than a live-data-value assertion (the previous
  // version hard-coded one show's current trend, which would silently pass
  // or fail as tomorrow's grosses land — not a real regression signal
  // either way). The threshold comparison is `avgChange < -threshold`, so a
  // larger threshold can only ever be as-or-less likely to trigger
  // 'declining' for the same underlying data. Checked across every show
  // with commercial data so it holds regardless of which shows are
  // currently soft.
  for (const slug of getAllCommercialSlugs()) {
    const narrow = getRecoupmentTrend(slug, 2);
    const wide = getRecoupmentTrend(slug, 8);
    if (wide === 'declining') {
      assert.equal(narrow, 'declining', `${slug}: wide threshold flagged declining but narrow threshold didn't`);
    }
  }
});

test('getShowsApproachingRecoupment: does not silently zero out during seasonal softness', () => {
  const shows = getShowsApproachingRecoupment();
  assert.ok(Array.isArray(shows));
  // Not asserting an exact count (dataset changes over time) — asserting
  // the section isn't structurally dead the way it was before the fix.
  assert.ok(shows.length > 0, 'expected at least one show approaching recoupment');
  for (const show of shows) {
    assert.ok(show.slug);
    assert.notEqual(show.trend, undefined);
  }
});
