/**
 * Integration tests for roundup URL content validation
 *
 * Tests the full validation path: shouldValidateUrl() decision +
 * validatePageMatchesShow() content checking against real HTML.
 * No network calls — uses synthetic HTML to verify the pipeline.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldValidateUrl } = require('../../scripts/gather-reviews.js');
const { validatePageMatchesShow } = require('../../scripts/lib/page-validator.js');

/**
 * Simulate the Step 3 URL validation logic from gatherReviewsForShow.
 * This mirrors the real code path but uses provided HTML instead of fetchPage().
 */
async function simulateUrlValidation(review, showTitle, openingYear, html) {
  if (!shouldValidateUrl(review)) {
    return { action: 'skip', reason: 'not a roundup source' };
  }

  if (!html) {
    return { action: 'keep', reason: 'no HTML (innocent until proven guilty)' };
  }

  const validation = await validatePageMatchesShow(html, showTitle, {
    openingYear,
    skipLlm: true,  // Skip LLM in tests — word-match only
  });

  if (!validation.valid) {
    return { action: 'null', reason: validation.reason, confidence: validation.confidence };
  }

  return { action: 'keep', reason: validation.reason, confidence: validation.confidence };
}

describe('URL validation integration (synthetic HTML)', () => {
  // --- Right show: URL should be KEPT ---

  test('Show Score URL pointing to correct show page -> keep URL', async () => {
    const review = { url: 'https://variety.com/review/kinky-boots', source: 'show-score', outlet: 'Variety' };
    const html = '<html><head><title>Kinky Boots Review - Variety</title></head><body><h1>Kinky Boots Broadway Review</h1></body></html>';

    const result = await simulateUrlValidation(review, 'Kinky Boots', 2013, html);
    assert.strictEqual(result.action, 'keep');
  });

  test('DTLI URL pointing to correct show -> keep URL', async () => {
    const review = { url: 'https://nytimes.com/review/hamilton', source: 'dtli', outlet: 'NYTimes' };
    const html = '<html><head><title>Hamilton Review - NYT</title></head><body><h1>Hamilton: An American Musical</h1></body></html>';

    const result = await simulateUrlValidation(review, 'Hamilton', 2015, html);
    assert.strictEqual(result.action, 'keep');
  });

  test('BWW roundup URL for correct show -> keep URL', async () => {
    const review = { url: 'https://broadwayworld.com/article/review-oh-mary', source: 'bww-roundup', outlet: 'Timeout' };
    const html = '<html><head><title>Review Roundup: Oh, Mary!</title></head><body><h1>Oh, Mary! Opens on Broadway</h1></body></html>';

    const result = await simulateUrlValidation(review, 'Oh, Mary!', 2024, html);
    assert.strictEqual(result.action, 'keep');
  });

  // --- Wrong show: URL should be NULLED ---

  test('Show Score URL pointing to wrong show -> null URL', async () => {
    const review = { url: 'https://thestage.co.uk/review/clueless', source: 'show-score', outlet: 'The Stage' };
    const html = '<html><head><title>Clueless the Musical Review - The Stage</title></head><body><h1>Clueless the Musical</h1></body></html>';

    const result = await simulateUrlValidation(review, 'Kinky Boots', 2013, html);
    assert.strictEqual(result.action, 'null');
  });

  test('BWW roundup URL about different show -> null URL', async () => {
    const review = { url: 'https://broadwayworld.com/article/review-wicked', source: 'bww-roundup', outlet: 'NYPost' };
    const html = '<html><head><title>Wicked Review Roundup</title></head><body><h1>Wicked Gets Rave Reviews</h1></body></html>';

    const result = await simulateUrlValidation(review, 'Hamilton', 2015, html);
    assert.strictEqual(result.action, 'null');
  });

  test('Theatre-reviews URL about wrong show -> null URL', async () => {
    const review = { url: 'https://guardian.com/review/cabaret', source: 'theatre-reviews', outlet: 'The Guardian' };
    const html = '<html><head><title>Cabaret at the Kit Kat Club Review</title></head><body><h1>Cabaret West End Review</h1></body></html>';

    const result = await simulateUrlValidation(review, 'Sunset Boulevard', 2024, html);
    assert.strictEqual(result.action, 'null');
  });

  // --- Year mismatch: wrong production ---

  test('URL from 2008 production when show opened 2024 -> null URL', async () => {
    const review = { url: 'https://variety.com/2008/review/gypsy', source: 'show-score', outlet: 'Variety' };
    const html = '<html><head><title>Gypsy 2008 Broadway Review</title></head><body><h1>Gypsy (2008 Revival)</h1></body></html>';

    const result = await simulateUrlValidation(review, 'Gypsy', 2024, html);
    assert.strictEqual(result.action, 'null');
    assert.ok(result.reason.includes('year mismatch'), `expected year mismatch, got: ${result.reason}`);
  });

  // --- Edge cases: should KEEP (innocent until proven guilty) ---

  test('fetch returned no HTML -> keep URL', async () => {
    const review = { url: 'https://paywall.com/review', source: 'show-score', outlet: 'Paywalled Outlet' };

    const result = await simulateUrlValidation(review, 'Hamilton', 2015, null);
    assert.strictEqual(result.action, 'keep');
    assert.ok(result.reason.includes('innocent'));
  });

  test('empty HTML -> null URL (no headings match)', async () => {
    const review = { url: 'https://empty.com/review', source: 'show-score', outlet: 'Empty Outlet' };
    const html = '<html><head><title></title></head><body></body></html>';

    const result = await simulateUrlValidation(review, 'Hamilton', 2015, html);
    assert.strictEqual(result.action, 'null');
  });

  // --- Non-roundup sources: should SKIP validation entirely ---

  test('SERP-discovered URL -> skip (already validated elsewhere)', async () => {
    const review = { url: 'https://variety.com/review/wrong-show', source: 'serp-discovery', outlet: 'Variety' };

    const result = await simulateUrlValidation(review, 'Hamilton', 2015, '<html><title>Wrong Show</title></html>');
    assert.strictEqual(result.action, 'skip');
  });

  test('Manual URL (no source) -> skip', async () => {
    const review = { url: 'https://variety.com/review/show' };

    const result = await simulateUrlValidation(review, 'Hamilton', 2015, '<html><title>Wrong</title></html>');
    assert.strictEqual(result.action, 'skip');
  });

  // --- WE aggregator sources ---

  test('westendtheatre URL about wrong show -> null URL', async () => {
    const review = { url: 'https://standard.co.uk/review', source: 'westendtheatre', outlet: 'Evening Standard' };
    const html = '<html><head><title>The Mousetrap Review</title></head><body><h1>The Mousetrap</h1></body></html>';

    const result = await simulateUrlValidation(review, 'Les Miserables', 2024, html);
    assert.strictEqual(result.action, 'null');
  });

  test('stagedoor URL about correct show -> keep URL', async () => {
    const review = { url: 'https://timeout.com/london/les-mis', source: 'stagedoor', outlet: 'Time Out' };
    const html = '<html><head><title>Les Miserables Review - Time Out London</title></head><body><h1>Les Miserables</h1></body></html>';

    const result = await simulateUrlValidation(review, 'Les Miserables', 2024, html);
    assert.strictEqual(result.action, 'keep');
  });
});
