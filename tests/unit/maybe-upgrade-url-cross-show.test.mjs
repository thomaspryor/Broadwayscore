/**
 * Unit tests for maybeUpgradeUrl + slugLooksLikeDifferentShow
 * (scripts/lib/review-normalization.js).
 *
 * Incident 2026-06-04 (War Horse, Notion 375637c5-416f-8185-a139-d731a3786c0b):
 * theatre.reviews served a COMBINED roundup for two shows opening together
 * (War Horse + Equus). The TR parser surfaced an Equus URL/excerpt as a
 * candidate for a WhatsOnStage *War Horse* review. The review's real WhatsOnStage
 * URL had a bad (cookie-walled) scrape, so maybeUpgradeUrl() — which only checked
 * "is the current content bad?" — happily swapped war-horse → equus. The result
 * was a War Horse review file pointing at an Equus article, flagged wrongShow,
 * silently suppressing the real review and undercounting War Horse's reviews.
 *
 * The fix: maybeUpgradeUrl (and the empty-fill path) must refuse a candidate URL
 * whose slug clearly identifies a DIFFERENT show than the review's show.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { maybeUpgradeUrl, slugLooksLikeDifferentShow } = require('../../scripts/lib/review-normalization.js');

const WAR_HORSE_URL =
  'https://www.whatsonstage.com/news/war-horse-at-the-national-theatre-review-still-a-theatrical-miracle_1722745/';
const EQUUS_URL =
  'https://www.whatsonstage.com/news/equus-at-menier-chocolate-factory-review_1721972/';

function warHorseReview() {
  return {
    showId: 'war-horse-west-end-2026',
    url: WAR_HORSE_URL,
    fullText: null,
    needsRefetch: true, // bad content → eligible for upgrade
  };
}

describe('maybeUpgradeUrl cross-show guard', () => {
  test('REFUSES swapping a War Horse review to an Equus URL (the incident)', () => {
    const r = warHorseReview();
    const upgraded = maybeUpgradeUrl(r, EQUUS_URL, 'theatre-reviews', { showTitle: 'War Horse' });
    assert.equal(upgraded, false, 'must not upgrade to a different-show URL');
    assert.equal(r.url, WAR_HORSE_URL, 'original War Horse URL must be preserved');
    assert.equal(r.urlCorrectedFrom, undefined, 'no correction metadata should be written');
  });

  test('REFUSES even without a showTitle, falling back to the existing slug', () => {
    const r = warHorseReview();
    const upgraded = maybeUpgradeUrl(r, EQUUS_URL, 'theatre-reviews', {});
    assert.equal(upgraded, false);
    assert.equal(r.url, WAR_HORSE_URL);
  });

  test('ALLOWS a genuine same-show URL upgrade', () => {
    const r = warHorseReview();
    const better = 'https://www.whatsonstage.com/news/war-horse-national-theatre-review_999.html';
    const upgraded = maybeUpgradeUrl(r, better, 'theatre-reviews', { showTitle: 'War Horse' });
    assert.equal(upgraded, true, 'same-show URL should be accepted');
    assert.equal(r.url, better);
    assert.equal(r.needsRefetch, true);
  });

  test('does NOT upgrade when current content is already complete', () => {
    const r = {
      showId: 'war-horse-west-end-2026',
      url: 'https://a.com/war-horse-review',
      fullText: 'x'.repeat(500),
      contentTier: 'complete',
    };
    const upgraded = maybeUpgradeUrl(r, 'https://a.com/war-horse-review-2', 'theatre-reviews', { showTitle: 'War Horse' });
    assert.equal(upgraded, false);
  });

  test('ALLOWS short-distinctive-token shows (Six) to upgrade legitimately', () => {
    const r = { showId: 'six-2022', url: 'https://x.com/six-the-musical-review', fullText: null, needsRefetch: true };
    const upgraded = maybeUpgradeUrl(r, 'https://y.com/six-musical-review-london', 'theatre-reviews', { showTitle: 'Six' });
    assert.equal(upgraded, true);
  });
});

describe('slugLooksLikeDifferentShow predicate', () => {
  test('flags an Equus URL as a different show than War Horse', () => {
    assert.equal(slugLooksLikeDifferentShow(EQUUS_URL, { showTitle: 'War Horse' }), true);
  });

  test('does not flag a War Horse URL against War Horse', () => {
    assert.equal(slugLooksLikeDifferentShow(WAR_HORSE_URL, { showTitle: 'War Horse' }), false);
  });

  test('fails open when the candidate URL has no distinctive tokens', () => {
    // Only generic words (review) — no confident signal → must not block.
    assert.equal(slugLooksLikeDifferentShow('https://w.com/news/review', { showTitle: 'War Horse' }), false);
  });

  test('fails open when no reference (title or existing URL) is available', () => {
    assert.equal(slugLooksLikeDifferentShow(EQUUS_URL, {}), false);
  });
});
