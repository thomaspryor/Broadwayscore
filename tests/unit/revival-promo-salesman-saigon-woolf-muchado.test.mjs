/**
 * BRO-4890 (revival promo: Salesman, Saigon, Woolf, Much Ado): acceptance tests
 * for the two inclusion rules the audit found missing. Per CLAUDE.md rule 15
 * these require() the real functions.
 *
 *  - a production cancelled before it ever opened (cancelledBeforeOpening) cannot
 *    carry counted reviews (whos-afraid-of-virginia-woolf-2020 carried a 2005 one);
 *  - a row known only from a search hit, with no url and no stored text, is not
 *    counted (a-christmas-carol-2019 Vulture, into-the-woods-2022 Talkin' Broadway).
 *
 * The rebuild loop does NOT delegate to explainExclusion, and scoring-delta.js
 * keeps its own decideInclusion mirror, so each rule is also pinned in both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guards = require('../../scripts/lib/review-guards.js');
const { decideInclusion } = require('../../scripts/scoring-delta.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { isCancelledBeforeOpeningShow, isUnverifiableWebSearchRow, explainExclusion } = guards;

const SCORED = { outletId: 'nytg', criticName: 'Unknown', assignedScore: 78, contentTier: 'complete', fullText: 'x'.repeat(4000), url: 'https://www.newyorktheatreguide.com/reviews/whos-afraid' };
const OPENED = { id: 'whos-afraid-of-virginia-woolf-2005', category: 'broadway', previewsStartDate: '2005-03-12', openingDate: '2005-03-20', closingDate: '2005-09-04' };
const NEVER_OPENED = { id: 'whos-afraid-of-virginia-woolf-2020', category: 'broadway', previewsStartDate: '2020-03-03', openingDate: null, closingDate: '2020-03-17', cancelledBeforeOpening: true };

test('cancelledBeforeOpening: only an explicit true flag marks a show', () => {
  assert.equal(isCancelledBeforeOpeningShow(NEVER_OPENED), true);
  assert.equal(isCancelledBeforeOpeningShow(OPENED), false);
  assert.equal(isCancelledBeforeOpeningShow({ ...OPENED, cancelledBeforeOpening: 'true' }), false);
  assert.equal(isCancelledBeforeOpeningShow(null), false);
});

test('a never-opened production cannot carry counted reviews', () => {
  assert.equal(explainExclusion(SCORED, NEVER_OPENED), 'cancelledBeforeOpening');
  assert.equal(guards.isIncludableForRebuild(SCORED, NEVER_OPENED), false);
  // The same review on a show that did open is not caught by this rule.
  assert.notEqual(explainExclusion(SCORED, OPENED), 'cancelledBeforeOpening');
});

const SEARCH_ROW = { outletId: 'timeout', criticName: 'Adam Feldman', source: 'web-search', sources: ['web-search'], assignedScore: 81, contentTier: 'excerpt', fullText: '' };

test('web-search row with no url and no text is unverifiable', () => {
  assert.equal(isUnverifiableWebSearchRow(SEARCH_ROW), true);
  assert.equal(isUnverifiableWebSearchRow({ ...SEARCH_ROW, sources: undefined, source: 'serp-discovery' }), true, 'canonical unvetted SERP sources count');
  assert.equal(isUnverifiableWebSearchRow({ ...SEARCH_ROW, sources: ['broad-web-serp', 'web-search'] }), true);
  assert.equal(explainExclusion(SEARCH_ROW, OPENED), 'unverifiableWebSearchRow');
});

test('web-search rule: a url, stored text, an aggregator source or a human override each keep the row', () => {
  assert.equal(isUnverifiableWebSearchRow({ ...SEARCH_ROW, url: 'https://www.timeout.com/newyork/theater/x-review' }), false, 'has a url');
  assert.equal(isUnverifiableWebSearchRow({ ...SEARCH_ROW, fullText: 'y'.repeat(200) }), false, 'has stored text');
  assert.equal(isUnverifiableWebSearchRow({ ...SEARCH_ROW, sources: ['web-search', 'show-score'] }), false, 'aggregator-backed stub');
  assert.equal(isUnverifiableWebSearchRow({ ...SEARCH_ROW, source: 'bww-roundup', sources: undefined }), false);
  assert.equal(isUnverifiableWebSearchRow({ ...SEARCH_ROW, humanReviewScore: 80 }), false, 'human score');
  assert.equal(isUnverifiableWebSearchRow({ ...SEARCH_ROW, adjudicatedScore: 80 }), false, 'adjudicated score');
  assert.equal(isUnverifiableWebSearchRow({ ...SEARCH_ROW, source: undefined, sources: undefined }), false, 'no provenance at all is not this rule');
  assert.equal(isUnverifiableWebSearchRow(null), false);
});

test('rebuild-all-reviews.js enforces both rules in its main loop, ahead of the flag-writing branches', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'rebuild-all-reviews.js'), 'utf8');
  assert.match(src, /if \(isCancelledBeforeOpeningShow\(showById\[showId\]\)\) \{\s*logExclusion\("skippedCancelledBeforeOpening"/);
  assert.match(src, /if \(isUnverifiableWebSearchRow\(data\)\) \{\s*logExclusion\("skippedUnverifiableWebSearchRow"/);
  const nonReview = src.indexOf('logExclusion("skippedNonReview"');
  assert.ok(nonReview > 0);
  assert.ok(src.indexOf('isCancelledBeforeOpeningShow(showById[showId])') < nonReview);
  assert.ok(src.indexOf('isUnverifiableWebSearchRow(data)') < nonReview);
});

test('scoring-delta decideInclusion replays both rules, and flips when the predicates change', () => {
  const withRules = decideInclusion(SCORED, NEVER_OPENED, guards);
  assert.deepEqual(withRules, { included: false, reason: 'cancelledBeforeOpening' });
  assert.deepEqual(decideInclusion(SEARCH_ROW, OPENED, guards), { included: false, reason: 'unverifiableWebSearchRow' });
  // A guards module without the predicates (the baseline before this change) includes both.
  const before = { ...guards, isCancelledBeforeOpeningShow: undefined, isUnverifiableWebSearchRow: undefined };
  assert.equal(decideInclusion(SCORED, NEVER_OPENED, before).included, true);
  assert.equal(decideInclusion(SEARCH_ROW, OPENED, before).included, true);
});
