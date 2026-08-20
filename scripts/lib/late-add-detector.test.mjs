import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { detectLateAdd, GRACE_DAYS } = require('./late-add-detector.js');

describe('detectLateAdd', () => {
  test('no catalog clock -> not measurable', () => {
    const r = detectLateAdd([{ assignedScore: 80, publishDate: '2026-01-01', firstSeenAt: '2026-06-01' }], null);
    assert.equal(r.isLateAdd, false);
    assert.equal(r.reason, 'no-catalog-clock');
  });

  test('no reviews -> not measurable', () => {
    const r = detectLateAdd([], '2026-06-17');
    assert.equal(r.isLateAdd, false);
    assert.equal(r.reason, 'no-measurable-reviews');
  });

  test('unscored reviews are ignored', () => {
    const r = detectLateAdd([{ assignedScore: null, publishDate: '2026-01-01', firstSeenAt: '2026-06-01' }], '2026-06-17');
    assert.equal(r.reason, 'no-measurable-reviews');
  });

  test('a fetch-date-stamped publishDate (== firstSeenAt day, no source) is excluded as unmeasurable', () => {
    const r = detectLateAdd(
      [{ assignedScore: 80, publishDate: '2026-06-01', firstSeenAt: '2026-06-01T10:00:00Z' }],
      '2026-06-17',
    );
    assert.equal(r.reason, 'no-measurable-reviews');
  });

  test('review within the grace window is NOT a late add (normal preview review)', () => {
    // 20 days before previewsStartDate -- inside the 30d grace window.
    const r = detectLateAdd(
      [{ assignedScore: 82, publishDate: '2026-05-28', firstSeenAt: '2026-06-05T00:00:00Z', outletId: 'nytimes' }],
      '2026-06-17',
    );
    assert.equal(r.isLateAdd, false);
    assert.equal(r.gapDays, 20);
  });

  test('dad-dont-read-this class: earliest review ~35 days before catalog clock IS a late add', () => {
    // Real 2026-07-22 corpus shape: Vulture 2026-05-13, previewsStartDate 2026-06-17.
    const reviewsForShow = [
      { assignedScore: 78, publishDate: '2026-05-13', firstSeenAt: '2026-07-01T00:00:00Z', outletId: 'vulture' },
      { assignedScore: 89, publishDate: '2026-05-17', firstSeenAt: '2026-07-01T00:00:00Z', outletId: 'nytimes' },
      { assignedScore: 88, publishDate: '2026-06-23', firstSeenAt: '2026-06-24T00:00:00Z', outletId: 'nytg' },
    ];
    const r = detectLateAdd(reviewsForShow, '2026-06-17');
    assert.equal(r.isLateAdd, true);
    assert.equal(r.gapDays, 35);
    assert.equal(r.earliestReviewDate, '2026-05-13');
    assert.equal(r.earliestOutletId, 'vulture');
  });

  test('the flagging threshold is 30 days, per BRO-91 acceptance criteria', () => {
    // Pins the literal "30-day" policy the acceptance criteria names. The
    // boundary tests below derive their fixture dates FROM GRACE_DAYS, so
    // without this they'd keep passing even if GRACE_DAYS silently drifted
    // to 29 or 31.
    assert.equal(GRACE_DAYS, 30);
  });

  test('GRACE_DAYS boundary: exactly at the floor is NOT late (strictly greater-than)', () => {
    const catalogClock = '2026-06-17';
    const earliestMs = Date.parse(catalogClock) - GRACE_DAYS * 86400000;
    const earliestDate = new Date(earliestMs).toISOString().slice(0, 10);
    const r = detectLateAdd(
      [{ assignedScore: 80, publishDate: earliestDate, firstSeenAt: '2026-07-01T00:00:00Z' }],
      catalogClock,
    );
    assert.equal(r.isLateAdd, false);
    assert.equal(r.gapDays, GRACE_DAYS);
  });

  test('GRACE_DAYS boundary: one day past the floor IS late', () => {
    const catalogClock = '2026-06-17';
    const earliestMs = Date.parse(catalogClock) - (GRACE_DAYS + 1) * 86400000;
    const earliestDate = new Date(earliestMs).toISOString().slice(0, 10);
    const r = detectLateAdd(
      [{ assignedScore: 80, publishDate: earliestDate, firstSeenAt: '2026-07-01T00:00:00Z' }],
      catalogClock,
    );
    assert.equal(r.isLateAdd, true);
    assert.equal(r.gapDays, GRACE_DAYS + 1);
  });

  test('Broadway transfer class: earliest review is a prior West End/tryout run, hundreds of days out', () => {
    // BRO-91 corpus-wide run surfaced this shape repeatedly on Broadway titles
    // with no priorRuns/transferOf link yet: a review of an earlier run
    // (West End original, out-of-town tryout) predates the Broadway catalog
    // clock by hundreds of days, well past any preview window. The earlier
    // review is listed SECOND here (not element 0) so this can only pass if
    // detectLateAdd actually scans for the minimum publishDate rather than
    // assuming the earliest review is always first in the array.
    const reviewsForShow = [
      { assignedScore: 79, publishDate: '2025-03-11', firstSeenAt: '2025-03-12T00:00:00Z', outletId: 'nytimes' },
      { assignedScore: 85, publishDate: '2023-11-02', firstSeenAt: '2025-09-01T00:00:00Z', outletId: 'guardian' },
    ];
    const r = detectLateAdd(reviewsForShow, '2025-03-25');
    assert.equal(r.isLateAdd, true);
    assert.equal(r.gapDays, 509);
    assert.equal(r.earliestOutletId, 'guardian');
  });

  test('West End class: an earlier venue run under the same catalog entry, well past grace', () => {
    // Mirrors the West End side of the corpus-wide run: an off-West-End or
    // regional-transfer run's reviews (both predating the catalog clock)
    // land under the transfer venue's later catalog clock with no
    // priorRuns link yet. The earlier review is listed SECOND to prove the
    // min-selection scan, not array position.
    const reviewsForShow = [
      { assignedScore: 88, publishDate: '2026-06-01', firstSeenAt: '2026-06-02T00:00:00Z', outletId: 'whatsonstage' },
      { assignedScore: 90, publishDate: '2025-10-08', firstSeenAt: '2026-06-03T00:00:00Z', outletId: 'thestage' },
    ];
    const r = detectLateAdd(reviewsForShow, '2026-06-13');
    assert.equal(r.isLateAdd, true);
    assert.equal(r.gapDays, 248);
    assert.equal(r.earliestOutletId, 'thestage');
  });

  test('multiple pre-opening reviews inside grace window: none trigger a late add', () => {
    // A normal preview cycle: several critics review during previews, all
    // within the 30d grace window -- this must NOT be flagged.
    const reviewsForShow = [
      { assignedScore: 70, publishDate: '2026-05-20', firstSeenAt: '2026-05-21T00:00:00Z', outletId: 'variety' },
      { assignedScore: 75, publishDate: '2026-05-25', firstSeenAt: '2026-05-26T00:00:00Z', outletId: 'nypost' },
      { assignedScore: 80, publishDate: '2026-06-10', firstSeenAt: '2026-06-11T00:00:00Z', outletId: 'nytimes' },
    ];
    const r = detectLateAdd(reviewsForShow, '2026-06-17');
    assert.equal(r.isLateAdd, false);
    assert.equal(r.gapDays, 28);
  });
});

