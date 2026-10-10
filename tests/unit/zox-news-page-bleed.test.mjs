/**
 * BRO-4977: Times Square Chronicles (t2conline.com, Zox News WordPress theme)
 * auto-loads the next stories inside the same <article>. Every extractor fell
 * back to that <article> and kept 3-4 other reviews glued onto the real one;
 * Soon's live pull quote praised Linda Purl in a different show. 66 of 102
 * stored T2C reviews had the bleed. Both the browser-DOM extractor and the
 * HTML-string extractor must return the body container only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractArticleTextFromDocument } = require('../../scripts/lib/dom-article-extractor.js');
const { extractArticleText, extractZoxNewsBody } = require('../../scripts/lib/article-extractor.js');

const REVIEW = 'Charlie has decided that the most reasonable response to the end of the world is to stay on her couch with peanut butter. ';
const OTHER = 'Linda Purl gives a performance in Crazy Mama that makes it unforgettable, a different show entirely. ';

// Shape copied from the live t2conline.com page (2026-10-10): body in
// #mvp-content-main, then tags, prev/next, author box, related posts and the
// auto-loaded next stories, all inside <article id="mvp-article-wrap">.
const ZOX_HTML = `<html><body>
<article id="mvp-article-wrap" itemscope itemtype="http://schema.org/NewsArticle">
  <div id="mvp-post-content" class="left relative">
    <div id="mvp-content-wrap" class="left relative">
      <div id="mvp-content-body" class="left relative">
        <div id="mvp-content-main" class="left relative">
          ${`<p>${REVIEW.repeat(3)}</p>`.repeat(6)}
          <div class="wp-block-image"><figure><img src="x.jpg"></figure></div>
          <p>Soon plays at The Loft at St. Luke's through November 8. It is heartbreaking in the best possible way.</p>
        </div>
        <div id="mvp-content-bot" class="left"><span>Related Topics: Ava Delaney Mike Millan</span></div>
        <div id="mvp-prev-next-wrap" class="left relative"><p>Slam Frank: Brilliant, Offensive, Confusing and Impossible to Stop Talking About</p></div>
        <div id="mvp-author-box-wrap" class="left relative"><p>Suzanna, co-owns and publishes the newspaper Times Square Chronicles or T2C. At one point a working actress.</p></div>
        <div id="mvp-related-posts" class="left relative"><p>You may like: another headline that runs long enough to count as a paragraph here.</p></div>
      </div>
    </div>
  </div>
  <div id="mvp-post-add-box"><div class="mvp-post-add-story">${`<p>${OTHER.repeat(3)}</p>`.repeat(10)}</div></div>
</article>
<div id="mvp-post-more-wrap"><p>Trending: Comic Con Is Taking Over Times Square and House of Spells Is Ready.</p></div>
</body></html>`;

describe('Zox News page bleed (BRO-4977)', () => {
  test('DOM extractor keeps only #mvp-content-main', () => {
    const doc = new JSDOM(ZOX_HTML).window.document;
    const text = extractArticleTextFromDocument(doc, 'https://t2conline.com/soon-when-the-end-of-the-world/');
    assert.ok(text.includes('heartbreaking in the best possible way'), 'review ending kept');
    assert.ok(!text.includes('Linda Purl'), 'auto-loaded next story must not bleed in');
    assert.ok(!text.includes('co-owns and publishes'), 'author box must not bleed in');
    assert.ok(!text.includes('Slam Frank'), 'prev/next titles must not bleed in');
  });

  test('HTML-string extractor keeps only #mvp-content-main', () => {
    const text = extractArticleText(ZOX_HTML, 't2conline.com');
    assert.ok(text.includes('heartbreaking in the best possible way'));
    for (const leak of ['Linda Purl', 'co-owns and publishes', 'Slam Frank', 'Related Topics', 'Trending']) {
      assert.ok(!text.includes(leak), `"${leak}" must not bleed in`);
    }
  });

  test('extractZoxNewsBody is null on a page without the theme', () => {
    assert.strictEqual(extractZoxNewsBody(`<article><p>${REVIEW.repeat(10)}</p></article>`), null);
  });
});
