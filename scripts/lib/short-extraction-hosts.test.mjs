/**
 * BRO-4155: ingest logs during the 2026-09-25 coverage gap-audit showed
 * article-text extraction returning ~100 chars for stagebuddy.com,
 * interestedbystander (Blogger blog), and theatreweekly.com reviews — every
 * one landed as a stub/truncated file and was never scored.
 *
 * Root causes, each fixed in scripts/lib/article-extractor.js:
 *   - stagebuddy.com: review body lives in <div class="articleblock">, none of
 *     the common WordPress class names extractByCommonClass already knew
 *     about, and pages have no <article>/<main> wrapper either.
 *   - theatreweekly.com (JNews WordPress theme): the generic <article>
 *     PATTERNS fallback picked a sidebar "You might also like" teaser card
 *     (also wrapped in its own <article> tag) over the real entry-content
 *     body, because it compared candidates by RAW HTML length instead of
 *     extracted TEXT length — a two-line teaser headline with heavy
 *     image/srcset markup easily clears 300 raw chars.
 *   - interestedbystander.com (Blogger/Blogspot): body lives in
 *     class='post-body entry-content' — Blogger always single-quotes its
 *     class attributes, and extractBalancedDivByClass/removeBalancedDivBlocks
 *     only matched double-quoted class attrs, so the common-class fallback
 *     silently never matched ANY single-quoted-class site.
 *
 * These fixtures are real HTML saved from the three outlets' own pages (see
 * tests/fixtures/short-extraction-hosts/), not synthetic markup — the bugs
 * above only reproduce against the outlets' actual DOM shape.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractArticleText } from './article-extractor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', '..', 'tests', 'fixtures', 'short-extraction-hosts');
const load = (name) => readFileSync(join(FIX, name), 'utf8');

describe('short-extraction-hosts: BRO-4155', () => {
  test('stagebuddy.com: articleblock div extracts the full review, not ~100 chars', () => {
    const html = load('stagebuddy-between-riverside-and-crazy.html');
    const text = extractArticleText(html, 'stagebuddy.com');
    assert.ok(text, 'should extract text');
    assert.ok(text.length > 1000, `expected >1000 chars, got ${text.length}`);
    assert.ok(text.includes('Stephen Adly Guirgis'), 'review prose should be present');
    assert.ok(text.includes('master class in acting'), 'should capture through to the review close');
    assert.ok(!text.includes('Hayes Theater'), 'trailing venue/address chrome (aboutheadline block) should not leak in');
  });

  test('theatreweekly.com: entry-content extracts the review, not a "You might also like" teaser headline', () => {
    const html = load('theatreweekly-jeezus.html');
    const text = extractArticleText(html, 'theatreweekly.com');
    assert.ok(text, 'should extract text');
    assert.ok(text.length > 1000, `expected >1000 chars, got ${text.length}`);
    assert.ok(text.includes('JEEZUS'), 'review prose should be present');
    assert.ok(!text.includes('You might'), 'leading related-post widget chrome should not leak in');
    assert.ok(!text.includes('Greg is an award-winning writer'), 'trailing author-bio chrome should not leak in');
  });

  test('theatreweekly.com: news-article page does not leak the trailing "Related Articles" block', () => {
    const html = load('theatreweekly-mousetrap-tour.html');
    const text = extractArticleText(html, 'theatreweekly.com');
    assert.ok(text, 'should extract text');
    assert.ok(text.length > 1000, `expected >1000 chars, got ${text.length}`);
    assert.ok(text.includes('Mousetrap'), 'article prose should be present');
    assert.ok(!text.includes('Cast Announced for National Tour'), 'trailing related-articles teaser titles should not leak in');
  });

  test('interestedbystander.com: single-quoted Blogger post-body class extracts the review', () => {
    const html = load('interestedbystander-gypsy.html');
    const text = extractArticleText(html, 'www.interestedbystander.com');
    assert.ok(text, 'should extract text');
    assert.ok(text.length > 1000, `expected >1000 chars, got ${text.length}`);
    assert.ok(text.includes('Gypsy'), 'review prose should be present');
  });
});
