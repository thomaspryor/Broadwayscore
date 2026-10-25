/**
 * Article extractor — pages-on-stages.com + The Stage smoke test.
 *
 * Task #99: stub-rate scan found both outlets returning 0 extracted chars
 * (silent stub class — same as the 1minutecritic/TheaterMania incidents).
 * pagesonstages.com had NO pattern at all. The Stage pattern already exists
 * (see stage-extractor.test.mjs for its full coverage); this file adds one
 * smoke test confirming it still works, plus the new pagesonstages.com
 * coverage, mirroring tests/unit/1minutecritic-extractor.test.mjs.
 *
 * pagesonstages.com (WordPress.com/Jetpack) — review body lives in
 * <div class="entry-content ...">, a run of <p class="wp-block-paragraph">
 * blocks. A "<hr class="wp-block-separator">" consistently marks the end of
 * the review prose, right before a "Thank you for reading…" sign-off and an
 * inline Jetpack subscribe-block widget with its own nested <div>s (avoided
 * entirely by stopping at the hr). Verified live against 3 reviews
 * (Birthright/Small/Ragtime, 2026-08-10).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

describe('article-extractor: pagesonstages.com', () => {
  test('captures review prose, stops before the subscribe-widget hr', () => {
    const html =
      '<html><body><article>' +
      '<div class="entry-content wp-block-post-content is-layout-flow">' +
      '<p class="has-text-align-right wp-block-paragraph"><strong>Birthright – 26 June 2026</strong></p>' +
      '<p class="wp-block-paragraph">' + 'A patient, layered production that earns its three-act structure. '.repeat(6) + '</p>' +
      '<p class="wp-block-paragraph"><em>I attended this performance on a press pass from Print Shop PR.</em></p>' +
      '</div>' +
      '<hr class="wp-block-separator has-alpha-channel-opacity" />' +
      '<p class="wp-block-paragraph">Thank you for reading <em>Pages on Stages</em>!</p>' +
      '<div class="wp-block-jetpack-subscriptions__supports-newline wp-block-jetpack-subscriptions">' +
      '<div class="wp-block-jetpack-subscriptions__container is-not-subscriber"><form>Subscribe</form></div>' +
      '</div>' +
      '<p class="wp-block-paragraph">Follow <em>Pages on Stages</em> on social media!</p>' +
      '</div></div></div></div>' +
      '</article></body></html>';
    const text = extractArticleText(html, 'pagesonstages.com');
    assert.ok(text, 'extractor should return text');
    assert.ok(text.includes('patient, layered production'), 'review prose captured');
    assert.ok(text.includes('press pass from Print Shop PR'), 'press-pass disclosure captured (end of review)');
    assert.ok(!text.includes('Thank you for reading'), 'sign-off leaked past the hr boundary');
    assert.ok(!text.includes('Subscribe'), 'subscribe widget leaked');
    assert.ok(!text.includes('Follow'), 'social-media footer leaked');
  });

  test('falls back to the subscribe-widget div when no hr is present', () => {
    const html =
      '<html><body><article>' +
      '<div class="entry-content wp-block-post-content is-layout-flow">' +
      '<p class="wp-block-paragraph">' + 'The staging is spare but effective, letting the text carry the emotional weight. '.repeat(6) + '</p>' +
      '<div class="wp-block-jetpack-subscriptions__supports-newline wp-block-jetpack-subscriptions">' +
      '<div class="wp-block-jetpack-subscriptions__container is-not-subscriber"><form>Subscribe</form></div>' +
      '</div>' +
      '</div></div></div></div>' +
      '</article></body></html>';
    const text = extractArticleText(html, 'pagesonstages.com');
    assert.ok(text, 'fallback pattern should return text');
    assert.ok(text.includes('staging is spare but effective'), 'review prose captured via fallback');
    assert.ok(!text.includes('Subscribe'), 'subscribe widget leaked via fallback pattern');
  });

  test('returns null when entry-content is absent (non-review page)', () => {
    const html = '<html><body><div class="site-header">pagesonstages.com</div></body></html>';
    const text = extractArticleText(html, 'pagesonstages.com');
    assert.ok(!text, `should return null with no entry-content; got: ${(text || '').slice(0, 100)}`);
  });
});

describe('article-extractor: The Stage (thestage.co.uk) smoke test', () => {
  // Full coverage (mid-article widget, byline-shape trailing noise, logged-out
  // null case) lives in stage-extractor.test.mjs — this is a light regression
  // check that the pattern is wired for the pagesonstages sibling fix.
  test('captures standfirst + review prose', () => {
    const html =
      '<html><body><article>' +
      '<div class="aos-Article-IntroText aos-DS32-Intro">' +
      '<p>A confident revival that trusts its material.</p>' +
      '</div>' +
      '<div class="aos-DS32-WYSEdit">' +
      '<p>' + 'The production finds fresh urgency in a familiar text through careful pacing. '.repeat(4) + '</p>' +
      '</div>' +
      '</article></body></html>';
    const text = extractArticleText(html, 'thestage.co.uk');
    assert.ok(text, 'extractor should return text');
    assert.ok(text.includes('confident revival'), 'standfirst captured');
    assert.ok(text.includes('fresh urgency'), 'body paragraph captured');
  });
});
