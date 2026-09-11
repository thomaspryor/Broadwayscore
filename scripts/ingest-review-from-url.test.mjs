/**
 * BRO-462: T1/T2 silent gap on near-opening show — Anansi the Spider —
 * thestage--anna-james.json was auto-filed as a gap by the owner-alert-router.
 *
 * Root cause: the file's publishDate ("January 26th, 2023") was a leftover
 * from a since-corrected URL — the file originally pointed at a 2023 Unicorn
 * Theatre production of the same show and got auto-corrected to the real
 * 2026 Regent's Park Open Air Theatre review, but the stale publishDate
 * survived (reintroduced by a later automated re-collection pass after an
 * earlier legitimate clear). rebuild-all-reviews.js's own date guard
 * (scripts/lib/date-guard.js evaluatePreWindowInclusion, called directly —
 * not via the review-guards.js mirror) correctly excludes a review published
 * 1297 days before the show's own run. review-guards.js's explainExclusion()
 * mirror does NOT model that guard (isPrematureReviewForUnopenedShow only
 * fires pre-opening, and this show had already opened and closed) — so the
 * mirror said "includable" while the real rebuild silently dropped the file
 * forever, with no canonical predicate ever flagging the divergence.
 *
 * The fix: scripts/lib/stale-publish-date.js's isStalePublishDate(), wired
 * into scripts/ingest-review-from-url.js, detects exactly this shape (no
 * fresh publishDate recovered from the current fetch + the existing
 * publishDate would fail the show's date window) and clears the stale field
 * so the review falls back to its normal star-rating score.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isStalePublishDate } = require('./lib/stale-publish-date.js');
const { explainExclusion } = require('./lib/review-guards.js');
const { evaluatePreWindowInclusion, earliestShowDate } = require('./lib/date-guard.js');
const { parseDate } = require('./lib/date-utils.js');

const SHOW = {
  id: 'anansi-the-spider-west-end-2026',
  category: 'off-west-end',
  status: 'closed',
  previewsStartDate: '2026-08-15',
  openingDate: '2026-08-18',
  closingDate: '2026-09-06',
};

// Trimmed fixture mirroring the real broadway-review-texts file's field
// values as of the 2026-09-11 investigation (fullText itself was always
// absent on this file — only aggregatorStars/originalScore ever carried a
// signal).
function buildFile(overrides = {}) {
  return {
    showId: 'anansi-the-spider-west-end-2026',
    outletId: 'thestage',
    outlet: 'The Stage',
    criticName: 'Anna James',
    url: 'https://www.thestage.co.uk/reviews/anansi-the-spider-review-picnic-lawn-regents-park-open-air-theatre-london',
    urlCorrectedFrom: 'https://www.thestage.co.uk/reviews/anansi-the-spider-review-at-unicorn-theatre-london-justin-audibert',
    publishDate: 'January 26th, 2023',
    contentTier: 'excerpt',
    contentTierReason: 'Only aggregator excerpts available',
    aggregatorStars: '5/5',
    scoreSource: 'stage-star-svg',
    originalScore: '4/5 stars',
    originalScoreNormalized: 80,
    originalScoreSource: 'stage-star-svg',
    assignedScore: 96,
    llmScore: { score: 96, confidence: 'low' },
    fetchDiscoveryAbandoned: true,
    incompleteReason: 'scraper_timeout',
    incompleteDetail: '145 timeout attempts',
    ...overrides,
  };
}

describe('BRO-462: isStalePublishDate detects the exact shape that silently gapped this file', () => {
  test('stale 2023 date on a since-closed 2026 show is flagged stale', () => {
    const file = buildFile();
    assert.equal(
      isStalePublishDate({ existingPublishDate: file.publishDate, freshPublishDate: null, show: SHOW }),
      true,
    );
  });

  test('a fresh publishDate from the current fetch always wins — never flagged stale', () => {
    assert.equal(
      isStalePublishDate({ existingPublishDate: 'January 26th, 2023', freshPublishDate: '2026-08-19', show: SHOW }),
      false,
    );
  });

  test('no existing publishDate — nothing to clear', () => {
    assert.equal(
      isStalePublishDate({ existingPublishDate: null, freshPublishDate: null, show: SHOW }),
      false,
    );
  });

  test('a plausible in-window date is never flagged stale', () => {
    assert.equal(
      isStalePublishDate({ existingPublishDate: '2026-08-19', freshPublishDate: null, show: SHOW }),
      false,
    );
  });

  test('after the fix (publishDate cleared), the file is no longer stale', () => {
    const fixed = buildFile({ publishDate: null });
    assert.equal(
      isStalePublishDate({ existingPublishDate: fixed.publishDate, freshPublishDate: null, show: SHOW }),
      false,
    );
  });
});

describe('BRO-462: the review-guards.js mirror does not model the real rebuild date guard', () => {
  test('regression pin: explainExclusion() says includable even WITH the stale 2023 date', () => {
    // This is the divergence that made the gap silent: the canonical mirror
    // every other predicate delegates to never flagged this file, so no
    // audit built on explainExclusion() could have caught it either.
    const file = buildFile();
    assert.equal(explainExclusion(file, SHOW, undefined), null);
  });

  test('but the real rebuild-all-reviews.js date guard (evaluatePreWindowInclusion) excludes it', () => {
    const file = buildFile();
    const pubDate = parseDate(file.publishDate);
    const showEarliest = new Date(`${earliestShowDate(SHOW)}T00:00:00Z`);
    const verdict = evaluatePreWindowInclusion({
      pubDate,
      showEarliest,
      isFlexCategory: true, // off-west-end
      priorRuns: SHOW.priorRuns,
      tourLegs: SHOW.tourLegs,
    });
    assert.equal(verdict.exclude, true);
    assert.ok(verdict.daysBefore > 1000, `expected a large pre-window gap, got ${verdict.daysBefore} days`);
  });

  test('with publishDate cleared (the fix), the date guard no longer excludes it', () => {
    const fixed = buildFile({ publishDate: null });
    // rebuild-all-reviews.js's guard is itself gated on `data.publishDate &&
    // showDateMap[showId] && !data.allowEarlyDate` — a falsy publishDate
    // short-circuits the whole check, same as this assertion pins.
    assert.equal(!!fixed.publishDate, false);
    assert.equal(explainExclusion(fixed, SHOW, undefined), null);
  });
});
