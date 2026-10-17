/**
 * Talkin' Broadway (talkinbroadway.com) extraction — task #1887.
 *
 * TB's ONLY <article> tag on a review page is the "Talkin' Broadway E-Blast
 * List" newsletter-signup sidebar (containing the "Sound Advice Weekly"
 * checkbox label), so the generic <article> PATTERNS fallback confidently
 * grabbed that instead of the review — the paranormal-activity-2026 /
 * Howard Miller incident. The review itself lives in old-style markup with
 * no closing </p> tags, so the <p>...</p>-based paragraph-density fallback
 * misses it too. Fixed by anchoring on the site's "Theatre Review by
 * {Critic} - {date}" byline marker instead of guessing a DOM container.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

const NEWSLETTER_CHROME =
  "<aside class='sidebar'>" +
  "<article class='newsletter'>" +
  "<h2 class='newsletter-title'>Talkin' Broadway E-Blast List</h2>" +
  "<label><b>Sound Advice</b> Weekly html emails about new and upcoming theatre-related CD, DVD and Book releases.</label>" +
  "<label><b>Talkin Broadway E-blast</b> Periodic e-blasts for giveaways, discount notices and show announcements.</label>" +
  "</article>" +
  "</aside>";

describe('article-extractor: talkinbroadway.com', () => {
  test('single-review page: extracts the review, excludes the newsletter sidebar', () => {
    const reviewBody = 'This immersive haunted-house show delivers real scares. '.repeat(15);
    const html =
      '<html><body>' + NEWSLETTER_CHROME +
      "<section class='page'>" +
      "<CENTER><B>Paranormal Activity</B></CENTER>" +
      "<P><B>Theatre Review by <A HREF='mailto:hm@talkinbroadway.com'>Howard Miller</A> - October 26, 2026</B></CENTER>" +
      `<P>${reviewBody}` +
      '</section>' +
      '</body></html>';

    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text, 'should extract review text');
    assert.ok(text.includes('Theatre Review by'), 'byline marker should be included');
    assert.ok(text.includes('haunted-house show'), 'review prose should be included');
    assert.ok(!text.includes('Sound Advice Weekly'), `newsletter chrome leaked through: ${text.slice(0, 200)}`);
  });

  test('page with no "Theatre Review by" marker returns null (does not fall through to newsletter <article>)', () => {
    const html = '<html><body>' + NEWSLETTER_CHROME + '</body></html>';
    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.strictEqual(text, null, 'should not fall through to the generic <article> pattern');
  });

  test('stacked "Past Reviews" page (multiple runs on one URL): no critic hint picks the first review', () => {
    const run2023 = 'This is the two thousand twenty three run review text. '.repeat(15);
    const run2026 = 'This is the two thousand twenty six run review text, distinctly different. '.repeat(15);
    const html =
      '<html><body>' + NEWSLETTER_CHROME +
      "<section class='page'>" +
      "<P><B>Theatre Review by <A HREF='mailto:x'>Matthew Murray</A> - October 1, 2023</B></CENTER>" +
      `<P>${run2023}` +
      "<P><B>Theatre Review by <A HREF='mailto:y'>Howard Miller</A> - October 1, 2026</B></CENTER>" +
      `<P>${run2026}` +
      '</section></body></html>';

    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text, 'should extract text');
    assert.ok(text.includes('two thousand twenty three run'), 'no hint should default to the first review on the page');
    assert.ok(!text.includes('two thousand twenty six run'), 'should not bleed into the next stacked review');
    assert.ok(!text.includes('Sound Advice Weekly'));
  });

  test('stacked "Past Reviews" page: criticHint disambiguates to the matching review', () => {
    const run2023 = 'This is the two thousand twenty three run review text. '.repeat(15);
    const run2026 = 'This is the two thousand twenty six run review text, distinctly different. '.repeat(15);
    const html =
      '<html><body>' + NEWSLETTER_CHROME +
      "<section class='page'>" +
      "<P><B>Theatre Review by <A HREF='mailto:x'>Matthew Murray</A> - October 1, 2023</B></CENTER>" +
      `<P>${run2023}` +
      "<P><B>Theatre Review by <A HREF='mailto:y'>Howard Miller</A> - October 1, 2026</B></CENTER>" +
      `<P>${run2026}` +
      '</section></body></html>';

    const text = extractArticleText(html, 'www.talkinbroadway.com', 'Howard Miller');
    assert.ok(text, 'should extract text');
    assert.ok(text.includes('two thousand twenty six run'), 'criticHint should select the matching review');
    assert.ok(!text.includes('two thousand twenty three run'), 'should not include the other run');
  });

  test('stops at the embedded page\'s </body> close, excluding trailing site chrome', () => {
    const reviewBody = 'A genuinely unsettling and well-staged production overall. '.repeat(15);
    const html =
      '<html><body>' + NEWSLETTER_CHROME +
      "<section class='page'>" +
      "<P><B>Theatre Review by <A HREF='mailto:hm@talkinbroadway.com'>Howard Miller</A> - October 26, 2026</B></CENTER>" +
      `<P>${reviewBody}` +
      '</body></HTML>' +
      '</section>' +
      "<footer class='main-footer'><p>Copyright 1997 Talkin' Broadway</p></footer>" +
      '</body></html>';

    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text, 'should extract text');
    assert.ok(text.includes('unsettling and well-staged'));
    assert.ok(!text.includes('Copyright 1997'), 'trailing site footer should not be included');
  });

  test('a bare "Theatre Review by" phrase in review prose (not a real byline) does not truncate the review', () => {
    // Adversarial review finding (task #1887): the review's own text could
    // incidentally contain the literal phrase without a name+date following
    // it (e.g. quoting a headline convention) — that must not be treated as
    // a boundary marker.
    const reviewBody =
      'The critic noted that every outlet runs a "Theatre Review by" credit line these days, ' +
      'a convention this show fully earns with its inventive staging and committed performances. '.repeat(6);
    const html =
      '<html><body>' + NEWSLETTER_CHROME +
      "<section class='page'>" +
      "<P><B>Theatre Review by <A HREF='mailto:hm@talkinbroadway.com'>Howard Miller</A> - October 26, 2026</B></CENTER>" +
      `<P>${reviewBody}` +
      '</section></body></html>';

    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text, 'should extract text');
    assert.ok(text.includes('inventive staging'), `review truncated at the false marker: ${text.slice(0, 200)}`);
  });

  test('a punctuation-only criticHint falls back to the first review instead of matching every marker', () => {
    const run2023 = 'This is the two thousand twenty three run review text. '.repeat(15);
    const run2026 = 'This is the two thousand twenty six run review text, distinctly different. '.repeat(15);
    const html =
      '<html><body>' + NEWSLETTER_CHROME +
      "<section class='page'>" +
      "<P><B>Theatre Review by <A HREF='mailto:x'>Matthew Murray</A> - October 1, 2023</B></CENTER>" +
      `<P>${run2023}` +
      "<P><B>Theatre Review by <A HREF='mailto:y'>Howard Miller</A> - October 1, 2026</B></CENTER>" +
      `<P>${run2026}` +
      '</section></body></html>';

    const text = extractArticleText(html, 'www.talkinbroadway.com', '—');
    assert.ok(text, 'should extract text');
    assert.ok(text.includes('two thousand twenty three run'), 'punctuation-only hint should behave like no hint');
  });
});
