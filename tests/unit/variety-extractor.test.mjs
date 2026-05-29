/**
 * Article extractor — Variety (variety.com) promo-interleaved body.
 *
 * Background (2026-05-29): Variety's current layout injects promo modules
 * MID-ARTICLE inside div.a-content — `injected-related-story` ("Related
 * Stories") and `pmc-contextual-player` ("Popular on Variety"). The old DOM
 * patterns matched the first `</div></article>` and returned ~600–840 chars
 * (lede + bled-in promo link text), silently truncating EVERY Variety review.
 * Static HTML, so the production fetch path truncated too. Confirmed on 3 live
 * reviews (rocky-horror 836, beaches 632, balusters 738) while the real review
 * body is ~5.2–5.9K chars.
 *
 * Fix: extractVarietyBody slices a-content → first post-body marker, strips the
 * two promo containers by balanced-div removal, then collects review <p> prose.
 * This guards against a silent regression to the truncating DOM pattern.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

describe('article-extractor: Variety promo-interleaved a-content', () => {
  test('captures full review prose and excludes mid-article promo modules', () => {
    const html =
      '<html><body><article>' +
      '<div class="a-content a-content--logo-end lrv-a-font-body-s">' +
        '<p>' + 'The production opens with genuine wit and a sharp sense of its own absurdity. '.repeat(4) + '</p>' +
        // Mid-article "Related Stories" promo — must NOT leak
        '<div class="injected-related-story // lrv-u-margin-tb-1">' +
          '<h3>Related Stories</h3>' +
          '<p><a href="/film/news/some-movie">Will Smith to Star in Action Thriller</a></p>' +
        '</div>' +
        '<p>' + 'The performances deepen as the evening goes on, finding unexpected pathos. '.repeat(4) + '</p>' +
        // "Popular on Variety" widget — must NOT leak
        '<div class="pmc-contextual-player">' +
          '<span>Popular on Variety</span>' +
          '<p><a href="/tv">Some unrelated trending TV story</a></p>' +
        '</div>' +
        '<p>' + 'By the final scene the show has earned its standing ovation and then some. '.repeat(4) + '</p>' +
      '</div>' +
      '<div class="related">Read More About: Broadway</div>' +
      '</article></body></html>';
    const text = extractArticleText(html, 'variety.com');
    assert.ok(text, 'extractor should return text');
    assert.ok(text.includes('genuine wit'), 'opening paragraph captured');
    assert.ok(text.includes('unexpected pathos'), 'middle paragraph (after promo) captured');
    assert.ok(text.includes('standing ovation'), 'closing paragraph captured');
    assert.ok(!text.includes('Will Smith'), `injected-related-story leaked: …${text.slice(-120)}`);
    assert.ok(!text.includes('Popular on Variety'), 'pmc-contextual-player heading leaked');
    assert.ok(!text.includes('trending TV story'), 'pmc-contextual-player link leaked');
    assert.ok(!text.includes('Read More About'), 'post-body marker leaked');
  });

  test('does not truncate at the first nested </div></article> (the old bug)', () => {
    // The old pattern stopped at the first </div></article>; here the body has
    // nested divs, so a correct extractor must reach the final paragraph.
    const html =
      '<html><body><article>' +
      '<div class="a-content">' +
        '<p>' + 'First substantial paragraph of the actual Variety review prose here. '.repeat(4) + '</p>' +
        '<div class="injected-related-story"><p><a href="/x">Promo</a></p></div>' +
        '<p>The closing verdict that the old truncating pattern dropped entirely.</p>' +
      '</div></article></body></html>';
    const text = extractArticleText(html, 'variety.com');
    assert.ok(text.includes('closing verdict that the old truncating pattern dropped'),
      'body after the injected promo div was truncated — regression');
  });
});
