/**
 * Article extractor — Theatrely (theatrely.com), Webflow CMS.
 *
 * Background: Encores! La Cage aux Folles / Juan A. Ramirez 2026-06-21. The
 * Theatrely review had no extractor pattern, so ingest-review-from-url returned
 * 0 chars and the review would have saved as an un-scoreable stub — it had to
 * be ingested manually via WebFetch.
 *
 * The body is a Finsweet rich-text block:
 *   <div fs-richtext-element="rich-text" class="rich-text-block w-richtext">…</div>
 * followed by a "div-block-34 w-condition-invisible" tickets/related block.
 * Inline images render as <figure><div><img></div></figure>, so a naive
 * "first </div>" boundary truncates mid-article (the live page stopped at
 * 3063 of 5631 chars). The figure's inner </div> is always followed by
 * <figcaption>, never <div>, so bounding the block at "</div> <div" lands on
 * the block's own close — and skips past inline figures.
 *
 * This guards the pattern + the publish-date fallback so a future merge or
 * site redesign can't silently revert them without a red test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText, extractPublishDate } from '../../scripts/lib/article-extractor.js';

describe('article-extractor: Theatrely (Webflow rich-text-block)', () => {
  const html =
    '<html><body><div class="post-content">' +
      '<h1 class="big">A Breathtaking Billy Porter — Review</h1>' +
      // author/meta box sits in a SEPARATE container before the body
      '<div class="post-content-text"><a href="/author/juan-ramirez" class="author">Juan A. Ramirez</a>' +
        '<div class="publish-date">June 19, 2026 11:15 AM</div></div>' +
      '<div fs-richtext-element="rich-text" class="rich-text-block w-richtext">' +
        '<p>' + "You'd think after RuPaul's Drag Race catapulted drag into the mainstream. ".repeat(8) + '</p>' +
        // inline image — <figure><div><img></div></figure> is what broke naive matching
        '<figure class="w-richtext-figure-type-image"><div><img alt="" src="x.png"/></div>' +
          '<figcaption><strong>The Company | Photo: Joan Marcus</strong></figcaption></figure>' +
        '<p>Luckily, Porter summons a torrent of emotion in a jaw-dropping I Am What I Am.</p>' +
        '<p>La Cage aux Folles is in performance at New York City Center.</p>' +
      '</div>' +
      '<div class="div-block-34 w-condition-invisible"><div class="w-dyn-list">' +
        '<p>Sign up for the latest in arts and culture, for the next generation.</p>' +
      '</div></div>' +
    '</div></body></html>';

  test('captures the full review body across an inline figure', () => {
    const text = extractArticleText(html, 'www.theatrely.com');
    assert.ok(text, 'extractor should return text');
    assert.ok(text.includes("You'd think after RuPaul"), 'opening prose captured');
    // The paragraph AFTER the inline figure must survive — this is the regression
    assert.ok(text.includes('Porter summons a torrent'), 'body after inline figure must not be truncated');
    assert.ok(text.includes('New York City Center'), 'final paragraph captured');
  });

  test('does not leak the trailing tickets/newsletter block', () => {
    const text = extractArticleText(html, 'theatrely.com');
    assert.ok(!text.includes('next generation'), `trailing div-block leaked: …${text.slice(-120)}`);
  });

  test('extracts publish date from the visible publish-date div (no meta tag)', () => {
    assert.equal(extractPublishDate(html), '2026-06-19');
  });
});
