/**
 * londontheatre.co.uk (LondonTheatre.co.uk) extraction — BRO-5904.
 *
 * Class names are CSS-in-JS (jssNNN); the review lives in
 * data-test-id="markdown-content" sections ahead of the FAQ block. Without a
 * PATTERNS entry the generic fallback kept nav/promo chrome (or, on some
 * builds, ~100 chars), so the review was fetched and silently lost.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

const PARA = 'Fall&#x27;s production is broadly sympathetic and solidly performed, if a little light. ';

const html =
  '<html><body><nav><p>Featured show</p><p>Journey through ABBA songs.</p></nav><main>' +
  '<h1 class="jss127">Review headline</h1>' +
  '<section class="jss146" data-test-id="markdown-content"><p>Read our review of <em>Abigail&#x27;s Party</em>, now at the Harold Pinter Theatre.</p></section>' +
  '<div class="rating"><svg></svg></div>' +
  '<section class="jss146" data-test-id="markdown-content">' +
  `<p>${PARA.repeat(3)}</p><p>${PARA.repeat(2)}</p>` +
  '<p><em>Abigail&#x27;s Party</em> is at the Harold Pinter Theatre to 19 September. Book <a>Abigail&#x27;s Party tickets</a> on LondonTheatre.co.uk</p><p><em>Photo credit: Abigail&#x27;s Party (Photos by Ellie Kurtz)</em></p></section>' +
  '<section class="jss140" id="faq-section"><h2>Frequently asked questions</h2>' +
  '<section data-test-id="markdown-content"><p>The running time of Abigail is 2hr 30min.</p></section></section>' +
  '<p>Henry Lewis to return to West End cast of Christmas Carol</p></main></body></html>';

describe('article-extractor: londontheatre.co.uk', () => {
  const out = extractArticleText(html, 'www.londontheatre.co.uk');
  test('keeps standfirst and body, decodes &#x27;', () => {
    assert.ok(out.includes('Read our review of Abigail\'s Party'));
    assert.ok(out.includes('to 19 September.'));
    assert.ok(out.includes("Fall's production is broadly sympathetic"));
  });
  test('drops FAQ, photo credit, nav and related rail', () => {
    for (const junk of ['running time', 'Photo credit', 'tickets on', 'Book Abigail', 'Featured show', 'Christmas Carol']) {
      assert.ok(!out.includes(junk), junk);
    }
  });
  test('does not apply to londontheatre1.com', () => {
    const other = extractArticleText(html, 'www.londontheatre1.com');
    assert.ok(other.includes('running time'), 'generic fallback, not the londontheatre.co.uk extractor');
  });
});
