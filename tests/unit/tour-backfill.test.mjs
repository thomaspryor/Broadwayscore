/**
 * tour-backfill (BRO-4211): which archived tour reviews move from a Broadway
 * show to its tour entry, and how each file is rewritten.
 *
 * Run: node --test tests/unit/tour-backfill.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { genericVenuesOf, classifyTourBackfill, prepareTourMove, planTourSweep, decideTourSweep, matchStop, loadSweepContext, sweepLimits, sweepHoldReason, settingCitiesOf, decideTourIntegrity, applyIntegrityFlag, clearStaleScoringFailure } = require('../../scripts/lib/tour-backfill.js');

const tourFlag = { wrongProduction: true, wrongProductionReason: 'BWW regional/tour review (denver)', url: 'https://www.denverpost.com/x' };
// An undated review moves only to a dated tour it was found after (BRO-4325).
const LIVE = { tourLaunchDate: '2024-08-01' };
const seen = { urlDiscoveredAt: '2025-01-01T00:00:00Z' };

test('a tour-flagged review moves', () => {
  assert.deepEqual(classifyTourBackfill({ ...tourFlag, ...seen }, LIVE), { action: 'move', reason: 'tour-review' });
});

test('files that are not tour-flagged, already routed, or unusable stay put', () => {
  assert.equal(classifyTourBackfill({ wrongProduction: false }).reason, 'not-flagged');
  assert.equal(classifyTourBackfill({ wrongProduction: true, wrongProductionReason: 'URL year mismatch' }).reason, 'flag-not-tour');
  assert.equal(classifyTourBackfill({ ...tourFlag, routedFromShowId: 'x' }).reason, 'already-routed');
  assert.equal(classifyTourBackfill({ ...tourFlag, isNonReview: true }).reason, 'non-review');
  assert.equal(classifyTourBackfill({ ...tourFlag, duplicateOf: 'a.json' }).reason, 'duplicate');
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongShow: true }).reason, 'wrong-show');
});

test('pre-Broadway tryouts and UK productions are not the North American tour', () => {
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongProductionReason: 'Tour review | pre-Broadway tryout at Emerson Colonial' }).reason, 'tryout');
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongFullText: 'The pre-Broadway tryout in Boston is a delight.' }).reason, 'tryout');
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongProductionReason: 'UK tour stop review' }).reason, 'uk-production');
});

// Four A Beautiful Noise tour-stop reviews (Houston, Minneapolis, Cleveland, Revue)
// carried only this generic label; it must not read as tryout evidence.
test('the generic "Tour/regional/pre-Broadway production" label is neither tryout nor tour evidence (BRO-4262)', () => {
  const generic = { ...tourFlag, ...seen, showId: 'shucked-2023', wrongProductionReason: 'Tour/regional/pre-Broadway production, not Broadway. Flagged by contamination safety net' };
  // On its own it could be a regional stock or sit-down production: stays put.
  assert.equal(classifyTourBackfill(generic, LIVE).reason, 'no-tour-evidence');
  // With a tour-stop URL or tour language in the text it moves, and is not read as a tryout.
  assert.equal(classifyTourBackfill({ ...generic, url: 'https://www.broadwayworld.com/denver/article/Review-SHUCKED-at-Buell' }, LIVE).action, 'move');
  assert.equal(classifyTourBackfill({ ...generic, fullText: 'The national tour of Shucked arrived at the Fox.' }, LIVE).action, 'move');
});

test('dated reviews before the Broadway opening or the tour launch stay put', () => {
  const ctx = { broadwayOpeningDate: '2022-12-04', tourLaunchDate: '2024-08-01' };
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2022-07-01' }, ctx).reason, 'before-broadway-opening');
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2023-05-01' }, ctx).reason, 'before-tour-launch');
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2024-07-28' }, ctx).action, 'move'); // within a week of launch
  // Undated: placed by when the pipeline first saw it (BRO-4325).
  assert.equal(classifyTourBackfill({ ...tourFlag, urlDiscoveredAt: '2024-10-01T00:00:00Z' }, ctx).action, 'move');
  assert.equal(classifyTourBackfill({ ...tourFlag, urlDiscoveredAt: '2023-02-09T00:00:00Z' }, ctx).reason, 'undated-before-launch');
  assert.equal(classifyTourBackfill({ ...tourFlag }, ctx).reason, 'undated-before-launch', 'never seen: unknown, stays put');
  // Real case: a 2019 Broadway review in beetlejuice-2025 whose note says "not the 2025 tour stop".
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: 'April 29th, 2019' }, ctx).reason, 'before-broadway-opening');
});

test('prepareTourMove restores the text, sets aside Broadway-relative verdicts, stamps provenance', () => {
  const src = {
    showId: 'beetlejuice-2022', ...tourFlag, wrongFullText: 'Review text', fullText: null, contentTier: 'invalid',
    textQuality: 'truncated', contentVerification: { isValid: false }, verifiedBy: 'llm:gemini', possibleTourReview: true,
  };
  const out = prepareTourMove(src, { fromShowId: 'beetlejuice-2022', tourId: 'beetlejuice-tour-2023', at: '2026-09-28T00:00:00Z' });
  assert.equal(out.showId, 'beetlejuice-tour-2023');
  assert.equal(out.fullText, 'Review text');
  assert.equal(out.wrongFullText, undefined);
  assert.equal(out.contentTier, 'truncated');
  for (const k of ['wrongProduction', 'wrongProductionReason', 'contentVerification', 'verifiedBy', 'possibleTourReview']) {
    assert.ok(!(k in out), `${k} should be removed`);
  }
  assert.equal(out.routedPriorVerdicts.wrongProduction, true);
  assert.deepEqual(out.routedPriorVerdicts.contentVerification, { isValid: false });
  assert.equal(out.routedFromShowId, 'beetlejuice-2022');
  assert.equal(src.wrongProduction, true, 'input must not be mutated');
});

test('the scorer give-up state from the flagged period does not follow the move', () => {
  const src = {
    showId: 'spamalot-2023', ...tourFlag, fullText: 'Review text', contentTier: 'complete',
    manualClearFallbackFailedAt: '2026-08-05T21:23:57.015Z', manualClearFallbackAttempts: 5, manualClearFallbackAbandoned: true,
    manualClearFallbackFailureReason: 'Skipped fullText (wrongProduction flag). No usable text found',
  };
  const out = prepareTourMove(src, { fromShowId: 'spamalot-2023', tourId: 'spamalot-tour-2025' });
  for (const k of ['manualClearFallbackFailedAt', 'manualClearFallbackAttempts', 'manualClearFallbackAbandoned', 'manualClearFallbackFailureReason']) {
    assert.ok(!(k in out), `${k} should be removed`);
  }
  assert.equal(out.routedPriorVerdicts.manualClearFallbackAbandoned, true);
});

test('clearStaleScoringFailure unblocks a moved file and leaves others alone', () => {
  const moved = { showId: 'spamalot-tour-2025', routedFromShowId: 'spamalot-2023', manualClearFallbackAbandoned: true, manualClearFallbackAttempts: 5, routedPriorVerdicts: { wrongProduction: true } };
  const out = clearStaleScoringFailure(moved);
  assert.equal(out.manualClearFallbackAbandoned, null);
  assert.equal(out.routedPriorVerdicts.manualClearFallbackAttempts, 5);
  assert.equal(clearStaleScoringFailure(out), null, 'already repaired');
  assert.equal(out.routedPriorVerdicts.wrongProduction, true);
  assert.equal(moved.manualClearFallbackAbandoned, true, 'input must not be mutated');
  assert.equal(clearStaleScoringFailure({ ...moved, routedFromShowId: undefined }), null, 'never routed: the give-up state is real');
  assert.equal(clearStaleScoringFailure({ ...moved, wrongProduction: true }), null, 'flagged again: leave it');
  assert.equal(clearStaleScoringFailure({ showId: 'x', routedFromShowId: 'y' }), null, 'nothing to repair');
});

test('a stale TO_BE_CALCULATED placeholder is dropped once the moved file has its text', () => {
  const text = 'x'.repeat(300);
  const onTour = { showId: 'the-lion-king-tour-2021', routedFromShowId: 'the-lion-king-1997', scoreStatus: 'TO_BE_CALCULATED', fullText: text };
  const out = clearStaleScoringFailure(onTour);
  assert.equal(out.scoreStatus, null);
  assert.equal(out.routedPriorVerdicts.scoreStatus, 'TO_BE_CALCULATED');
  assert.equal(clearStaleScoringFailure({ ...onTour, fullText: 'short' }), null, 'no text yet: the placeholder is real');
  const moved = prepareTourMove({ showId: 'the-lion-king-1997', ...tourFlag, scoreStatus: 'TO_BE_CALCULATED', fullText: text },
    { fromShowId: 'the-lion-king-1997', tourId: 'the-lion-king-tour-2021' });
  assert.ok(!('scoreStatus' in moved));
});

test('a wrong_production rejection is set aside on the move; other rejections stand', () => {
  const base = { showId: 'shucked-2023', ...tourFlag, wrongFullText: 't' };
  const moved = prepareTourMove({ ...base, rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check', rejectionReasoning: 'touring, not Broadway' },
    { fromShowId: 'shucked-2023', tourId: 'shucked-tour-2024' });
  assert.ok(!('rejectionReason' in moved));
  assert.equal(moved.routedPriorVerdicts.rejectionReason, 'wrong_production');
  const kept = prepareTourMove({ ...base, rejectionReason: 'not_a_review' }, { fromShowId: 'shucked-2023', tourId: 'shucked-tour-2024' });
  assert.equal(kept.rejectionReason, 'not_a_review');
});

test('a closed tour: dated reviews long after closing stay put; undated ones move only if seen before closing', () => {
  const ctx = { tourLaunchDate: '2022-12-01', tourClosingDate: '2025-09-14' };
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2025-10-20' }, ctx).action, 'move'); // within 60 days
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2027-02-01' }, ctx).reason, 'after-tour-close');
  assert.equal(classifyTourBackfill({ ...tourFlag, firstSeenAt: '2024-03-01T00:00:00Z' }, ctx).action, 'move');
  assert.equal(classifyTourBackfill({ ...tourFlag, textFetchedAt: '2027-01-05T00:00:00Z' }, ctx).reason, 'undated-after-close');
  assert.equal(classifyTourBackfill({ ...tourFlag }, ctx).reason, 'undated-before-launch'); // never seen: unknown
  // An open tour keeps taking undated reviews found after it launched.
  assert.equal(classifyTourBackfill({ ...tourFlag, firstSeenAt: '2026-01-01T00:00:00Z' }, { tourLaunchDate: '2022-12-01' }).action, 'move');
});

test('an undated review found before the tour launched belongs to an earlier production (BRO-4325)', () => {
  // Real cases from the first sweep of the running tours: Waitress's 2016
  // Broadway review (found Feb 2026) against a tour launching Sep 2026, and a
  // Jersey Boys review from an older tour.
  const ctx = { broadwayOpeningDate: '2016-04-24', tourLaunchDate: '2026-09-18' };
  assert.equal(classifyTourBackfill({ ...tourFlag, urlDiscoveredAt: '2026-02-09T16:57:58Z', textFetchedAt: '2026-02-13T20:12:58Z' }, ctx).reason, 'undated-before-launch');
  // Waitress first opened ten years before this tour and toured in 2017: an
  // undated review can't be placed on the 2026 tour (BRO-4656).
  assert.equal(classifyTourBackfill({ ...tourFlag, urlDiscoveredAt: '2026-09-14T00:00:00Z' }, ctx).reason, 'undated-perennial');
  assert.equal(classifyTourBackfill({ ...tourFlag, urlDiscoveredAt: '2026-09-14T00:00:00Z' }, { ...ctx, broadwayOpeningDate: '2024-04-24' }).action, 'move', 'a week of slack for first-stop reviews');
  assert.equal(classifyTourBackfill({ ...tourFlag, urlDiscoveredAt: '2026-09-20T00:00:00Z' }, {}).reason, 'undated-before-launch', 'a tour with no launch date takes no undated review');
});

test('two tours of one title: an undated review is ambiguous', () => {
  assert.equal(classifyTourBackfill({ ...tourFlag }, { otherToursOfTitle: 1 }).reason, 'ambiguous-tour');
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2024-01-01' }, { otherToursOfTitle: 1 }).action, 'move');
});

test('planTourSweep: every Broadway production of the title, never other markets', () => {
  const shows = [
    { id: 'bj-2019', title: 'Beetlejuice', category: 'broadway', openingDate: '2019-04-25' },
    { id: 'bj-2022', title: 'Beetlejuice', category: 'broadway' },
    { id: 'bj-we-2026', title: 'Beetlejuice', category: 'west-end' },
    { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway' },
    { id: 'bj-tour-2022', title: 'Beetlejuice', category: 'tour', tourOf: 'bj-2019', status: 'closed', openingDate: '2022-12-01', closingDate: '2025-09-14' },
    { id: 'orphan-tour', title: 'X', category: 'tour', tourOf: 'missing' },
  ];
  const plans = planTourSweep(shows);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].fromIds, ['bj-2019', 'bj-2022']);
  assert.deepEqual(plans[0].ctx, { broadwayOpeningDate: '2019-04-25', firstBroadwayOpeningDate: '2019-04-25', tourLaunchDate: '2022-12-01', tourClosingDate: '2025-09-14', otherToursOfTitle: 0, nextTourLaunchDate: null, siblingTourUndated: false, stops: null, ukOutlets: null, genericVenues: null });
  const withStops = planTourSweep(shows, { schedules: { 'bj-tour-2022': { stops: [{ city: 'Denver, CO', venue: 'Buell Theatre', start: '2023-01-03', end: '2023-01-15' }] } } });
  assert.equal(withStops[0].ctx.stops.length, 1);
  // A second tour with no launch date yet: neither tour can take a review.
  const undated = planTourSweep([...shows, { id: 'bj-tour-2027', title: 'Beetlejuice', category: 'tour', tourOf: 'bj-2022', status: 'open' }]);
  assert.equal(undated.find(p => p.tourId === 'bj-tour-2027').ctx.otherToursOfTitle, 1);
  assert.equal(undated.find(p => p.tourId === 'bj-tour-2027').ctx.tourClosingDate, null);
  assert.ok(undated.every(p => p.ctx.siblingTourUndated));
});

test('two dated tours of one title: every dated review goes to exactly one', () => {
  const shows = [
    { id: 'sh-2023', title: 'Shucked', category: 'broadway', openingDate: '2023-04-04' },
    { id: 'sh-tour-2024', title: 'Shucked', category: 'tour', tourOf: 'sh-2023', status: 'closed', openingDate: '2024-10-20', closingDate: '2026-06-07' },
    { id: 'sh-tour-2027', title: 'Shucked', category: 'tour', tourOf: 'sh-2023', status: 'open', openingDate: '2026-07-15' },
  ];
  const [first, second] = ['sh-tour-2024', 'sh-tour-2027'].map(id => planTourSweep(shows).find(p => p.tourId === id));
  assert.equal(first.ctx.nextTourLaunchDate, '2026-07-15');
  // 2026-07-20 fits the first tour's close+60d AND the second's launch: only the second takes it.
  for (const date of ['2025-03-01', '2026-06-20', '2026-07-20', '2027-01-10']) {
    const takers = [first, second].filter(p => classifyTourBackfill({ ...tourFlag, publishDate: date }, p.ctx).action === 'move');
    assert.equal(takers.length, 1, `${date} -> ${takers.map(p => p.tourId)}`);
  }
});

test('decideTourSweep: one move per review URL across Broadway folders; filename collisions and URLs already on the tour stay put', () => {
  const r = (url, extra = {}) => ({ ...tourFlag, ...seen, url, ...extra });
  const folders = {
    'bj-tour': [{ file: 'post--a.json', data: r('https://post.example/review-1') }],
    'bj-2019': [{ file: 'post--b.json', data: r('https://post.example/review-1/') }], // already on the tour
    'bj-2022': [
      { file: 'gazette--jane.json', data: r('https://gazette.example/r') },
      { file: 'post--a.json', data: r('https://other.example/x') }, // same filename as a tour file
      { file: 'clean.json', data: { url: 'https://c.example', wrongProduction: false } },
    ],
    'bj-2025': [{ file: 'gazette--unknown.json', data: r('https://gazette.example/r') }], // same URL, other byline
  };
  const plan = { tourId: 'bj-tour', fromIds: ['bj-2019', 'bj-2022', 'bj-2025'], ctx: LIVE };
  const rows = decideTourSweep(plan, id => folders[id] || []);
  assert.deepEqual(rows.map(x => `${x.fromId}/${x.file}:${x.key}`), [
    'bj-2019/post--b.json:duplicate-on-tour',
    'bj-2022/gazette--jane.json:tour-review',
    'bj-2022/post--a.json:target-collision',
    'bj-2025/gazette--unknown.json:duplicate-on-tour',
  ]);
});

test('scheduled sweep holds a flood instead of moving it (BRO-4262)', async () => {
  const { sweepHoldReason } = await import('../../scripts/lib/tour-backfill.js').then(m => m.default || m);
  const rows = n => Array.from({ length: n }, () => ({ fromId: 'wicked-2003' }));
  assert.equal(sweepHoldReason(rows(3), ['wicked-2003'], () => 400), null);
  assert.match(sweepHoldReason(rows(21), ['wicked-2003'], () => 400), /cap 20/);
  assert.match(sweepHoldReason(rows(5), ['wicked-2003'], () => 30), /> 10%/);
  assert.equal(sweepHoldReason(rows(2), ['tiny-2024'], () => 4), null, 'two moves from a tiny folder is not a flood');
});

// BRO-4656 regressions, each from the live corpus.
const SPAMALOT = {
  broadwayOpeningDate: '2023-11-16', firstBroadwayOpeningDate: '2005-03-17', tourLaunchDate: '2025-12-01',
  stops: [
    { city: 'Hartford, CT', venue: 'The Bushnell', start: '2025-12-09', end: '2025-12-14' },
    { city: 'Rochester, NY', venue: 'Rochester Auditorium Theatre', start: '2026-01-13', end: '2026-01-18' },
  ],
};

test('an ambiguous "revival/tour" label is not tour evidence: 2023 Spamalot revival reviews stay off the tour', () => {
  // cititour / Daily Beast / Theatrely on spamalot-2005: undated, fetched in 2026.
  const revival = { wrongProduction: true, wrongProductionReason: 'BWW roundup from 2023 but show opened 2005 (18yr gap) — likely revival/tour review', textFetchedAt: '2026-02-25T21:36:53Z',
    fullText: 'Who am I to judge if Spamalot has a place on Broadway in 2023? The original staging has been recreated at the St. James Theatre.' };
  assert.equal(classifyTourBackfill(revival, SPAMALOT).reason, 'no-tour-evidence');
  // Even with tour words nearby, a review that says the show is back on Broadway stays.
  assert.equal(classifyTourBackfill({ ...revival, wrongProductionReason: 'Tour review', fullText: 'Spamalot returns to Broadway, before the tour.' }, SPAMALOT).reason, 'broadway-production');
});

test('a flag that never mentions a tour still moves when the text names a stop played on that date (BRO-4656)', () => {
  // Hartford Courant on spamalot-2023, flagged by the 2026-06-21 contamination audit.
  const hartford = { wrongProduction: true, wrongProductionReason: 'audit-2026-06-21-prior-production-contamination', publishDate: '2025-12-11',
    fullText: '"Spamalot" can be a lot. It plays the Bushnell in Hartford through Sunday.' };
  assert.deepEqual(classifyTourBackfill(hartford, SPAMALOT), { action: 'move', reason: 'tour-review' });
  assert.equal(matchStop(hartford, SPAMALOT.stops).city, 'Hartford, CT');
  // Same text a year later: no stop then, no tour words: stays.
  assert.equal(classifyTourBackfill({ ...hartford, publishDate: '2026-12-11' }, SPAMALOT).reason, 'flag-not-tour');
  // No flag at all is never touched.
  assert.equal(classifyTourBackfill({ ...hartford, wrongProduction: false }, SPAMALOT).reason, 'not-flagged');
  // Tour words alone also count (Wicked's Boston Globe review, empty reason).
  assert.equal(classifyTourBackfill({ wrongProduction: true, publishDate: '2022-06-10', fullText: 'the current touring production would be as outstanding' },
    { broadwayOpeningDate: '2003-10-30', tourLaunchDate: '2021-08-03' }).action, 'move');
});

test('London reviews of a later West End run never move to the US tour (Shucked 2025)', () => {
  const ctx = { broadwayOpeningDate: '2023-04-04', tourLaunchDate: '2024-10-20', ukOutlets: new Set(['telegraph']) };
  const london = { wrongProduction: true, wrongProductionReason: 'Date guard: review is 486d after close — likely different production', publishDate: '2025-05-21' };
  assert.equal(classifyTourBackfill({ ...london, outletId: 'telegraph', fullText: 'This touring cast, er, this new cast at Southwark' }, ctx).reason, 'uk-production');
  assert.equal(classifyTourBackfill({ ...london, outletId: 'everything-theatre', fullText: 'Shucked opens in London; the tour of corn jokes...' }, ctx).reason, 'uk-production');
});

test('undated reviews of a title with years of earlier tours stay put (Wicked, The Lion King)', () => {
  const wicked = { broadwayOpeningDate: '2003-10-30', firstBroadwayOpeningDate: '2003-10-30', tourLaunchDate: '2021-08-03' };
  const undated = { wrongProduction: true, firstSeenAt: '2026-02-01T00:00:00Z', fullText: 'the touring company of the musical WICKED' };
  assert.equal(classifyTourBackfill(undated, wicked).reason, 'undated-perennial');
  assert.equal(classifyTourBackfill({ ...undated, publishDate: '2024-01-30' }, wicked).action, 'move');
});

test('loadSweepContext reads schedules and London outlets; missing files give nulls', () => {
  const ctx = loadSweepContext('/nonexistent-root');
  assert.deepEqual({ ...ctx, genericVenues: [...ctx.genericVenues] }, { schedules: null, ukOutlets: null, genericVenues: [] });
});

test('a reviewed backlog passes the hard stop only while its approval holds (BRO-4656)', () => {
  const approvals = { approvals: [{ tourId: 'wicked-tour-2021', maxMoves: 8, expires: '2026-10-19', issue: 'BRO-4656' }] };
  const now = new Date('2026-10-06T00:00:00Z');
  const pending = Array.from({ length: 7 }, () => ({ fromId: 'wicked-2003' }));
  const size = () => 60;
  assert.match(sweepHoldReason(pending, ['wicked-2003'], size, sweepLimits(null, 'wicked-tour-2021', { now })), /> 10%/);
  assert.equal(sweepHoldReason(pending, ['wicked-2003'], size, sweepLimits(approvals, 'wicked-tour-2021', { now })), null);
  // More than reviewed, another tour, or after expiry: held as before.
  const nine = Array.from({ length: 9 }, () => ({ fromId: 'wicked-2003' }));
  assert.match(sweepHoldReason(nine, ['wicked-2003'], size, sweepLimits(approvals, 'wicked-tour-2021', { now })), /cap 8/);
  assert.equal(sweepLimits(approvals, 'six-tour-2022', { now }).approvedBy, undefined);
  assert.equal(sweepLimits(approvals, 'wicked-tour-2021', { now: new Date('2026-10-20T00:00:00Z') }).approvedBy, undefined);
});

test("a stop city the show's own reviews keep naming (its setting) matches by venue only", () => {
  const stops = [{ city: 'Tulsa, OK', venue: 'Tulsa PAC', start: '2025-10-07', end: '2025-10-12' }, { city: 'Austin, TX', venue: 'Bass Concert Hall', start: '2025-10-21', end: '2025-10-26' }];
  const bway = ['Ponyboy in 1960s Tulsa', 'the Tulsa greasers', 'Tulsa again', 'no city here', 'Broadway'];
  const setting = settingCitiesOf(stops, bway);
  assert.deepEqual([...setting], ['Tulsa']);
  const review = { publishDate: '2025-10-10', fullText: 'The Tulsa setting feels small.' };
  assert.equal(matchStop(review, stops, setting), null);
  assert.equal(matchStop({ ...review, fullText: 'rolled into Bass Concert Hall' }, stops, setting).city, 'Austin, TX');
});

test('tour integrity flags a tour-stop review on Broadway and a UK review on the tour, not look-alikes (BRO-4656)', () => {
  const stops = [{ city: 'Austin, TX', venue: 'Bass Concert Hall', start: '2025-10-21', end: '2025-10-26' }];
  const files = {
    'gatsby-2024': [
      { file: 'austin-chronicle--a.json', data: { publishDate: '2025-10-23', fullText: 'Gatsby glitters at Bass Concert Hall this week.' } },
      { file: 'nyt--b.json', data: { publishDate: '2024-04-25', fullText: 'On Broadway at the Broadway Theatre.' } },
      { file: 'austin-blog--c.json', data: { publishDate: '2025-10-22', fullText: 'Austin readers, see the Broadway show in New York.' } },
      { file: 'flagged.json', data: { wrongProduction: true, publishDate: '2025-10-23', fullText: 'Bass Concert Hall' } },
    ],
    'gatsby-tour-2026': [
      { file: 'hull--d.json', data: { outletId: 'hull-daily', url: 'https://hulldailymail.co.uk/x', fullText: 'at Hull New Theatre' } },
      { file: 'sun-times--e.json', data: { outletId: 'chicago-sun-times', url: 'https://suntimes.com/x', fullText: 'A West End hit now in Chicago.' } },
      { file: 'stage--f.json', data: { outletId: 'the-stage', url: 'https://thestage.com/x', fullText: 'Gatsby' } },
    ],
  };
  const plan = { tourId: 'gatsby-tour-2026', fromIds: ['gatsby-2024'], ctx: { stops, ukOutlets: new Set(['the-stage']) } };
  const rows = decideTourIntegrity(plan, id => files[id] || []);
  assert.deepEqual(rows.map(r => `${r.kind}:${r.file}`), ['tour-on-broadway:austin-chronicle--a.json', 'uk-on-tour:hull--d.json', 'uk-on-tour:stage--f.json']);
  assert.match(rows[0].reason, /Bass Concert Hall, Austin, TX stop \(2025-10-21\)/);
  const flagged = applyIntegrityFlag({ score: 80 }, rows[0], '2026-10-05T00:00:00Z');
  assert.equal(flagged.wrongProduction, true);
  assert.equal(flagged.wrongProductionDetectedBy, 'tour-integrity');
  assert.equal(flagged.score, 80);
});

test('stop matching survives the BRO-4656 review cases: London ON, shared venue names, inverted stops', () => {
  const stops = [
    { city: 'London, ON', venue: 'Budweiser Gardens', start: '2026-03-01', end: '2026-03-05' },
    { city: 'Kansas City, MO', venue: 'Music Hall', start: '2026-03-01', end: '2026-03-08' },
    { city: 'Dallas, TX', venue: 'Music Hall at Fair Park', start: '2026-01-01', end: '2026-01-08' },
    { city: 'Chicago, IL', venue: 'Cadillac Palace Theatre', start: '2026-03-10', end: '2026-01-14' },
  ];
  const generic = new Set(['Music Hall']);
  const at = (fullText) => ({ publishDate: '2026-03-04', fullText });
  // A West End review naming London is not the London, ON stop.
  assert.equal(matchStop(at('A night out in London at the Prince Edward.'), stops, null, generic), null);
  assert.equal(matchStop(at('Budweiser Gardens hosts the tour.'), stops, null, generic).city, 'London, ON');
  // "Music Hall" in Dallas text is not the Kansas City stop; with the city it is.
  assert.equal(matchStop(at('KERA: the Music Hall in Dallas.'), stops, null, generic), null);
  assert.equal(matchStop(at('At the Music Hall in Kansas City this week.'), stops, null, generic).city, 'Kansas City, MO');
  // An end before the start never matches.
  assert.equal(matchStop(at('Cadillac Palace Theatre, Chicago.'), stops, null, generic), null);
});

test('genericVenuesOf: a venue in two cities or a Broadway house name', () => {
  const tours = { a: { stops: [{ city: 'Denver, CO', venue: 'Orpheum Theatre' }, { city: 'Omaha, NE', venue: 'Orpheum Theatre' }, { city: 'Austin, TX', venue: 'Bass Concert Hall' }, { city: 'Boston, MA', venue: 'Majestic Theatre' }] } };
  const shows = { shows: [{ venue: 'Majestic Theatre', category: 'broadway' }] };
  assert.deepEqual([...genericVenuesOf(tours, shows)].sort(), ['Majestic Theatre', 'Orpheum Theatre']);
});

test('a London outlet never moves to the tour, even when its text names a stop', () => {
  const ctx = { stops: [{ city: 'Austin, TX', venue: 'Bass Concert Hall', start: '2025-10-21', end: '2025-10-26' }], ukOutlets: new Set(['the-stage']) };
  const data = { wrongProduction: true, wrongProductionReason: 'national tour', outletId: 'the-stage', publishDate: '2025-10-23', fullText: 'Bass Concert Hall' };
  assert.equal(classifyTourBackfill(data, ctx).reason, 'uk-production');
});

test('tour integrity leaves human-ruled and locked files alone; US Manchester is not UK', () => {
  const stops = [{ city: 'Austin, TX', venue: 'Bass Concert Hall', start: '2025-10-21', end: '2025-10-26' }];
  const text = { publishDate: '2025-10-23', fullText: 'Gatsby glitters at Bass Concert Hall this week.' };
  const files = {
    'gatsby-2024': [
      { file: 'a.json', data: { ...text, wrongProductionManualClear: true } },
      { file: 'b.json', data: { ...text, wrongProductionOverride: true } },
      { file: 'c.json', data: { ...text, humanReviewedWrongProduction: true } },
      { file: 'd.json', data: { ...text, _locked: true } },
    ],
    'gatsby-tour-2026': [
      { file: 'nh.json', data: { outletId: 'union-leader', url: 'https://unionleader.com/x', fullText: 'The tour plays Manchester this week.' } },
      { file: 'hull.json', data: { outletId: 'hull-daily', url: 'https://example.com/x', fullText: 'at Hull New Theatre', _locked: true } },
    ],
  };
  const plan = { tourId: 'gatsby-tour-2026', fromIds: ['gatsby-2024'], ctx: { stops, ukOutlets: new Set() } };
  assert.deepEqual(decideTourIntegrity(plan, id => files[id] || []), []);
});

test('a venue is matched without its leading "The" and in any case (BRO-4656 QA)', () => {
  // Trinity Tripod: "the Bushnell", no city named; schedule says "The Bushnell".
  const tripod = { wrongProduction: true, wrongProductionReason: 'audit-2026-06-21-prior-production-contamination', publishDate: '2025-12-12',
    fullText: 'The national tour of the 2023 Broadway revival takes the stage at the Bushnell this week.' };
  assert.equal(matchStop(tripod, SPAMALOT.stops)?.city, 'Hartford, CT');
  assert.deepEqual(classifyTourBackfill(tripod, SPAMALOT), { action: 'move', reason: 'tour-review' });
  // A venue name inside a longer word is not a mention.
  assert.equal(matchStop({ ...tripod, fullText: 'at the Bushnellville fair' }, SPAMALOT.stops), null);
  // The article must be there: a bare "Playhouse" is Paper Mill's, not Wilmington's "The Playhouse".
  const wilm = [{ city: 'Wilmington, DE', venue: 'The Playhouse', start: '2025-12-09', end: '2025-12-14' }];
  assert.equal(matchStop({ publishDate: '2025-12-10', fullText: 'a revival at Paper Mill Playhouse' }, wilm), null);
  assert.equal(matchStop({ publishDate: '2025-12-10', fullText: 'at the Playhouse on Rodney Square' }, wilm)?.city, 'Wilmington, DE');
});

test('Broadway history a tour review recounts does not hold it on Broadway; a Broadway return still does', () => {
  const base = { wrongProduction: true, wrongProductionReason: 'Collector LLM: wrong production (high) — evaluates the national touring production in Cleveland', publishDate: '2025-12-20' };
  const history = 'Shucked opened on Broadway in April of 2023 and ran through January 2024.';
  assert.equal(classifyTourBackfill({ ...base, fullText: history }, SPAMALOT).action, 'move', 'tour-specific reason outranks history');
  // A regional-desk URL is the only tour evidence: no tour reason, no tour words,
  // no stop. Then the history line is Broadway evidence.
  const bwwRegional = { wrongProduction: true, wrongProductionReason: 'Tour/regional/pre-Broadway production', showId: 'spamalot-2023',
    url: 'https://www.broadwayworld.com/cleveland/article/BWW-Review-SPAMALOT-x', publishDate: '2025-12-20' };
  assert.equal(classifyTourBackfill({ ...bwwRegional, fullText: history }, SPAMALOT).reason, 'broadway-production');
  assert.equal(classifyTourBackfill({ ...bwwRegional, fullText: 'A lively night out.' }, SPAMALOT).action, 'move');
  assert.equal(classifyTourBackfill({ ...base, fullText: 'Spamalot returns to Broadway this spring.' }, SPAMALOT).reason, 'broadway-production');
});

test('clearStaleScoringFailure leaves a give-up recorded after the move: no daily retry loop (BRO-4656 QA)', () => {
  const tourFile = { showId: 'spamalot-tour-2025', routedFromShowId: 'spamalot-2023', routedAt: '2026-10-05T19:30:15Z',
    manualClearFallbackFailedAt: '2026-10-07T03:00:00Z', manualClearFallbackAttempts: 1, routedPriorVerdicts: { manualClearFallbackAttempts: 5 } };
  assert.equal(clearStaleScoringFailure(tourFile), null);
  // Flagged-period give-up (before the move) is still cleared.
  assert.equal(clearStaleScoringFailure({ ...tourFile, manualClearFallbackFailedAt: '2026-08-05T21:23:59Z' }).manualClearFallbackAttempts, null);
});

test('an overseas production (.com.au, .de) never moves to the tour or stays on it; .ca and .com do (BRO-4656)', () => {
  const ctx = { stops: [{ city: 'Austin, TX', venue: 'Bass Concert Hall', start: '2025-10-21', end: '2025-10-26' }], ukOutlets: new Set() };
  const flag = { ...tourFlag, ...seen, publishDate: '2025-10-23', fullText: 'The national tour at Bass Concert Hall.' };
  assert.equal(classifyTourBackfill({ ...flag, url: 'https://australianpridenetwork.com.au/spamalot' }, ctx).reason, 'overseas-production');
  assert.equal(classifyTourBackfill({ ...flag, url: 'https://www.welt.de/x' }, ctx).reason, 'overseas-production');
  assert.equal(classifyTourBackfill({ ...flag, url: 'https://www.thestar.ca/x' }, ctx).action, 'move');
  const files = {
    'spamalot-tour-2025': [
      { file: 'apn.json', data: { outletId: 'australianpridenetwork', url: 'https://australianpridenetwork.com.au/x', fullText: 'Spamalot is a hoot.' } },
      { file: 'star.json', data: { outletId: 'toronto-star', url: 'https://www.thestar.com/x', fullText: 'Spamalot is a hoot.' } },
    ],
  };
  const plan = { tourId: 'spamalot-tour-2025', fromIds: [], ctx };
  assert.deepEqual(decideTourIntegrity(plan, id => files[id] || []).map(r => `${r.kind}:${r.file}`), ['uk-on-tour:apn.json']);
});

// ---- BRO-4931: tours of any market, and standalone tours --------------------

test('planTourSweep: an Off-Broadway parent sweeps its own market plus Broadway, never West End', () => {
  const shows = [
    { id: 'mex-off-broadway-2026', title: 'Mexodus', category: 'off-broadway', openingDate: '2026-03-01' },
    { id: 'mex-off-broadway-2023', title: 'Mexodus', category: 'off-broadway', openingDate: '2023-03-01' },
    { id: 'mex-2027', title: 'Mexodus', category: 'broadway', openingDate: '2027-03-01' },
    { id: 'mex-west-end-2026', title: 'Mexodus', category: 'west-end', openingDate: '2026-04-01' },
    { id: 'mex-regional-2022', title: 'Mexodus', category: 'regional', openingDate: '2022-04-01' },
    { id: 'other-off-broadway-2026', title: 'Other', category: 'off-broadway', openingDate: '2026-03-01' },
    { id: 'mex-tour-2026', title: 'Mexodus', category: 'tour', tourOf: 'mex-off-broadway-2026', openingDate: '2026-09-20' },
  ];
  const [plan] = planTourSweep(shows);
  assert.equal(plan.tourId, 'mex-tour-2026');
  assert.deepEqual(plan.fromIds, ['mex-2027', 'mex-off-broadway-2023', 'mex-off-broadway-2026']);
  assert.equal(plan.ctx.broadwayOpeningDate, '2026-03-01');
  assert.equal(plan.ctx.firstBroadwayOpeningDate, '2023-03-01');
  // A regional parent takes regional siblings.
  const regional = planTourSweep(shows.map(s => (s.id === 'mex-tour-2026' ? { ...s, tourOf: 'mex-regional-2022' } : s)))[0];
  assert.deepEqual(regional.fromIds, ['mex-2027', 'mex-regional-2022']);
});

test('planTourSweep: a standalone tour is planned with nothing to sweep, and does not disturb other tours', () => {
  const shows = [
    { id: 'p-2022', title: 'P', category: 'broadway', openingDate: '2022-01-01' },
    { id: 'p-tour-2024', title: 'P', category: 'tour', tourOf: 'p-2022', openingDate: '2024-01-01' },
    { id: 'elf-tour-2026', title: 'Elf', category: 'tour', tourScheduleSlug: 'elf', openingDate: '2026-09-20' },
    { id: 'dangling-tour-2026', title: 'D', category: 'tour', tourOf: 'missing-2020' },
  ];
  const plans = planTourSweep(shows);
  assert.deepEqual(plans.map(p => p.tourId).sort(), ['elf-tour-2026', 'p-tour-2024'], 'a dangling tourOf is still left out');
  const elf = plans.find(p => p.tourId === 'elf-tour-2026');
  assert.deepEqual(elf.fromIds, []);
  assert.equal(elf.ctx.broadwayOpeningDate, null);
  assert.equal(elf.ctx.otherToursOfTitle, 0);
  assert.deepEqual(decideTourSweep(elf, () => []), []);
  assert.equal(plans.find(p => p.tourId === 'p-tour-2024').ctx.otherToursOfTitle, 0, 'a tour of another title is not a sibling');
});
