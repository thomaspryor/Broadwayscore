// BRO-7197: on Wanted's opening night (wanted-2022, 2026-11-08) three pages that are not reviews sat in the census,
// held the score behind "Awaiting Reviews" with 18 reviews scored, and the TheaterMania video was ingested as a review.
// Run: node --test tests/unit/bro-7197-non-review-census-hold.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const urls = require('../../scripts/lib/non-review-url-patterns.js');
const { censusVerdictFor } = require('../../scripts/lib/gap-audit-merge.js');
const { classifyTimeoutListingBlurb } = require('../../scripts/lib/timeout-capsule.js');
const { isNamedNonReviewUrlRecord } = require('../../scripts/lib/review-guards.js');
const { laneNonReviewReason } = require('../../scripts/lib/opening-night-lane/lane-guards.js');
const { PROVENANCE_KEY } = require('../../scripts/lib/opening-night-lane/trust-model.js');
const {
  applyCoverageFloor, coverageHoldReleased, COVERAGE_HOLD_MAX_SCORED_REVIEWS, COVERAGE_HOLD_MAX_HOURS,
} = require('../../scripts/lib/coverage-floor.js');
const { buildMobileCriticScore } = require('../../scripts/lib/mobile-critic-score.js');

const TM_VIDEO = 'https://www.theatermania.com/news/watch-inside-wanted-on-broadway-with-stars-solea-pfeiffer-liisi-lafontaine-ledisi-more_1857127/';
const TIMEOUT_LISTING = 'https://www.timeout.com/newyork/theater/wanted';
const SS_LISTING = 'https://stageandstreetnyc.com/broadway/shows/wanted/';
const TM_REVIEW = 'https://www.theatermania.com/news/review-wanted-isnt-a-perfect-shot-but-its-leading-ladies-are_1859103/';

test('Wanted census pages: the video feature and the Stage and Street hub are refused as gap candidates', () => {
  assert.deepEqual(urls.classifyGapCandidateUrl(TM_VIDEO), { ok: false, reason: 'video-feature' });
  assert.deepEqual(urls.classifyGapCandidateUrl(SS_LISTING), { ok: false, reason: 'venue-production-page' });
  // The real TheaterMania review of the same show is untouched.
  assert.deepEqual(urls.classifyGapCandidateUrl(TM_REVIEW), { ok: true, reason: null });
  // Old TheaterMania reviews of "Watch on the Rhine" share the /news/watch- prefix; the 7-digit id keeps them ok.
  assert.equal(urls.classifyGapCandidateUrl('https://www.theatermania.com/news/watch-on-the-rhine_80029/').ok, true);
  // Its Off-Broadway show guides (/broadway/off-broadway/<slug>/, "Mexodus Off-Broadway Tickets & Show Guide") are the same kind.
  assert.equal(urls.classifyGapCandidateUrl('https://stageandstreetnyc.com/broadway/off-broadway/mexodus/').reason, 'venue-production-page');
  // A Stage and Street article (not a /shows/ hub) is untouched.
  assert.equal(urls.classifyGapCandidateUrl('https://stageandstreetnyc.com/2026/11/09/review-wanted-on-broadway/').ok, true);
});

test('Wanted census pages: the Time Out listing classifies as a listing blurb from its page (URL alone cannot tell)', () => {
  // 407 real Time Out reviews share this URL shape (BRO-5222), so the URL must stay a candidate...
  assert.equal(urls.classifyGapCandidateUrl(TIMEOUT_LISTING).ok, true);
  // ...and the page-level vet decides.
  const html = readFileSync(new URL('../fixtures/bro-7197/timeout-wanted-listing.html', import.meta.url), 'utf8');
  assert.equal(classifyTimeoutListingBlurb({ html, openingDate: '2026-11-08' }).verdict, 'listing_blurb');
});

