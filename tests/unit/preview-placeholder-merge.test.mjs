/**
 * Unit tests for the isPreviewPlaceholder replacement path in mergeReviews().
 *
 * Design flaw: preview-period scraping creates files before opening night.
 * Opening-night dedup sees the file exists and skips creating a fresh file.
 * Fix: files created before openingDate carry isPreviewPlaceholder:true.
 * When mergeReviews() is called with { fromPostOpening: true }, the incoming
 * review replaces the placeholder wholesale instead of being merged into it.
 *
 * Run: node --test tests/unit/preview-placeholder-merge.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mergeReviews } = require('../../scripts/lib/review-normalization');

const placeholder = {
  url: 'https://nytimes.com/review-stub',
  outletId: 'nyt',
  criticName: 'Unknown',
  isPreviewPlaceholder: true,
  incompleteReason: 'preview-stub',
  wrongProduction: true,
  wrongProductionNote: 'Pre-opening guard',
};

const realReview = {
  url: 'https://nytimes.com/review-stub',
  outletId: 'nyt',
  criticName: 'Jesse Green',
  fullText: 'The show opened to rapturous applause...',
  publishDate: '2026-04-16',
};

describe('mergeReviews — placeholder replacement', () => {
  it('placeholder + post-opening real review → fully replaces (returns incoming)', () => {
    const result = mergeReviews(placeholder, realReview, { fromPostOpening: true });
    assert.strictEqual(result.fullText, realReview.fullText, 'fullText from incoming');
    assert.strictEqual(result.criticName, realReview.criticName, 'criticName from incoming');
    assert.strictEqual(result.incompleteReason, undefined, 'incompleteReason cleared');
    assert.strictEqual(result.isPreviewPlaceholder, undefined, 'isPreviewPlaceholder cleared');
    assert.strictEqual(result.wrongProduction, undefined, 'wrongProduction cleared');
  });

  it('placeholder + post-opening real review → result has no stale placeholder keys', () => {
    const result = mergeReviews(placeholder, realReview, { fromPostOpening: true });
    assert.ok(!('isPreviewPlaceholder' in result), 'no isPreviewPlaceholder key');
    assert.ok(!('wrongProductionNote' in result), 'no wrongProductionNote key');
  });

  it('placeholder + pre-opening discovery (no fromPostOpening) → preserves placeholder', () => {
    const preOpening = { url: 'https://nytimes.com/review-stub', outletId: 'nyt', dtliExcerpt: 'Preview buzz...' };
    const result = mergeReviews(placeholder, preOpening);
    assert.strictEqual(result.isPreviewPlaceholder, true, 'placeholder flag preserved');
    assert.strictEqual(result.wrongProduction, true, 'wrongProduction preserved');
    assert.strictEqual(result.dtliExcerpt, 'Preview buzz...', 'excerpt from incoming kept');
  });

  it('placeholder + post-opening but fromPostOpening explicitly false → preserves placeholder', () => {
    const result = mergeReviews(placeholder, realReview, { fromPostOpening: false });
    assert.strictEqual(result.isPreviewPlaceholder, true, 'placeholder flag preserved');
    assert.strictEqual(result.incompleteReason, 'preview-stub', 'incompleteReason preserved');
  });

  it('real review + post-opening discovery → keeps real (never replace real with anything)', () => {
    const existingReal = { url: 'https://nytimes.com/r', outletId: 'nyt', fullText: 'Original full review text.', criticName: 'Jesse Green' };
    const laterData = { url: 'https://nytimes.com/r', outletId: 'nyt', fullText: 'Shorter', criticName: 'Jesse Green' };
    const result = mergeReviews(existingReal, laterData, { fromPostOpening: true });
    // Real reviews never get replaced — normal merge keeps longer text
    assert.strictEqual(result.fullText, existingReal.fullText, 'longer existing fullText preserved');
    assert.strictEqual(result.isPreviewPlaceholder, undefined, 'no placeholder flag added');
  });

  it('no-flag + no-flag → current merge behavior (no regression)', () => {
    const a = { url: 'https://x.com/r', outletId: 'variety', criticName: 'Unknown' };
    const b = { url: 'https://x.com/r', outletId: 'variety', criticName: 'Peter Marks', fullText: 'Review text.' };
    const result = mergeReviews(a, b);
    assert.strictEqual(result.criticName, 'Peter Marks', 'Unknown upgraded from incoming');
    assert.strictEqual(result.fullText, 'Review text.', 'fullText from incoming');
    assert.strictEqual(result.isPreviewPlaceholder, undefined, 'no flag introduced');
  });
});
