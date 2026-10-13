import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// BRO-3499: collect-review-texts.js extractTextFromHtml now falls back to
// article-extractor.js's dedicated extractor for DEDICATED_EXTRACTOR_HOSTS
// when the generic extraction comes up short. Real functions, no copies.
const require = createRequire(import.meta.url);
const { extractTextFromHtml } = require('../../scripts/collect-review-texts.js');
const { isDedicatedExtractorHost } = require('../../scripts/lib/article-extractor.js');

const BODY = 'A sharp, funny revival that finds new bite in an old farce, with a cast that never misses a beat. '.repeat(4).trim();
const ld = (body) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script></head><body><div>nav</div></body></html>`;

test('isDedicatedExtractorHost matches the configured outlets only', () => {
  assert.equal(isDedicatedExtractorHost('https://www.lavocedinewyork.com/arts/x.html'), true);
  assert.equal(isDedicatedExtractorHost('https://www.thestage.co.uk/reviews/x'), true);
  assert.equal(isDedicatedExtractorHost('https://www.nytimes.com/x'), false);
});

test('La Voce: a 300-499 char JSON-LD body is recovered via the dedicated extractor', () => {
  assert.ok(BODY.length >= 300 && BODY.length < 500, `fixture length ${BODY.length}`);
  const url = 'https://www.lavocedinewyork.com/arts/2026/review.html';
  assert.equal(extractTextFromHtml(ld(BODY), url), BODY);
});

test('non-dedicated host keeps generic behavior (short body stays empty)', () => {
  assert.equal(extractTextFromHtml(ld(BODY), 'https://example.com/review'), '');
});
