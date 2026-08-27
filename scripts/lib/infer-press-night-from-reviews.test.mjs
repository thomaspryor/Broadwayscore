// Tests for the review-date press-night inference, focused on the collapsed-date
// floor (openingDate === previewsStartDate ⇒ stored date is a known preview
// date, so a 2-7 day review cluster is still a real correction). Runs under the
// colocated scripts/lib/*.test.mjs glob (plain node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inferPressNightFromReviews } = require('./infer-press-night-from-reviews.js');

// Fixed clock for the reverse branch's not-yet-opened guard. Every reverse
// fixture below stores a 2025-11 date, comfortably in this "past".
const NOW = new Date('2026-08-26T00:00:00Z').getTime();

// Build N reviews all published on `date` for a show, each from a DISTINCT
// outlet — the reverse branch counts distinct outlets, not rows, because a
// press night is a multi-outlet event. Pass `outlet` to force same-outlet rows.
function reviewsOn(showId, date, n, outlet) {
  return Array.from({ length: n }, (_, i) => ({
    showId,
    id: `${showId}-r${i}`,
    publishDate: date,
    outlet: outlet || `${showId}-outlet-${date}-${i}`,
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
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 1, 'should infer one correction');
  assert.equal(out[0].direction, 'reverse');
  assert.equal(out[0].gapDays, 16, 'cluster sits 16 days before the stored date');
  const opening = out[0].changes.find(c => c.field === 'openingDate');
  assert.equal(opening.new, '2025-11-12', 'press night = earliest clustered review date');
  const prev = out[0].changes.find(c => c.field === 'previewsStartDate');
  assert.equal(prev.new, null, 'preview start is cleared, never fabricated');
  const src = out[0].changes.find(c => c.field === 'openingDateSource');
  assert.equal(src.new, 'inferred-from-reviews-reverse',
    'reverse gets its own source string, deliberately off the press-night-trust whitelist');
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
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 0, 'pre-date reviews on a non-collapsed show read as contamination, not a date bug');
});

test('reverse: fewer than 3 clustered pre-date reviews does not trigger', () => {
  const show = {
    id: 'we-reverse-outlier-2025',
    title: 'Reverse Outlier',
    slug: 'we-reverse-outlier-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // Best 3-day window holds 2 reviews — under REVERSE_MIN_CLUSTER (3). Going
  // backwards there is no known-wrong-direction anchor, so one corroborator
  // (the forward floor) is not enough evidence.
  const reviews = [
    ...reviewsOn('we-reverse-outlier-2025', '2025-11-05', 1),
    ...reviewsOn('we-reverse-outlier-2025', '2025-11-20', 2),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 0, 'a 2-review window is not a press night');
});

test('reverse: the BIGGEST pre-date cluster wins, not the earliest', () => {
  const show = {
    id: 'we-reverse-anchor-2025',
    title: 'Three Runs',
    slug: 'we-reverse-anchor-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // 3 stale reviews from an earlier run + the real 10-outlet press wave.
  // Anchoring on the earliest date (the forward probe's rule) would pick the
  // stale trio; the reverse probe must pick the dominant wave.
  const reviews = [
    ...reviewsOn('we-reverse-anchor-2025', '2025-10-02', 3),
    ...reviewsOn('we-reverse-anchor-2025', '2025-11-10', 10),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].earliestReviewIso, '2025-11-10');
  assert.equal(out[0].changes.find(c => c.field === 'openingDate').new, '2025-11-10');
});

test('reverse: a not-yet-opened show is never back-dated', () => {
  const show = {
    id: 'we-reverse-future-2026',
    title: 'Not Open Yet',
    slug: 'we-reverse-future-2026',
    category: 'west-end',
    openingDate: '2026-12-16',
    previewsStartDate: '2026-12-16',
    openingDateSource: 'todaytix',
  };
  // Contaminated ingest: three reviews attached to a show that has not opened.
  const reviews = reviewsOn('we-reverse-future-2026', '2026-10-01', 5);
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 0, 'back-dating an unopened show would shut its pre-opening polling window');
});

test('reverse: month-only publishDates never fabricate a press night', () => {
  const show = {
    id: 'we-reverse-partial-2025',
    title: 'Partial Dates',
    slug: 'we-reverse-partial-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // reviews.json carries 123 month-only publishDates; new Date('2025-11')
  // resolves to the 1st, which would invent a press night nobody published on.
  const reviews = reviewsOn('we-reverse-partial-2025', '2025-11', 5);
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 0, 'month-only dates are not evidence of a press night');
});

