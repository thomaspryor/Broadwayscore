/**
 * Nub News (nub.news) extraction — BRO-5219.
 *
 * The review body is <div id="article_content_block"> with ad banners nested
 * inside; there is no content class for the generic fallback to find, so it
 * kept the page's "The Ball is in your court" donation appeal and share chrome.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

const PARA = 'The cast handle the river comedy with real warmth and timing. ';

function page(body) {
  return '<html><body><header><nav>Local News Local Features</nav></header>' +
    '<div class="bg-white flex flex-col" id="article_content_wrapper_block">' +
    '<div id="article_content_block" class="prose max-w-none leading-snug">' +
    body +
    '</div></div>' +
    '<div class="watch-banner flex flex-wrap"><h2><b><mark>The Ball is in your court.</mark></b></h2>' +
    '<p>You can support us with a small payment or at least read us for free.</p>' +
    '<p>Monthly supporters will enjoy: Ad-free experience</p></div>' +
    '<p>Share:</p></body></html>';
}

describe('article-extractor: nub.news', () => {
  test('keeps the review paragraphs, drops nested ads and the donation appeal', () => {
    const html = page(
      `<p><strong>${PARA.repeat(3)}</strong></p>` +
      '<div class="mt-3 text-center"><span>advertisement</span><div class="watch-banner articles-middle"><a href="#"><img src="x.png"></a></div></div>' +
      `<p>${PARA.repeat(3)}</p><p>O&#039;Brien closes the piece. ${PARA.repeat(2)}</p>`
    );
    const text = extractArticleText(html, 'kingston.nub.news');
    assert.ok(text, 'expected extracted text');
    assert.match(text, /O'Brien closes the piece/);
    assert.doesNotMatch(text, /Ball is in your court|support us|Monthly supporters|advertisement|Share:/);
    assert.equal(text.split('\n\n').length, 3);
  });

  test('paragraph copy inside a nested watch-banner widget is dropped', () => {
    const html = page(
      `<p>${PARA.repeat(4)}</p>` +
      '<DIV class="mt-3"><div class="watch-banner articles-upper"><p>Sponsored: self storage in Kingston</p></div></DIV>' +
      '<!-- <div> stray comment markup -->' +
      `<p>${PARA.repeat(4)}</p>`
    );
    const text = extractArticleText(html, 'kingston.nub.news');
    assert.doesNotMatch(text, /Sponsored|self storage/);
    assert.equal(text.split('\n\n').length, 2);
  });

  test('page without the body block returns null rather than page chrome', () => {
    const html = '<html><body><p>' + 'You can support us with a small payment. '.repeat(20) + '</p></body></html>';
    assert.equal(extractArticleText(html, 'kingston.nub.news'), null);
  });
});
