// BRO-6900: the Daily Mail prints its verdict as a bold heading paragraph,
// "Rating: Four out of five stars". Two bugs lost it: the text extractor
// stored the body without that line (or read the page's inline JavaScript),
// and the spelled-out star pattern read "five stars" out of it as 5/5.
// Synthetic page in the live 2026-10 markup shape; no review text is copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractArticleTextFromUrl, extractDailyMailBody } = require('./article-extractor.js');
const { extractScore } = require('./score-extractors.js');

const URL = 'https://www.dailymail.com/tvshowbiz/article-1/PATRICK-MARMION-reviews-Show.html';
const para = (t, bold) => `<p class="mol-para-with-font${bold ? ' mol-style-bold' : ''}">${t}</p>`;
const body = Array.from({ length: 12 }, (_, i) =>
  para(`Body paragraph ${i} describes the staging, the cast and the evening in some detail for the reader.`)).join('');
const page = (rating) => '<html><head><script>var junk = "' + 'x'.repeat(5000) + '";</script></head><body>'
  + '<script>window.DM = { features: {} };</script>'
  + '<div itemprop="articleBody">' + para('Some Show (Some Theatre, London)', true)
  + para(`Rating: ${rating}  `, true) + body + '</div>'
  + '<div class="related">' + 'Other story headline. '.repeat(40) + '</div></body></html>';

test('the Daily Mail body keeps the rating heading and drops the scripts', () => {
  const text = extractArticleTextFromUrl(page('Four out of five stars'), URL, 'Patrick Marmion');
  assert.match(text, /^Some Show \(Some Theatre, London\)\n\nRating: Four out of five stars\n\nBody paragraph 0/);
  assert.doesNotMatch(text, /junk|window\.DM|Other story headline/);
  for (const host of ['www.dailymail.co.uk', 'newspaper.dailymail.com']) {
    assert.match(extractArticleTextFromUrl(page('Four out of five stars'), `https://${host}/a.html`, ''), /Rating: Four out of five stars/);
  }
});

test('a page without the mol-para run falls through to the generic extractor', () => {
  const html = '<html><body><article>' + '<p>A different markup shape for the same review, long enough to keep.</p>'.repeat(8) + '</article></body></html>';
  assert.equal(extractDailyMailBody(html), '');
  assert.match(extractArticleTextFromUrl(html, URL, ''), /A different markup shape/);
});

test('"N out of five stars" reads the numerator, never the denominator', () => {
  for (const [rating, want] of [['Four out of five stars', '4/5 stars'], ['Two out of five stars', '2/5 stars'],
    ['One out of five stars', '1/5 stars'], ['Five out of five stars', '5/5 stars'], ['Three out of 5 stars', '3/5 stars']]) {
    const html = page(rating);
    const text = extractArticleTextFromUrl(html, URL, '');
    for (const outlet of ['daily-mail', 'mail-on-sunday', 'some-blog']) {
      assert.equal(extractScore(html, text, outlet, 'Some Show')?.originalScore, want, `${outlet}: ${rating}`);
    }
  }
});

test('plain spelled-out stars still read as before', () => {
  const html = page('Four stars');
  const text = extractArticleTextFromUrl(html, URL, '');
  assert.equal(extractScore(html, text, 'daily-mail', 'Some Show')?.originalScore, '4/5 stars');
});

test('a body recovered by empty-body-retry carries the page star (one verdict only)', () => {
  const { recoveryPatch } = require('./empty-body-retry.js');
  const show = { id: 'some-show-west-end-2026', title: 'Some Show', openingDate: '2026-10-01', category: 'west-end' };
  const stub = { outletId: 'daily-mail', criticName: 'Patrick Marmion', url: URL, publishDate: '2026-10-02' };
  const html = page('Four out of five stars').replace(/Body paragraph/g, 'Some Show paragraph');
  const patch = recoveryPatch(stub, { content: html, source: 'brightdata' }, show);
  assert.ok(patch, 'patch built');
  assert.equal(patch.originalScore, '4/5 stars');
  assert.equal(patch.originalScoreNormalized, 80);
  assert.equal(patch.originalScoreSource, 'word-stars');
  assert.equal(patch.scoreExtractedFrom, 'scraped-html');

  // Never over a score the file already has, nor over a deliberate clear.
  assert.equal(recoveryPatch({ ...stub, originalScore: '3/5' }, { content: html, source: 'brightdata' }, show).originalScore, undefined);
  assert.equal(recoveryPatch({ ...stub, originalScoreCleared: true }, { content: html, source: 'brightdata' }, show).originalScore, undefined);

  // A bundled page (two verdicts) gives no star: the first may be another show's.
  const bundled = html.replace('</div><div class="related">', para('Rating: Two out of five stars', true) + '</div><div class="related">');
  assert.equal(recoveryPatch(stub, { content: bundled, source: 'brightdata' }, show).originalScore, undefined);
});