test("Wanted's stored census row: the two URL-refused pages drop out of the verdict's candidates", () => {
  // The row as data/audit/show-review-gap.json held it at 2026-11-09T01:56Z (trimmed to the census fields).
  const row = {
    showId: 'wanted-2022', title: 'Wanted', category: 'broadway', openingDate: '2026-11-08',
    aggregatorArticles: [], aggregatorListedUrls: [TM_VIDEO, TIMEOUT_LISTING, SS_LISTING],
    missing: [
      { url: TM_VIDEO, host: 'theatermania.com', knownOutletId: 'theatermania', serpCensus: true },
      { url: TIMEOUT_LISTING, host: 'timeout.com', knownOutletId: 'timeout', serpCensus: true },
      { url: SS_LISTING, host: 'stageandstreetnyc.com', knownOutletId: null, serpCensus: true },
    ],
    flaggedMisses: [], citedNoUrl: [],
  };
  const v = censusVerdictFor(row);
  const candidateUrls = v.candidates.map((c) => c.url);
  assert.ok(!candidateUrls.includes(TM_VIDEO), 'video feature must not be a census candidate');
  assert.ok(!candidateUrls.includes(SS_LISTING), 'show hub must not be a census candidate');
});

test('the TheaterMania video page is rejected at ingest, at write time and in the lane', () => {
  assert.equal(urls.ingestRefusalReason(TM_VIDEO), 'video-feature');
  assert.equal(urls.ingestRefusalReason(SS_LISTING), 'venue-production-page');
  // Write path: allSources, so it is flagged whichever source wrote it (aggregator-cited included).
  assert.equal(isNamedNonReviewUrlRecord({ url: TM_VIDEO, source: 'gap-audit' }), true);
  assert.equal(isNamedNonReviewUrlRecord({ url: TM_REVIEW, source: 'gap-audit' }), false);
  // Lane: an aggregator-provenance row is held to allSources patterns only; the video is one of them.
  assert.match(laneNonReviewReason({ url: TM_VIDEO, [PROVENANCE_KEY]: { source: 'aggregator' } }) || '', /video-feature/);
});

const NOW = Date.parse('2026-11-09T04:00:00Z');

test('coverage hold cannot hide a score once 8+ reviews are scored', () => {
  assert.equal(COVERAGE_HOLD_MAX_SCORED_REVIEWS, 8);
  const held = { coverageState: 'incomplete', coverageAcked: false, openingDate: '2026-11-08', now: NOW };
  // Wanted at 04:00Z: 18 scored, census incomplete, never public, not acked -> score shows.
  assert.equal(applyCoverageFloor(false, { ...held, scoredReviewCount: 18 }), false);
  assert.equal(applyCoverageFloor(false, { ...held, scoredReviewCount: 8 }), false);
  // Below the bar on opening night, the hold still applies.
  assert.equal(applyCoverageFloor(false, { ...held, scoredReviewCount: 7 }), true);
  // No count passed (old callers): unchanged behaviour.
  assert.equal(applyCoverageFloor(false, { coverageState: 'incomplete', now: NOW }), true);
  // The ceiling never overrides the review-count gate itself.
  assert.equal(applyCoverageFloor(true, { ...held, scoredReviewCount: 18 }), true);
});

test('coverage hold releases after the time limit even below the count', () => {
  const open = '2026-11-01';
  const after = Date.parse(open) + (COVERAGE_HOLD_MAX_HOURS + 1) * 3600 * 1000;
  const before = Date.parse(open) + (COVERAGE_HOLD_MAX_HOURS - 1) * 3600 * 1000;
  assert.equal(coverageHoldReleased({ scoredReviewCount: 3, openingDate: open, now: after }), true);
  assert.equal(coverageHoldReleased({ scoredReviewCount: 3, openingDate: open, now: before }), false);
  assert.equal(applyCoverageFloor(false, { coverageState: 'incomplete', scoredReviewCount: 3, openingDate: open, now: after }), false);
});

test('app feed: buildMobileCriticScore applies the same ceiling (pq=1 for a held show with 8+ scored)', () => {
  const show = { id: 'wanted-2022', category: 'broadway', status: 'open', openingDate: '2026-11-08', previewsStartDate: '2026-10-15' };
  const reviews = Array.from({ length: 9 }, (_, i) => ({
    showId: 'wanted-2022', outletId: `outlet-${i}`, outlet: `Outlet ${i}`, criticName: `Critic ${i}`,
    assignedScore: 60 + i, tier: 1, url: `https://example${i}.com/review-wanted`,
  }));
  const r = buildMobileCriticScore(show, reviews, {}, { coverageState: 'incomplete', coverageAcked: false, now: NOW });
  assert.ok(r, 'score computed');
  assert.ok(r.rc >= 8, `rc=${r.rc}`);
  assert.equal(r.pq, 1);
});
