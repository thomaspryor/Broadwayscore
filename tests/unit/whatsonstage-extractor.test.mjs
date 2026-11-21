/**
 * Article extractor — WhatsOnStage (whatsonstage.com) review body.
 *
 * Incident 2026-06-04 (War Horse): WhatsOnStage had NO outlet-specific extractor,
 * so the generic <article>/<main> fallback returned site chrome (or nothing) for
 * its review pages. An empty body made the collector LLM classify the real War
 * Horse review as wrongShow ("not a review — only legal/privacy text"), dropping
 * a 5-star review and undercounting the show.
 *
 * Real structure (verified live): the review prose lives in
 * <div class="news-content">. Social-share icons, a "featured in this story"
 * section, and an article-tags section follow the body (some inside the same
 * container), so the pattern stops at the first of those markers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

describe('article-extractor: WhatsOnStage review body', () => {
  test('captures the news-content body and stops before share/tags chrome', () => {
    const prose =
      'War Horse, the much loved play, is back on the Olivier stage where it began. ' +
      'Three puppeteers work Joey in full view and that honesty is the trick. '.repeat(6);
    const html =
      '<html><body>' +
      '<header class="navbar">site nav junk</header>' +
      '<div id="content-container" class="css-content-container">' +
      '<div id="article-star-rating-container">5 stars</div>' +
      '<div class="news-content">' +
        '<p>' + prose + '</p>' +
        '<p>As long as War Horse exists, the National will be fine. Bring tissues.</p>' +
      '<div class="social-share-news-icons d-flex my-4"><a>Share</a></div>' +
      '<section class="featured-in-this-story my-3">War Horse tickets</section>' +
      '<section class="article-tags my-3"><a>Equus</a><a>reviews</a></section>' +
      '</div>' +
      '</div>' +
      '</body></html>';

    const text = extractArticleText(html, 'www.whatsonstage.com');
    assert.ok(text, 'should extract a body');
    assert.ok(text.length > 300, `body should be substantial, got ${text ? text.length : 0}`);
    assert.ok(/Bring tissues/.test(text), 'should include the closing line of the review');
    // Trailing chrome must be excluded — the article-tags "Equus" link must not bleed in.
    assert.ok(!/Equus/.test(text), 'must not bleed the article-tags (Equus) into the body');
    assert.ok(!/Share/.test(text), 'must not include the social-share widget');
  });
});