describe('detectLateAdd on real corpus data (if available)', () => {
  const reviewsPath = path.join(__dirname, '..', '..', 'data', 'reviews.json');
  const showsPath = path.join(__dirname, '..', '..', 'data', 'shows.json');
  const hasData = fs.existsSync(reviewsPath) && fs.existsSync(showsPath);

  // Structural checks only -- NEVER assert a specific show's current
  // isLateAdd/gapDays here. The S5-T1 acceptance criterion this used to pin
  // (dad-dont-read-this-off-broadway-2026 flagged true) is a live-corpus fact
  // that legitimately changes once a show's priorRuns/openingDate gets
  // corrected, which would break main the same way #489 did for outlet
  // cadence. The actual true/false behavior is already locked down above by
  // a frozen synthetic fixture ("dad-dont-read-this class", line 48).
  test('produces well-formed results across the live catalog', { skip: !hasData }, () => {
    const reviews = Object.values(JSON.parse(fs.readFileSync(reviewsPath, 'utf8')).reviews);
    const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows;
    const reviewsByShow = new Map();
    for (const r of reviews) {
      if (!reviewsByShow.has(r.showId)) reviewsByShow.set(r.showId, []);
      reviewsByShow.get(r.showId).push(r);
    }
    const validReasons = new Set(['no-catalog-clock', 'no-measurable-reviews', undefined]);
    let sawLateAdd = false;
    let sawNotLateAdd = false;
    for (const show of shows) {
      const catalogClock = show.previewsStartDate || show.openingDate;
      const r = detectLateAdd(reviewsByShow.get(show.id) || [], catalogClock);
      assert.equal(typeof r.isLateAdd, 'boolean', `${show.id}: isLateAdd is a boolean`);
      if (r.isLateAdd) {
        sawLateAdd = true;
        assert.ok(Number.isFinite(r.gapDays) && r.gapDays > GRACE_DAYS, `${show.id}: late add has a gapDays over the floor`);
      } else {
        sawNotLateAdd = true;
        assert.ok(validReasons.has(r.reason), `${show.id}: reason "${r.reason}" is a known enum value`);
      }
    }
    // Sanity: classification is actually discriminating, not degenerate.
    assert.ok(sawLateAdd, 'at least one show in the catalog is flagged as a late add');
    assert.ok(sawNotLateAdd, 'at least one show in the catalog is not a late add');
  });
});
