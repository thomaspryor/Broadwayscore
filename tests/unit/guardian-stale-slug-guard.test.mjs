/**
 * Guards date-guard.js `isArticleOutsideProductionWindow`, used by
 * fetch-guardian-reviews.js to reject a prior-production article body that the
 * Guardian Open Platform API returns when a revival's stored URL still points at an
 * earlier production's slug.
 *
 * Rationale (Notion 386637c5-416f-81ca): the 2026 Glengarry Glen Ross WE entry (Old
 * Vic, all-female, previews 2026-06-04) was served the 2017 Christian Slater Playhouse
 * review because its stored URL was the 2017 slug. The 2017 body was stored as fullText
 * and — though correctly flagged wrongProduction — the real 2026 review was never
 * fetched, so the show silently lost its Guardian review. This guard makes the fetcher
 * refuse the stale body. Must honor priorRun coverage (legitimate same-production
 * history) and never reject a current-window article.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isArticleOutsideProductionWindow } = require('../../scripts/lib/date-guard.js');

const glengarryWE = {
  id: 'glengarry-glen-ross-west-end-2026',
  category: 'west-end',
  previewsStartDate: '2026-06-04',
  openingDate: '2026-06-17',
  closingDate: '2026-07-18',
  priorRuns: [],
};

const revivalWithPriorRun = {
  id: 'demo-revival',
  category: 'off-broadway',
  previewsStartDate: '2026-03-17',
  openingDate: '2026-03-17',
  closingDate: '2026-04-30',
  priorRuns: [{ openingDate: '2025-04-01', closingDate: '2025-06-30' }],
};

describe('isArticleOutsideProductionWindow', () => {
  test('rejects a years-old prior-production article (the Glengarry 2017 case)', () => {
    assert.equal(isArticleOutsideProductionWindow(glengarryWE, '2017-11-12'), true);
  });

  test('accepts the current-production review at opening', () => {
    assert.equal(isArticleOutsideProductionWindow(glengarryWE, '2026-06-17'), false);
  });

  test('accepts a review in the UK preview grace window', () => {
    assert.equal(isArticleOutsideProductionWindow(glengarryWE, '2026-05-20'), false);
  });

  test('accepts an article that falls within a declared priorRun', () => {
    assert.equal(isArticleOutsideProductionWindow(revivalWithPriorRun, '2025-05-08'), false);
  });

  test('rejects an article before the priorRun too', () => {
    assert.equal(isArticleOutsideProductionWindow(revivalWithPriorRun, '2020-01-01'), true);
  });

  test('returns false for missing/garbage input rather than throwing', () => {
    assert.equal(isArticleOutsideProductionWindow(glengarryWE, null), false);
    assert.equal(isArticleOutsideProductionWindow(glengarryWE, 'not-a-date'), false);
    assert.equal(isArticleOutsideProductionWindow(null, '2017-11-12'), false);
  });
});
