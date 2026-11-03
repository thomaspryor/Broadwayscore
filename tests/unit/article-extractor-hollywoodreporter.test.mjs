/**
 * The Hollywood Reporter extraction (BRO-6872).
 *
 * THR's header mega menu sits in a div.lrv-a-wrapper closed by </div></section>, which is what the old THR pattern
 * matched, so every review page came back as ~1300 chars of menu chrome ("Click to expand the Mega Menu ...
 * Newsletters Subscribe"). The scorer refused it as body_too_short and the opening-night lane lost the Other Desert
 * Cities review. THR runs the PMC template Variety and Deadline use, so extractVarietyBody now handles it; a page it
 * cannot read returns null, never the menu. Synthetic markup shaped like the live page; no review text.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

// Longer than the old pattern's 500-char floor, so the pre-fix extractor returns this chrome, as it did live.
const MEGA_MENU =
  '<section class="header"><div class="lrv-a-wrapper"><span>Plus Icon Click to expand the Mega Menu</span>' +
  '<a>Click to expand search form</a><a>Got a tip?</a><a>Newsletters</a><a>Subscribe</a>' +
  ['Movies', 'TV', 'Music', 'Awards', 'Business', 'Lifestyle', 'Theater', 'Style', 'Video', 'Podcasts']
    .map((s) => `<ul><li><a href="/c/${s}">${s} News</a></li><li><a href="/c/${s}/features">${s} Features and Reviews</a></li></ul>`).join('') +
  '<p>The Definitive Voice of Entertainment News</p></div></section>';

const SHARE = '<div class="a-article-grid__social"><div class="social-share"><ul><li><a>Share on Facebook</a></li><li><a>Share on X</a></li></ul></div></div>';
const RELATED = '<div class="injected-related-story // u-margin-tb-250"><div class="o-card__content"><a href="/x">Promo Headline About Something Else Entirely</a></div></div>';
const para = (i) => `<p class="paragraph larva //  a-font-body-m     ">Paragraph ${i} of the critic's assessment of the staging, the cast and the direction of the revival.</p>\n`;

function page({ paras = 20, body = null } = {}) {
  const ps = body != null ? body : Array.from({ length: paras }, (_, i) => para(i + 1) + (i === 4 ? RELATED : '')).join('');
  return '<html><body>' + MEGA_MENU +
    '<div class="lrv-a-wrapper">\n<div class="a-content a-content--left-space lrv-a-floated-parent lrv-u-position-relative">' +
    SHARE + ps + '<p class="paragraph larva"><em>Venue: Hudson Theatre, New York</em></p> </div> <div id="piano-paywall"></div>' +
    ' </div><div class="a-article-after-content"><nav><h3>Read More About:</h3></nav></div></body></html>';
}

describe('article-extractor: hollywoodreporter.com', () => {
  test('extracts the review paragraphs, not the menu, share buttons or promo cards', () => {
    const text = extractArticleText(page(), 'hollywoodreporter.com');
    assert.ok(text && text.length > 1500, `expected the full body, got ${text && text.length} chars`);
    assert.match(text, /Paragraph 1 of/);
    assert.match(text, /Paragraph 20 of/);
    assert.doesNotMatch(text, /Mega Menu|Newsletters|Definitive Voice|Read More About|Share on|Promo Headline/);
  });

  test('a www. host resolves to the same extractor', () => {
    const text = extractArticleText(page(), 'www.hollywoodreporter.com');
    assert.match(text, /Paragraph 1 of/);
    assert.doesNotMatch(text, /Mega Menu/);
  });

  test('a page with no readable body returns null, never the menu chrome', () => {
    assert.strictEqual(extractArticleText(page({ body: '' }), 'hollywoodreporter.com'), null);
    const noContentDiv = '<html><body>' + MEGA_MENU + '<div class="lrv-a-wrapper"><div class="other">x</div></div></body></html>';
    assert.strictEqual(extractArticleText(noContentDiv, 'hollywoodreporter.com'), null);
  });
});