test('reverse: a stale prior-run cluster cannot outvote the rest of the corpus', () => {
  const show = {
    id: 'we-reverse-priorrun-mixed-2025',
    title: 'Mixed Corpus',
    slug: 'we-reverse-priorrun-mixed-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // Three separate 3-review waves — no dominant one, so nothing is inferred.
  const reviews = [
    ...reviewsOn('we-reverse-priorrun-mixed-2025', '2025-09-15', 3),
    ...reviewsOn('we-reverse-priorrun-mixed-2025', '2025-10-15', 3),
    ...reviewsOn('we-reverse-priorrun-mixed-2025', '2025-11-15', 3),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 0, 'no wave outweighs the rest → no correction');
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
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
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
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
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
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 1, 'exactly one correction, never two for the same show');
  assert.equal(out[0].direction, 'forward');
  const opening = out[0].changes.find(c => c.field === 'openingDate');
  assert.equal(opening.new, '2025-12-04', 'forward rule keeps its earliest−1 offset');
  const prev = out[0].changes.find(c => c.field === 'previewsStartDate');
  assert.equal(prev.new, '2025-11-28', 'forward rule still preserves the old opening as previews');
});

test('reverse: a small pre-date cluster loses to a bigger wave on/after the stored date', () => {
  const show = {
    id: 'we-reverse-dominance-2025',
    title: 'Dominance',
    slug: 'we-reverse-dominance-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // The real press wave is 1 day after the stored date, so the forward branch
  // declines it (gap 1 < 2). Three earlier strays must not win by default.
  const reviews = [
    ...reviewsOn('we-reverse-dominance-2025', '2025-11-20', 3),
    ...reviewsOn('we-reverse-dominance-2025', '2025-11-29', 10),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 0, 'the larger later wave means the stored date is roughly right');
});

test('reverse: three rows from ONE outlet is not a press night', () => {
  const show = {
    id: 'we-reverse-oneoutlet-2025',
    title: 'Single Outlet',
    slug: 'we-reverse-oneoutlet-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // Same outlet re-ingested 6 times — the corpus does carry same-identity
  // duplicates (scripts/lib/merge-reviews-json.js dedups them).
  const reviews = reviewsOn('we-reverse-oneoutlet-2025', '2025-11-12', 6, 'The Same Paper');
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 0, 'one outlet, however many rows, is not a multi-outlet press wave');
});

test('reverse: reviews inside a declared priorRun window are not evidence', () => {
  const show = {
    id: 'we-reverse-priorrun-declared-2025',
    title: 'Returning Production',
    slug: 'we-reverse-priorrun-declared-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
    priorRuns: [{ openingDate: '2025-10-01', closingDate: '2025-10-31', venue: 'Some Other Theatre' }],
  };
  // A full 8-outlet press wave — but it belongs to the declared earlier run,
  // so it must not drag this run's opening date backwards.
  const reviews = reviewsOn('we-reverse-priorrun-declared-2025', '2025-10-05', 8);
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 0, "a prior run's press wave is not this run's press night");
});

test('reverse: ISO timestamps do not shift the calendar day', () => {
  const show = {
    id: 'we-reverse-timestamp-2025',
    title: 'Timestamped',
    slug: 'we-reverse-timestamp-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // 20:00 New York time on 2025-11-12 is 2025-11-13 in UTC; normalizeDate takes
  // the literal date part, so the press night stays on the 12th.
  const reviews = reviewsOn('we-reverse-timestamp-2025', '2025-11-12T20:00:00-05:00', 5);
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].changes.find(c => c.field === 'openingDate').new, '2025-11-12');
});

// --- Regressions found by the pre-ship QA pass ---

test('reverse: a correction is idempotent — the next weekly run is a no-op', () => {
  // The highest-value test in this file. Before the REVERSE_SOURCE guard, run 2
  // saw a no-longer-collapsed show, applied the forward branch's 8-day default
  // floor, and re-dated it onto a straggler wave — stamping the confirmed
  // 'inferred-from-reviews', which made the wrong date permanent.
  const show = {
    id: 'we-reverse-idempotent-2025',
    title: 'Twice Round',
    slug: 'we-reverse-idempotent-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  const reviews = [
    ...reviewsOn('we-reverse-idempotent-2025', '2025-11-12', 5),   // the press wave
    ...reviewsOn('we-reverse-idempotent-2025', '2025-11-22', 3),   // stragglers, +10d
  ];

  const run1 = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(run1.length, 1);
  assert.equal(run1[0].direction, 'reverse');
  assert.equal(run1[0].changes.find(c => c.field === 'openingDate').new, '2025-11-12');

  // Apply run 1 exactly as scripts/enrich-west-end-dates.js does.
  const corrected = { ...show };
  for (const ch of run1[0].changes) corrected[ch.field] = ch.new;
  assert.equal(corrected.previewsStartDate, null);
  assert.equal(corrected.openingDateSource, 'inferred-from-reviews-reverse');

  const run2 = inferPressNightFromReviews({ candidateShows: [corrected], reviews, now: NOW });
  assert.equal(run2.length, 0, 'only Phase 3 authoritative sources may revise a reverse inference');
});

