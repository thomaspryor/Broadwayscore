/**
 * Regression test for BRO-916: BWW Review Roundup includes wrong-production
 * reviews from prior runs.
 *
 * Incident: "The Fear of 13" BWW Review Roundup page included a review from
 * Alexander Cohen — a real, named critic — that was actually written about
 * the LONDON production. His byline on BWW's own page was "BroadwayWorld"
 * (BWW's UK edition, not a distinct third-party outlet), so the existing
 * geography filter (validateBWWRoundupGeography, which filters by outlet
 * region/domain) never caught it. The existing per-review URL-date guard
 * (getWrongProductionReasonForUnknownCritic, scripts/lib/review-guards.js)
 * also missed it because it deliberately only fires for Unknown/Staff
 * bylines — named critics get the benefit of the doubt for organic
 * pre-transfer journalism. Neither guard applies to BWW RR's real failure
 * mode: the roundup PAGE mis-attributing an anchor/JSON-LD entry from a
 * different production, independent of how the critic bylined their own
 * writing.
 *
 * Tests scripts/lib/review-guards.js's getWrongProductionReasonForBww
 * — the new guard gather-reviews.js's createReviewFile() runs on every
 * bww-roundup-sourced review, regardless of criticName. Requires the real
 * function (CLAUDE.md rule 15) rather than re-implementing the date-window
 * logic here, and reads real show data via production-verifier.js's
 * getShowData rather than hand-parsing data/shows.json, matching the
 * pattern in scripts/gather-reviews.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getShowData } from './lib/production-verifier.js';
import { getWrongProductionReasonForBww } from './lib/review-guards.js';

const SHOW_ID = 'the-fear-of-13-2026';

test('flags a named-critic BWW RR review whose URL date is outside the show window', () => {
  const show = getShowData(SHOW_ID);
  assert.ok(show, `expected ${SHOW_ID} to exist in data/shows.json`);
  assert.equal(show.previewsStartDate, '2026-03-19');
  assert.equal(show.openingDate, '2026-04-15');

  // Shape of the incident review: real named critic, BWW's own byline, URL
  // dated to a 2019 West End run — 30+ days before the Broadway show's window.
  const review = {
    source: 'bww-roundup',
    outlet: 'BroadwayWorld',
    outletId: 'broadwayworld',
    criticName: 'Alexander Cohen',
    url: 'https://www.broadwayworld.com/west-end/article/2019/09/15/BWW-Review-THE-FEAR-OF-13-London.html',
  };

  const reason = getWrongProductionReasonForBww(review, show);
  assert.ok(reason, 'expected a wrongProduction reason to be returned');
  assert.match(reason, /^Auto-flagged:/, 'reason must keep the Auto-flagged prefix so wrong-production-autoclear.js can still recognize it as auto-clear-eligible');
});

test('does not flag a BWW RR review whose URL date falls inside the show window', () => {
  const show = getShowData(SHOW_ID);
  assert.ok(show);

  const review = {
    source: 'bww-roundup',
    outlet: 'New York Theatre Guide',
    outletId: 'ny-theatre-guide',
    criticName: 'Some Critic',
    url: 'https://nytheatreguide.com/reviews/2026/04/16/the-fear-of-13-review',
  };

  assert.equal(getWrongProductionReasonForBww(review, show), null);
});

test('does not fire for non-bww-roundup sources, even with the same out-of-window URL', () => {
  const show = getShowData(SHOW_ID);
  assert.ok(show);

  const review = {
    source: 'serp',
    outlet: 'BroadwayWorld',
    outletId: 'broadwayworld',
    criticName: 'Alexander Cohen',
    url: 'https://www.broadwayworld.com/west-end/article/2019/09/15/BWW-Review-THE-FEAR-OF-13-London.html',
  };

  // Scoped deliberately to review.source === 'bww-roundup' — other ingest
  // paths keep relying on getWrongProductionReasonForUnknownCritic's
  // named-critic exemption, which this new guard must not silently widen.
  assert.equal(getWrongProductionReasonForBww(review, show), null);
});

// BroadwayWorld's OWN articles (as opposed to a linked external outlet) use a
// trailing -YYYYMMDD slug with no slash-delimited date segment — the actual
// shape of a BWW-self-bylined entry ("BroadwayWorld" outlet, no third party),
// which is what Alexander Cohen's byline in the real incident was. The
// slash-dated regex above doesn't match this shape at all, so this needs its
// own fallback (bwwTrailingDateFromUrl in review-guards.js).
test('flags a BWW-hosted URL (trailing -YYYYMMDD slug) whose date is outside the show window', () => {
  const show = getShowData(SHOW_ID);
  assert.ok(show);

  const review = {
    source: 'bww-roundup',
    outlet: 'BroadwayWorld',
    outletId: 'broadwayworld',
    criticName: 'Alexander Cohen',
    url: 'https://www.broadwayworld.com/westend/article/BWW-Review-THE-FEAR-OF-13-at-the-Everyman-Theatre-20190915',
  };

  const reason = getWrongProductionReasonForBww(review, show);
  assert.ok(reason, 'expected the BWW trailing-date fallback to catch this');
  assert.match(reason, /^Auto-flagged:/);
});

test('does not flag a BWW-hosted URL (trailing -YYYYMMDD slug) whose date is inside the show window', () => {
  const show = getShowData(SHOW_ID);
  assert.ok(show);

  const review = {
    source: 'bww-roundup',
    outlet: 'BroadwayWorld',
    outletId: 'broadwayworld',
    criticName: 'Some Critic',
    url: 'https://www.broadwayworld.com/article/BWW-Review-THE-FEAR-OF-13-Opens-on-Broadway-20260416',
  };

  assert.equal(getWrongProductionReasonForBww(review, show), null);
});

test('does not apply the BWW trailing-date fallback to a non-broadwayworld.com URL', () => {
  const show = getShowData(SHOW_ID);
  assert.ok(show);

  // Same out-of-window-looking trailing digits as the BWW test above, but on
  // a non-BWW domain — a trailing 8-digit number there is not necessarily a
  // date (could be a CMS post ID), so the fallback must stay scoped to BWW's
  // own domain and NOT flag this, even though the digits would parse as a
  // valid, out-of-window date if the domain check were missing.
  const review = {
    source: 'bww-roundup',
    outlet: 'Some Other Outlet',
    outletId: 'some-other-outlet',
    criticName: 'Some Critic',
    url: 'https://www.someoutlet.com/reviews/fear-of-13-20190915',
  };

  assert.equal(getWrongProductionReasonForBww(review, show), null);
});
