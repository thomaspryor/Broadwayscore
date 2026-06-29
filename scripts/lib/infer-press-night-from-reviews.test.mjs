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