test('reverse: an early stray does not drag the press night backwards', () => {
  const show = {
    id: 'we-reverse-stray-2025',
    title: 'Early Bird',
    slug: 'we-reverse-stray-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // One outlet jumps the gun 3 days early. Anchoring on the winning window's
  // first day would emit 2025-11-09; the press night is the first day that
  // carries ≥2 outlets.
  const reviews = [
    ...reviewsOn('we-reverse-stray-2025', '2025-11-09', 1),
    ...reviewsOn('we-reverse-stray-2025', '2025-11-12', 15),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].changes.find(c => c.field === 'openingDate').new, '2025-11-12');
});

test('reverse: a wave smeared one-outlet-per-day is not a press night', () => {
  const show = {
    id: 'we-reverse-smear-2025',
    title: 'Smeared',
    slug: 'we-reverse-smear-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  const reviews = [
    ...reviewsOn('we-reverse-smear-2025', '2025-11-10', 1),
    ...reviewsOn('we-reverse-smear-2025', '2025-11-11', 1),
    ...reviewsOn('we-reverse-smear-2025', '2025-11-12', 1),
    ...reviewsOn('we-reverse-smear-2025', '2025-11-13', 1),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 0, 'no single day carried 2 outlets — that is background coverage');
});

test('reverse: reviews inside a declared tourLeg window are not evidence', () => {
  const show = {
    id: 'we-reverse-tourleg-2025',
    title: 'On Tour',
    slug: 'we-reverse-tourleg-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
    tourLegs: [{ startDate: '2025-10-01', endDate: '2025-10-31', venue: 'Regional Playhouse' }],
  };
  const reviews = reviewsOn('we-reverse-tourleg-2025', '2025-10-05', 8);
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 0, "a tour leg's press wave is not this run's press night");
});

test('reverse: rows with a null publishDate are ignored', () => {
  const show = {
    id: 'we-reverse-nulldate-2025',
    title: 'Undated',
    slug: 'we-reverse-nulldate-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // 2,382 rows in reviews.json carry a null publishDate.
  const reviews = [
    ...reviewsOn('we-reverse-nulldate-2025', '2025-11-12', 4),
    { showId: 'we-reverse-nulldate-2025', id: 'n1', publishDate: null, outlet: 'No Date A' },
    { showId: 'we-reverse-nulldate-2025', id: 'n2', publishDate: undefined, outlet: 'No Date B' },
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 1, 'undated rows neither block nor feed the inference');
  assert.equal(out[0].changes.find(c => c.field === 'openingDate').new, '2025-11-12');
});

test('reverse: a dominance tie still passes', () => {
  const show = {
    id: 'we-reverse-tie-2025',
    title: 'Dead Heat',
    slug: 'we-reverse-tie-2025',
    category: 'west-end',
    openingDate: '2025-11-28',
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  // 4 rows in the winning cluster, 4 on/after the stored date — the guard is
  // `<`, so an exact tie is a correction, not a veto. The later wave sits at
  // gap 1, inside the forward branch's collapsed floor, so forward declines it
  // and control actually reaches the reverse dominance check.
  const reviews = [
    ...reviewsOn('we-reverse-tie-2025', '2025-11-12', 4),
    ...reviewsOn('we-reverse-tie-2025', '2025-11-29', 4),
  ];
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews, now: NOW });
  assert.equal(out.length, 1, 'tie goes to the correction');
  assert.equal(out[0].changes.find(c => c.field === 'openingDate').new, '2025-11-12');
});

test('reverse: the default `now` is the real clock (no injection needed)', () => {
  const show = {
    id: 'we-reverse-defaultnow-2025',
    title: 'Default Clock',
    slug: 'we-reverse-defaultnow-2025',
    category: 'west-end',
    openingDate: '2025-11-28', // safely in the past
    previewsStartDate: '2025-11-28',
    openingDateSource: 'todaytix',
  };
  const reviews = reviewsOn('we-reverse-defaultnow-2025', '2025-11-12', 5);
  const out = inferPressNightFromReviews({ candidateShows: [show], reviews });
  assert.equal(out.length, 1, 'omitting `now` must not disable the branch');
  assert.equal(out[0].changes.find(c => c.field === 'openingDate').new, '2025-11-12');
});
