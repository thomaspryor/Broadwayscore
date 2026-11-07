/**
 * Regression test for task #158 (P0-3): getShowsApproachingRecoupment() was
 * returning zero shows year-round because the exclusion gate reused the
 * display-badge's trend threshold (±2% avg WoW), which trips 'declining' on
 * almost every open show during ordinary seasonal softness (summer,
 * post-Tony). The fix widens the gate's threshold so only a genuine
 * downward trajectory excludes a show — this locks getRecoupmentTrend's
 * threshold parameter against regressing back to the shared default.
 *
 * BRO-4623 P1-2 changed what "approaching" means: the model's LOW case must
 * be at least 50% recouped (a central estimate alone no longer qualifies),
 * and the legacy AI estimate is never used. With today's data the list can
 * legitimately be empty, so the old `length > 0` assertion is replaced by a
 * per-show contract check; the selection rule itself is fixture-tested in
 * tests/unit/commercial-metrics.test.ts (isApproachingRecoupment).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRecoupmentTrend,
  getShowsApproachingRecoupment,
  getAllCommercialSlugs,
  APPROACHING_RECOUPMENT_SHARP_DECLINE_THRESHOLD_PCT,
} from '../../src/lib/data-commercial';
import { APPROACHING_MIN_LOW_PCT, DISPLAY_TREND_THRESHOLD_PCT } from '../../src/lib/commercial-metrics';

test('getRecoupmentTrend: a coarser threshold is never MORE likely to call a show declining', () => {
  // Property test rather than a live-data-value assertion (the previous
  // version hard-coded one show's current trend, which would silently pass
  // or fail as tomorrow's grosses land — not a real regression signal
  // either way). The threshold comparison is `changePct < -threshold`, so a
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

test('the approaching gate threshold stays wider than the display badge threshold (task #158)', () => {
  assert.ok(
    APPROACHING_RECOUPMENT_SHARP_DECLINE_THRESHOLD_PCT > DISPLAY_TREND_THRESHOLD_PCT,
    'reusing the display threshold for the gate zeroes the section out during ordinary seasonal softness',
  );
});

test('getShowsApproachingRecoupment: every listed show meets the BRO-4623 contract', () => {
  const shows = getShowsApproachingRecoupment();
  assert.ok(Array.isArray(shows));
  for (const show of shows) {
    assert.ok(show.slug);
    assert.notEqual(show.trend, undefined);
    assert.equal(show.modelRecoupmentPct.length, 3, `${show.slug}: needs a full model range`);
    assert.ok(
      show.modelRecoupmentPct[0] >= APPROACHING_MIN_LOW_PCT,
      `${show.slug}: low case ${show.modelRecoupmentPct[0]}% is under ${APPROACHING_MIN_LOW_PCT}%`,
    );
    assert.notEqual(
      getRecoupmentTrend(show.slug, APPROACHING_RECOUPMENT_SHARP_DECLINE_THRESHOLD_PCT),
      'declining',
      `${show.slug}: listed despite a sharp decline`,
    );
  }
  // Sorted by central estimate, highest first.
  for (let i = 1; i < shows.length; i++) {
    assert.ok(shows[i - 1].modelRecoupmentPct[1] >= shows[i].modelRecoupmentPct[1]);
  }
});
