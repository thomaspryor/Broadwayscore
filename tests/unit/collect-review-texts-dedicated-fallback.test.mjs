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

// BRO-5219: on nub.news the generic path clears the 500-char fallback threshold
// by keeping the donation appeal, so the dedicated extractor must run FIRST.
test('nub.news: dedicated body wins over a long generic extraction', () => {
  const para = 'The cast handle the river comedy with real warmth and timing. ';
  const appeal = '<p>The Ball is in your court. You can support us with a small payment or at least read us for free. Monthly supporters will enjoy an ad-free experience.</p>';
  const html = '<html><body><article><div id="article_content_block" class="prose">' +
    `<p>${para.repeat(4)}</p><p>${para.repeat(4)}</p>` +
    '</div>' + appeal.repeat(3) + '</article></body></html>';
  const text = extractTextFromHtml(html, 'https://kingston.nub.news/news/local-features/review-x-1');
  assert.match(text, /river comedy/);
  assert.doesNotMatch(text, /support us|Ball is in your court/);
  // A host that merely ends in "nub.news" is not Nub News.
  assert.match(extractTextFromHtml(html, 'https://snub.news/review-x'), /support us/);
});
