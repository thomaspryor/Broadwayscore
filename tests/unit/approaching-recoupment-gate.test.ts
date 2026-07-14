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
import { getRecoupmentTrend, getShowsApproachingRecoupment } from '../../src/lib/data-commercial';

test('getRecoupmentTrend: a wider threshold can turn a mild dip from declining to steady', () => {
  // buena-vista-social-club sits in the real dataset with a ~-4% avg WoW
  // (ordinary summer softness) — 'declining' at the default 2% badge
  // threshold, but not a sharp decline at the coarser 8% gate threshold.
  const badgeTrend = getRecoupmentTrend('buena-vista-social-club', 2);
  const gateTrend = getRecoupmentTrend('buena-vista-social-club', 8);
  assert.equal(badgeTrend, 'declining');
  assert.notEqual(gateTrend, 'declining');
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
