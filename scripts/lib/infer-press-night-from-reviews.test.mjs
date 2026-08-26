// Tests for the review-date press-night inference, focused on the collapsed-date
// floor (openingDate === previewsStartDate ⇒ stored date is a known preview
// date, so a 2-7 day review cluster is still a real correction). Runs under the
// colocated scripts/lib/*.test.mjs glob (plain node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inferPressNightFromReviews } = require('./infer-press-night-from-reviews.js');

// Build N reviews all published on `date` for a show.
function reviewsOn(showId, date, n) {
  return Array.from({ length: n }, (_, i) => ({
    showId,
    id: `${showId}-r${i}`,
    publishDate: date,
  }));
}

test('collapsed WE show with a 5-day review cluster IS corrected (floor lowered to 2)', () => {
  const show = {
    id: 'fringe-we-2026',
    title: 'Fringe Show',
    slug: 'fringe-we-2026',
    category: 'west-end',
    openingDate: '2026-03-01',
    previewsStartDate: '2026-03-01', // collapsed
    openingDateSource: 'todaytix',
  };
  // Earliest review 2026-03-06 (5 days after stored date), 3 reviews same day.
  const reviews = reviewsOn('fringe-we-2026', '2026-03-06', 3);
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 1, 'should infer one correction');
  assert.equal(out[0].isCollapsed, true);
  const opening = out[0].changes.find(c => c.field === 'openingDate');
  assert.equal(opening.new, '2026-03-05', 'press night = earliest review − 1 day');
  const prev = out[0].changes.find(c => c.field === 'previewsStartDate');
  assert.equal(prev.new, '2026-03-01', 'preview start preserved as the old opening date');
});

test('NON-collapsed show with the same 5-day gap is NOT corrected (default floor 8)', () => {
  const show = {
    id: 'we-noncollapsed-2026',
    title: 'Other Show',
    slug: 'we-noncollapsed-2026',
    category: 'west-end',
    openingDate: '2026-03-01',
    previewsStartDate: '2026-02-20', // distinct ⇒ not collapsed
    openingDateSource: 'todaytix',
  };
  const reviews = reviewsOn('we-noncollapsed-2026', '2026-03-06', 3); // gap 5 < 8
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 0, 'small gap on a non-collapsed show stays untouched');
});

test('collapsed show with gap < 2 is a no-op', () => {
  const show = {
    id: 'we-gap1-2026',
    title: 'Cold Open',
    slug: 'we-gap1-2026',
    category: 'west-end',
    openingDate: '2026-03-01',
    previewsStartDate: '2026-03-01',
    openingDateSource: 'todaytix',
  };
  const reviews = reviewsOn('we-gap1-2026', '2026-03-02', 3); // gap 1
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 0, 'gap 1 → press night ≈ stored date, skip');
});

test('cluster check still applies: a single early review does not trigger', () => {
  const show = {
    id: 'we-outlier-2026',
    title: 'Outlier',
    slug: 'we-outlier-2026',
    category: 'west-end',
    openingDate: '2026-03-01',
    previewsStartDate: '2026-03-01',
    openingDateSource: 'todaytix',
  };
  // One review at +5, two more 10 days later → earliest cluster has only 1.
  const reviews = [
    ...reviewsOn('we-outlier-2026', '2026-03-06', 1),
    ...reviewsOn('we-outlier-2026', '2026-03-16', 2),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 0, 'single early outlier is not a press cluster');
});

test('confirmed (theatremonkey) source is never overwritten', () => {
  const show = {
    id: 'we-confirmed-2026',
    title: 'Confirmed',
    slug: 'we-confirmed-2026',
    category: 'west-end',
    openingDate: '2026-03-01',
    previewsStartDate: '2026-03-01',
    openingDateSource: 'theatremonkey', // not unconfirmed
  };
  const reviews = reviewsOn('we-confirmed-2026', '2026-03-06', 3);
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 0, 'trusted source short-circuits inference');
});

// --- Reverse direction (BRO-2280): review cluster BEFORE the stored date ---
// Real case: the-hunger-games-on-stage-west-end-2025 had openingDate 2025-11-28
// (todaytix, collapsed with previewsStartDate) but an 18-outlet review cluster
// on 2025-11-12/11-13. The forward-only filter made that cluster invisible.

