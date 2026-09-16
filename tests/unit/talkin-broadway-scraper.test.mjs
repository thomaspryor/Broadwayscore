/**
 * BRO-912 — Talkin' Broadway opening-night scraper regression coverage.
 *
 * Root cause: collect-review-texts.js (the pipeline opening-night discovery
 * actually calls) had its OWN duplicated, weaker TB extraction inline in
 * extractTextFromHtml() — a naive "grab every <p> inside <section
 * class='page'>" scrape with no byline anchor. The byline-anchored fix
 * (task #1887, scripts/lib/article-extractor.js's extractTalkinBroadwayBody,
 * covered by tests/unit/article-extractor-talkinbroadway.test.mjs) landed
 * in that shared lib but was never wired into collect-review-texts.js, so
 * the production opening-night pipeline kept hitting the original bug class:
 * grabbing newsletter-sidebar chrome and blending stacked "Past Reviews" runs
 * together instead of isolating the single review being scored.
 *
 * Fix: collect-review-texts.js's extractTextFromHtml() now delegates to the
 * shared extractArticleText() for talkinbroadway.com before falling back to
 * its own generic paragraph scrape. This file verifies (a) the wiring is in
 * place and (b) the shared function it now calls handles the two failure
 * modes that made TB "fail every opening night": newsletter-sidebar leakage
 * and stacked-review bleed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLECT_REVIEW_TEXTS_PATH = path.join(__dirname, '../../scripts/collect-review-texts.js');

const NEWSLETTER_CHROME =
  "<aside class='sidebar'>" +
  "<article class='newsletter'>" +
  "<h2 class='newsletter-title'>Talkin' Broadway E-Blast List</h2>" +
  "<label><b>Sound Advice</b> Weekly html emails about new and upcoming theatre-related CD, DVD and Book releases.</label>" +
  '</article>' +
  '</aside>';

describe('BRO-912: collect-review-texts.js wires TB extraction to the shared byline-anchored extractor', () => {
  test('extractTextFromHtml delegates talkinbroadway.com to extractArticleText before the generic <section class="page"> fallback', () => {
    const src = fs.readFileSync(COLLECT_REVIEW_TEXTS_PATH, 'utf8');
    const fnStart = src.indexOf('function extractTextFromHtml(html, url) {');
    assert.ok(fnStart !== -1, 'extractTextFromHtml should still exist in collect-review-texts.js');

    const delegationIdx = src.indexOf("url.includes('talkinbroadway.com')", fnStart);
    assert.ok(delegationIdx !== -1, 'extractTextFromHtml should branch on talkinbroadway.com');

    const legacyFallbackIdx = src.indexOf('section class="page"', fnStart);
    assert.ok(legacyFallbackIdx !== -1, 'the old <section class="page"> fallback should still exist as a safety net');
    assert.ok(
      delegationIdx < legacyFallbackIdx,
      'the shared-extractor delegation must run BEFORE the naive <section class="page"> paragraph scrape'
    );

    const requireIdx = src.indexOf("require('./lib/article-extractor')");
    assert.ok(requireIdx !== -1, 'collect-review-texts.js should require the shared article-extractor lib');
  });
});

describe('BRO-912: the extractor now driving TB opening-night scraping handles both known failure modes', () => {
  test('newsletter-sidebar leakage (task #1887 / Fear of 13 incident): review is extracted, sidebar excluded', () => {
    const reviewBody = 'This immersive haunted-house show delivers real scares. '.repeat(15);
    const html =
      '<html><body>' + NEWSLETTER_CHROME +
      "<section class='page'>" +
      "<CENTER><B>Fear of 13</B></CENTER>" +
      "<P><B>Theatre Review by <A HREF='mailto:hm@talkinbroadway.com'>Howard Miller</A> - April 15, 2026</B></CENTER>" +
      `<P>${reviewBody}` +
      '</section>' +
      '</body></html>';

    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text, 'should extract review text');
    assert.ok(text.length > 300, `expected a full review, got ${text.length} chars (the original bug produced 378 chars of garbage)`);
    assert.ok(!text.includes('Sound Advice Weekly'), `newsletter chrome leaked through: ${text.slice(0, 200)}`);
  });

  test('stacked "Past Reviews" bleed: a revival run does not get concatenated with the current run', () => {
    // The old naive extractTextFromHtml grabbed every <p> in <section class="page">
    // with no byline boundary, so on a page with multiple stacked runs it silently
    // blended two different critics'/years' reviews into one fullText.
    const oldRun = 'This is the earlier revival review text, describing a different cast entirely. '.repeat(15);
    const currentRun = 'This is the current opening-night review text, distinctly different prose. '.repeat(15);
    const html =
      '<html><body>' + NEWSLETTER_CHROME +
      "<section class='page'>" +
      "<P><B>Theatre Review by <A HREF='mailto:x'>Matthew Murray</A> - October 1, 2020</B></CENTER>" +
      `<P>${oldRun}` +
      "<P><B>Theatre Review by <A HREF='mailto:y'>Howard Miller</A> - April 15, 2026</B></CENTER>" +
      `<P>${currentRun}` +
      '</section></body></html>';

    const text = extractArticleText(html, 'www.talkinbroadway.com', 'Howard Miller');
    assert.ok(text, 'should extract text');
    assert.ok(text.includes('current opening-night review'), 'criticHint should select the current run');
    assert.ok(!text.includes('earlier revival review'), 'must not bleed the earlier stacked run into the current one');
  });
});