test('one review printing its star twice is not a bundled page; disagreeing stars are', () => {
  const { dailyMailVerdictValues } = require('./article-extractor.js');
  const img = '<img src="https://i.dailymail.co.uk/i/pix/rating_showbiz_4.gif" data-src="https://i.dailymail.co.uk/i/pix/rating_showbiz_4.gif">';
  const once = page('Four out of five stars').replace('<div itemprop="articleBody">', '<div itemprop="articleBody">' + img);
  assert.deepEqual(dailyMailVerdictValues(once), [4]);
  assert.equal(extractScore(once, extractArticleTextFromUrl(once, URL, ''), 'daily-mail', 'Some Show')?.originalScore != null, true);
  const { recoverScoreFromHtml } = require('./ingest-html-score.js');
  assert.ok(recoverScoreFromHtml(once, '', 'daily-mail', 'Some Show'), 'same star twice still recovers');
  const twoShows = once.replace('</div><div class="related">', para('Rating: Two out of five stars', true) + '</div><div class="related">');
  assert.deepEqual(dailyMailVerdictValues(twoShows).sort(), [2, 4]);
  assert.equal(recoverScoreFromHtml(twoShows, '', 'daily-mail', 'Some Show'), null);
  // Paragraphs after the articleBody div (related teasers) are not the review.
  const tail = page('Four out of five stars').replace('<div class="related">', '<div class="related">' + para('Related: another story entirely, Rating: Two out of five stars'));
  assert.doesNotMatch(extractDailyMailBody(tail), /another story/);
  assert.deepEqual(dailyMailVerdictValues(tail), [4]);
});

test('a textless re-discovery keeps the star read with the recovered body', () => {
  const { mergePendingRecord } = require('./pending-review-health.js');
  const existing = { fullText: 'x'.repeat(400), contentTier: 'complete', originalScore: '4/5 stars', originalScoreNormalized: 80,
    originalScoreSource: 'word-stars', scoreExtractedFrom: 'scraped-html' };
  assert.equal(mergePendingRecord(existing, { url: URL }).originalScore, '4/5 stars');
  assert.equal(mergePendingRecord(existing, { url: URL, originalScore: '3/5' }).originalScore, '3/5');
});

// Ship-check follow-ups (BRO-6900): markup inside the verdict line, and prose false positives.
import { createRequire as __cr } from 'node:module';
import __test from 'node:test';
import __assert from 'node:assert/strict';
{
  const { extractScore } = __cr(import.meta.url)('./score-extractors.js');
  const pad = ' lorem ipsum dolor.'.repeat(300);
  __test('BRO-6900: nbsp or tag inside the verdict line still reads 4/5, never 5/5', () => {
    for (const h of ['Rating: Four out of&nbsp;five stars', 'Rating: Four out of <b>five stars</b>']) {
      const r = extractScore('', `${pad}<p>${h}</p>${pad.slice(0, 50)}`, 'daily-mail');
      __assert.equal(r && r.normalizedScore, 80);
    }
  });
  __test('BRO-6900: prose "one out of five stars in the cast" is not a rating', () => {
    __assert.equal(extractScore('Only one out of five stars in the cast truly shines', '', 'some-blog'), null);
  });
}

// BRO-6448: a 2013 review prints plain <p> tags in the articleBody div (no mol-para
// class). The extractor returned '' and the generic fallback kept the anti-adblock
// script as the stored text, so the file was tiered invalid. Synthetic markup only.
test('a pre-2014 articleBody with plain <p> paragraphs is extracted, scripts dropped', () => {
  const plain = Array.from({ length: 10 }, (_, i) =>
    `<p><font style="font-size: 1.2em;">Legacy paragraph ${i} covers the staging and the cast in enough detail to count.</font></p>`).join('');
  const html = '<html><head><script>var adblock = "' + 'x'.repeat(5000) + '";</script></head><body>'
    + '<div itemprop="articleBody"><p><strong>Show title</strong></p>' + plain + '</div>'
    + '<div class="related">' + 'Other story headline. '.repeat(40) + '</div></body></html>';
  const text = extractArticleTextFromUrl(html, 'http://www.dailymail.co.uk/tvshowbiz/reviews/article-1/x.html', 'Quentin Letts');
  assert.match(text, /^Show title\n\nLegacy paragraph 0/);
  assert.doesNotMatch(text, /adblock|Other story headline/);
  assert.equal(extractDailyMailBody(html).split('\n\n').length, 11);
});

// BRO-7080: the hyphenated and digit forms of the BRO-6900 verdict line. The
// hyphen kept OUT_OF_FIVE_WORD_STARS from matching, and the bare "five stars"
// pattern then read the denominator as 5/5 on every star outlet.
{
  const { extractScore } = __cr(import.meta.url)('./score-extractors.js');
  const pad = ' lorem ipsum dolor.'.repeat(300);
  for (const outlet of ['daily-mail', 'telegraph', 'theargus']) {
    for (const [line, want] of [
      ['Rating: Four-out-of-five stars', 80],
      ['Rating: four out-of-five stars', 80],
      ['Rating: Three-out-of-five stars', 60],
      ['Rating: 4 out of five stars', 80],
    ]) {
      __test(`BRO-7080: ${outlet} "${line}" reads ${want}, never 100`, () => {
        const r = extractScore('', `${pad}<p>${line}</p>${pad.slice(0, 50)}`, outlet);
        __assert.equal(r && r.normalizedScore, want);
      });
    }
  }
  __test('BRO-7080: "4.4 out of five stars" style decimals are not read as 4/5', () => {
    const r = extractScore('', `${pad}<p>Rating: 3.4 out of five stars</p>${pad.slice(0, 50)}`, 'daily-mail');
    __assert.notEqual(r && r.normalizedScore, 80);
  });
}