test('collapsed show with a review cluster BEFORE the stored date IS corrected', () => {
  const show = {
    id: 'the-hunger-games-on-stage-west-end-2025',
    title: 'The Hunger Games On Stage',
    slug: 'the-hunger-games-on-stage-west-end-2025',
    category: 'off-west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28', // collapsed
    openingDateSource: 'todaytix',
  };
  const showId = 'the-hunger-games-on-stage-west-end-2025';
  const reviews = [
    ...reviewsOn(showId, '2025-11-12', 3),
    ...reviewsOn(showId, '2025-11-13', 15),
    ...reviewsOn(showId, '2025-11-20', 1),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 1, 'should infer one correction');
  assert.equal(out[0].direction, 'reverse');
  assert.equal(out[0].gapDays, 16, 'cluster sits 16 days before the stored date');
  const opening = out[0].changes.find(c => c.field === 'openingDate');
  assert.equal(opening.new, '2025-11-12', 'press night = earliest clustered review date');
  const prev = out[0].changes.find(c => c.field === 'previewsStartDate');
  assert.equal(prev.new, null, 'preview start is cleared, never fabricated');
  const src = out[0].changes.find(c => c.field === 'openingDateSource');
  assert.equal(src.new, 'inferred-from-reviews');
});

test('NON-collapsed show with the same before-the-date cluster is NOT touched', () => {
  const show = {
    id: 'we-noncollapsed-reverse-2025',
    title: 'Not Collapsed',
    slug: 'we-noncollapsed-reverse-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-10', // distinct ⇒ not collapsed
    openingDateSource: 'todaytix',
  };
  const reviews = [
    ...reviewsOn('we-noncollapsed-reverse-2025', '2025-11-12', 3),
    ...reviewsOn('we-noncollapsed-reverse-2025', '2025-11-13', 15),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 0, 'pre-date reviews on a non-collapsed show read as contamination, not a date bug');
});

test('reverse: single early outlier before the stored date does not trigger', () => {
  const show = {
    id: 'we-reverse-outlier-2025',
    title: 'Reverse Outlier',
    slug: 'we-reverse-outlier-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // Earliest pre-date review is alone; the real mass is 10 days later but the
  // cluster probe only ever anchors on the earliest date (same as forward).
  const reviews = [
    ...reviewsOn('we-reverse-outlier-2025', '2025-11-05', 1),
    ...reviewsOn('we-reverse-outlier-2025', '2025-11-20', 2),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 0, 'single early outlier is not a press cluster');
});

test('reverse: gap < 2 days is a no-op', () => {
  const show = {
    id: 'we-reverse-gap1-2025',
    title: 'Reverse Cold Open',
    slug: 'we-reverse-gap1-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  const reviews = reviewsOn('we-reverse-gap1-2025', '2025-11-27', 3); // gap 1
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 0, 'gap 1 → press night ≈ stored date, skip');
});

test('reverse: cluster more than 90 days before the stored date is a no-op', () => {
  const show = {
    id: 'we-reverse-priorrun-2025',
    title: 'Prior Run Contamination',
    slug: 'we-reverse-priorrun-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // Out-of-town tryout reviews wrongly attached — 5 months earlier.
  const reviews = reviewsOn('we-reverse-priorrun-2025', '2025-06-20', 6);
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 0, 'a cluster that far back is contamination, not a date bug');
});

test('forward wins when both a before- and an after-cluster qualify', () => {
  const show = {
    id: 'we-both-directions-2025',
    title: 'Both Directions',
    slug: 'we-both-directions-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  const reviews = [
    ...reviewsOn('we-both-directions-2025', '2025-11-12', 3),
    ...reviewsOn('we-both-directions-2025', '2025-12-05', 3),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 1, 'exactly one correction, never two for the same show');
  assert.equal(out[0].direction, 'forward');
  const opening = out[0].changes.find(c => c.field === 'openingDate');
  assert.equal(opening.new, '2025-12-04', 'forward rule keeps its earliest−1 offset');
  const prev = out[0].changes.find(c => c.field === 'previewsStartDate');
  assert.equal(prev.new, '2025-11-28', 'forward rule still preserves the old opening as previews');
});
