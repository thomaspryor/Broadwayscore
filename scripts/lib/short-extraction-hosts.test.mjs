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
 * Fixtures below reproduce each outlet's real DOM shape (verified live
 * 2026-09-25) with synthetic filler prose in place of the outlets' actual
 * copyrighted review text — CLAUDE.md ("Private Repos") keeps real review
 * text out of this public repo; only the structural bug needs pinning here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from './article-extractor.js';

const FILLER = 'This production delivers a thoughtful, well-paced evening of theatre with strong performances throughout. '.repeat(15);

describe('short-extraction-hosts: BRO-4155', () => {
  test('stagebuddy.com: articleblock div extracts the full review, not ~100 chars', () => {
    const html =
      '<html><body>' +
      '<div class="col-sm-3 sidebarstyle"><p>Related shows sidebar teaser text here.</p></div>' +
      '<div class="articleblock">' +
      '<p><img src="https://stagebuddy.com/wp-content/uploads/x.jpg" /></p>' +
      '<p>' + FILLER + '</p>' +
      '<p>The production closes with a genuinely moving final scene that lingers long after the curtain falls.</p>' +
      '</div>' +
      '<div class="clearboth"></div>' +
      '<div class="aboutheadline"><p>Hayes Theater<br />240 West 44th Street<br />New York, NY 10036</p></div>' +
      '<div class="authorbox">Written by a StageBuddy contributor.</div>' +
      '</body></html>';
    const text = extractArticleText(html, 'stagebuddy.com');
    assert.ok(text, 'should extract text');
    assert.ok(text.length > 1000, `expected >1000 chars, got ${text.length}`);
    assert.ok(text.includes('thoughtful, well-paced evening'), 'review prose should be present');
    assert.ok(text.includes('lingers long after the curtain falls'), 'should capture through to the review close');
    assert.ok(!text.includes('Hayes Theater'), 'trailing venue/address chrome (aboutheadline block) should not leak in');
    assert.ok(!text.includes('sidebar teaser'), 'unrelated sidebar content should not leak in');
  });

  test('theatreweekly.com: entry-content extracts the review, not a "You might also like" teaser headline', () => {
    const html =
      '<html><body><div class="row"><div class="jeg_main_content col-md-9"><div class="jeg_inner_content">' +
      '<div class="entry-content no-share">' +
      "<div class='jnews_inline_related_post_wrapper left'>" +
      '<div class="jeg_block_heading"><h3>You might<strong>also like</strong></h3></div>' +
      '<article class="jeg_post jeg_pl_sm format-standard">' +
      '<div class="jeg_thumb"><a href="/other-review-1/"><img src="x1.jpg" srcset="x1-320.jpg 320w, x1-640.jpg 640w" /></a></div>' +
      '<div class="jeg_postblock_content"><h3 class="jeg_post_title"><a href="/other-review-1/">Edinburgh Fringe Review: Some Other Show At Underbelly Cowgate</a></h3></div>' +
      '</article>' +
      '<article class="jeg_post jeg_pl_sm format-standard">' +
      '<div class="jeg_thumb"><a href="/other-review-2/"><img src="x2.jpg" srcset="x2-320.jpg 320w, x2-640.jpg 640w" /></a></div>' +
      '<div class="jeg_postblock_content"><h3 class="jeg_post_title"><a href="/other-review-2/">Fringe Review: Another Unrelated Production Title Here</a></h3></div>' +
      '</article>' +
      '</div>' +
      '<p>' + FILLER + '</p>' +
      '<p>Bold performances and sharp direction make this one of the highlights of the run.</p>' +
      '</div>' +
      '<div class="jnews_author_box_container "><div class="jeg_authorbox"><h3 class="jeg_author_name">Some Critic</h3>' +
      '<p class="jeg_author_desc">Some Critic is an award-winning writer with a huge passion for theatre.</p></div></div>' +
      '</div></div></div></body></html>';
    const text = extractArticleText(html, 'theatreweekly.com');
    assert.ok(text, 'should extract text');
    assert.ok(text.length > 1000, `expected >1000 chars, got ${text.length}`);
    assert.ok(text.includes('highlights of the run'), 'review prose should be present');
    assert.ok(!text.includes('You might'), 'leading related-post widget chrome should not leak in');
    assert.ok(!text.includes('Some Other Show'), 'related-post teaser titles should not leak in');
    assert.ok(!text.includes('award-winning writer'), 'trailing author-bio chrome should not leak in');
  });

  test('theatreweekly.com: extraction fails closed (null) rather than falling through to a teaser-only page', () => {
    // No entry-content at all — e.g. a page-shape drift or a non-article page.
    // Must return null, not fall through to the generic <article> PATTERNS
    // loop, which would otherwise pick up one of these teaser cards again.
    const html =
      '<html><body>' +
      '<article class="jeg_post jeg_pl_sm format-standard">' +
      '<h3 class="jeg_post_title">Edinburgh Fringe Review: Some Other Show At Underbelly Cowgate</h3>' +
      '</article>' +
      '<article class="jeg_post jeg_pl_sm format-standard">' +
      '<h3 class="jeg_post_title">Fringe Review: Another Unrelated Production Title Here Too</h3>' +
      '</article>' +
      '</body></html>';
    const text = extractArticleText(html, 'theatreweekly.com');
    assert.strictEqual(text, null, 'must fail closed, not return a teaser card as if it were the review');
  });

  test('interestedbystander.com: single-quoted Blogger post-body class extracts the review', () => {
    const html =
      "<html><body><div id='main'><div class='post'>" +
      "<div class='post-body entry-content' id='post-body-1' itemprop='description articleBody'>" +
      '<div><br /></div>' +
      '<p>' + FILLER + '</p>' +
      '<p>Overall this run delivers exactly what fans of the show have come to expect.</p>' +
      '</div>' +
      "<div class='post-footer'>Posted by a critic. <span class='post-labels'>Labels: reviews</span></div>" +
      '</div></div></body></html>';
    const text = extractArticleText(html, 'www.interestedbystander.com');
    assert.ok(text, 'should extract text');
    assert.ok(text.length > 1000, `expected >1000 chars, got ${text.length}`);
    assert.ok(text.includes('exactly what fans of the show'), 'review prose should be present');
    assert.ok(!text.includes('Posted by a critic'), 'trailing post-footer chrome should not leak in');
  });
});
