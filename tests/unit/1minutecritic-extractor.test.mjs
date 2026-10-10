/**
 * Article extractor — 1minutecritic.com (WordPress entry-content).
 *
 * Background (2026-05-28): 1minutecritic.com had NO host-specific extractor
 * pattern. The generic fallback returned ~112 chars (meta description), below
 * the minLen threshold, so every 1minutecritic review was saved as a stub and
 * never scored. Missed for BOTH Heated Rivalry and The Maids — gather captured
 * the aggregator URL but text-collection produced an empty body.
 *
 * The tricky part: the review body is followed (still inside entry-content) by
 * inline "related article" teasers shaped like
 *   <p><strong>Category &#8211; </strong><a href="https://1minutecritic.com/…">
 * and then the AddToAny share block. The pattern must stop at the first of
 * those, or the related teasers leak into the review text.
 *
 * Verified end-to-end against /heated-rivalry-parody-review (3110 chars) and
 * /the-maids-st-anns-warehouse-review-kip-williams (2834 chars).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText, extractPublishDate } from '../../scripts/lib/article-extractor.js';

describe('article-extractor: 1minutecritic.com entry-content', () => {
  test('extracts review body and stops before related-article teasers', () => {
    const html =
      '<html><body><article class="post">' +
      '<div class="entry-content">' +
        '<p>' + 'A sharp, funny parody that lands its jokes with real heart. '.repeat(8) + '</p>' +
        '<p>The performances are committed and the staging is inventive.</p>' +
        // Inline "related article" teasers — must NOT leak into the body
        '<p><strong>Theater &#8211; </strong><a href="https://1minutecritic.com/some-other-review/">A different show you might like</a></p>' +
        '<p><strong>Art &#8211; </strong><a href="https://1minutecritic.com/an-art-review/">An unrelated gallery piece</a></p>' +
        '<div class="addtoany_share_save_container addtoany_content addtoany_content_bottom">Share this</div>' +
      '</div>' +
      '</article></body></html>';
    const text = extractArticleText(html, '1minutecritic.com');
    assert.ok(text, 'extractor should return text');
    assert.ok(text.includes('lands its jokes'), 'review body should be captured');
    assert.ok(text.includes('staging is inventive'), 'full body should be captured');
    assert.ok(!text.includes('different show you might like'), `related teaser leaked: …${text.slice(-150)}`);
    assert.ok(!text.includes('unrelated gallery piece'), 'art-section related teaser leaked');
    assert.ok(!text.includes('Share this'), 'AddToAny share block leaked');
  });

  test('stops at AddToAny share block when there are no related teasers', () => {
    const html =
      '<html><body>' +
      '<div class="entry-content">' +
        '<p>' + 'Real review prose evaluating the production in detail. '.repeat(8) + '</p>' +
        '<div class="addtoany_share_save_container addtoany_content addtoany_content_bottom">Share this:</div>' +
      '</div>' +
      '</body></html>';
    const text = extractArticleText(html, '1minutecritic.com');
    assert.ok(text.includes('Real review prose'));
    assert.ok(!text.includes('Share this'), 'share block leaked');
  });

  test('does NOT truncate a body paragraph with a bolded trailing-hyphen label + internal 1mc link', () => {
    // Regression (code-review 2026-05-28): the boundary alternation must use
    // en-dash ONLY. A bare hyphen-minus over-matched legit review prose like
    // "<strong>Cast - </strong><a href=1mc-link>" and truncated the body to 0.
    const html =
      '<html><body><div class="entry-content">' +
        '<p>' + 'Opening paragraph with substantial real review content here. '.repeat(4) + '</p>' +
        '<p><strong>Cast - </strong><a href="https://1minutecritic.com/profiles/jane-doe/">Jane Doe</a> delivers the standout performance.</p>' +
        '<p>' + 'A full closing paragraph of genuine criticism that must survive. '.repeat(4) + '</p>' +
        '<div class="addtoany_share_save_container">Share</div>' +
      '</div></body></html>';
    const text = extractArticleText(html, '1minutecritic.com');
    assert.ok(text.includes('must survive'), 'bolded-hyphen body was truncated — bare-hyphen boundary regression');
    assert.ok(text.includes('standout performance'), 'mid-body content after the hyphen label was dropped');
  });

  test('still stops at en-dash related teaser (boundary not weakened by the hyphen fix)', () => {
    const html =
      '<html><body><div class="entry-content">' +
        '<p>' + 'Genuine review content that should be captured in full. '.repeat(6) + '</p>' +
        '<p><strong>Theater &#8211; </strong><a href="https://1minutecritic.com/another-review/">A related show</a></p>' +
      '</div></body></html>';
    const text = extractArticleText(html, '1minutecritic.com');
    assert.ok(text.includes('captured in full'));
    assert.ok(!text.includes('A related show'), 'en-dash related teaser leaked');
  });

  test('stops at post-author-area when share block absent', () => {
    const html =
      '<html><body>' +
      '<div class="entry-content">' +
        '<p>' + 'Body text about the show and its merits and shortcomings. '.repeat(8) + '</p>' +
      '</div>' +
      '<article class="post-author-area">About the critic</article>' +
      '</body></html>';
    const text = extractArticleText(html, '1minutecritic.com');
    assert.ok(text.includes('Body text about the show'));
    assert.ok(!text.includes('About the critic'), 'author bio leaked');
  });
});

describe('extractPublishDate — page metadata date extraction', () => {
  test('reads article:published_time meta (OpenGraph / WordPress)', () => {
    const html = '<meta property="article:published_time" content="2026-05-27T02:00:00+00:00">';
    assert.equal(extractPublishDate(html), '2026-05-27');
  });

  test('reads JSON-LD datePublished', () => {
    assert.equal(extractPublishDate('{"datePublished":"2026-04-01"}'), '2026-04-01');
  });

  test('reads <time datetime>', () => {
    assert.equal(extractPublishDate('<time datetime="2026-02-20T12:00">Feb 20</time>'), '2026-02-20');
  });

  test('meta wins over time tag when both present (priority order)', () => {
    const html =
      '<meta property="article:published_time" content="2026-05-27T02:00:00Z">' +
      '<time datetime="2020-01-01">old</time>';
    assert.equal(extractPublishDate(html), '2026-05-27');
  });

  test('returns null when no date metadata present', () => {
    assert.equal(extractPublishDate('<div>no date here</div>'), null);
    assert.equal(extractPublishDate(''), null);
    assert.equal(extractPublishDate(null), null);
  });
});
