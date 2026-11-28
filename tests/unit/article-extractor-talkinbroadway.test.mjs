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
  test('accented critic name (Kimberly Ramírez, Good Time Charlie 2026-10-09) still extracts the review', () => {
    const reviewBody = 'Haddad stages a sprawling family drama in a backyard. '.repeat(15);
    const html =
      '<html><body>' + NEWSLETTER_CHROME +
      "<section class='page'>" +
      "<P><B>Theatre Review by <A HREF='mailto:k@talkinbroadway.com'>Kimberly Ramírez</A> - October 9, 2026</B></CENTER>" +
      `<P>${reviewBody}` +
      '</section></body></html>';
    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text, 'an accent in the byline must not make extraction return nothing');
    assert.ok(text.includes('sprawling family drama'));
    assert.ok(!text.includes('Sound Advice Weekly'));
  });

  test('regional page: undated "Review by" byline with no "Theatre" (ch944 shape, BRO-7262)', () => {
    const reviewBody = 'Steppenwolf stages a quiet, sharp new play about four friends. '.repeat(12);
    const html =
      '<html><body>' + NEWSLETTER_CHROME +
      '<p><font size="+2"><b>Adirondack Chair Circle</b></font><br><font size="+1" class="font-center">Steppenwolf Theatre<br> </font>' +
      'Review by Karen Topham </p><p><font size="-1">Also see the review of <a href="ch943.html"><i>King Hedley II</i></a></font></p>' +
      `<p>${reviewBody}</p>` +
      '</body></html>';
    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text, 'should extract review text');
    assert.ok(text.startsWith('Review by Karen Topham'), text.slice(0, 80));
    assert.ok(text.includes('four friends'));
    assert.ok(!text.includes('Sound Advice'), 'newsletter chrome excluded');
  });

  test('regional byline page: the "Discover more" ad strip and "Share:" footer are cut (BRO-7262)', () => {
    const reviewBody = 'Steppenwolf stages a quiet, sharp new play about four friends. '.repeat(12);
    const html =
      '<html><body>' + NEWSLETTER_CHROME +
      'Review by Karen Topham </p>' +
      `<p>${reviewBody}</p>` +
      '<span>Discover more</span><span>Theater tickets</span><p>Share:</p><p>Copyright 2026</p>' +
      '</body></html>';
    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text && text.includes('four friends'));
    assert.ok(!text.includes('Discover more'), 'ad strip excluded');
    assert.ok(!text.includes('Share:'), 'share footer excluded');
    assert.ok(!text.includes('Copyright'), 'copyright excluded');
  });

  test('regional page: prose "review by" is not a byline', () => {
    const html = '<html><body>' + NEWSLETTER_CHROME +
      '<p>As a review by the Times put it, the play drags. ' + 'More prose here. '.repeat(30) + '</p></body></html>';
    assert.equal(extractArticleText(html, 'www.talkinbroadway.com'), null);
  });

  test('regional page: "Review by Name | Season Schedule" byline anchors extraction (BRO-7262 review)', () => {
    const reviewBody = 'Phoenix Theatre Company mounts a bright revival of the musical. '.repeat(12);
    const html = '<html><body>' + NEWSLETTER_CHROME +
      '<p><b>Some Show</b><br>Phoenix Theatre Company<br>Review by Gil Benbrook | <a href="s.html">Season Schedule</a></p>' +
      `<p>${reviewBody}</p></body></html>`;
    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text && text.startsWith('Review by Gil Benbrook'), String(text).slice(0, 80));
    assert.ok(text.includes('bright revival'));
  });

  test('dated page: a stray "Review by" link does not move the start (BRO-7262 review)', () => {
    const reviewBody = 'This immersive haunted-house show delivers real scares. '.repeat(15);
    const html = '<html><body><a href="r.html">Review by Region</a>' + NEWSLETTER_CHROME +
      "<P><B>Theatre Review by <A HREF='mailto:hm@x'>Howard Miller</A> - October 26, 2026</B>" +
      `<P>${reviewBody}</body></html>`;
    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text && text.startsWith('Theatre Review by Howard Miller'), String(text).slice(0, 80));
  });
  test('older unsigned regional page: anchors after the photo credit, stops at the footer (BRO-7262)', () => {
    const para = 'The ensemble carries the history play with clarity and force. '.repeat(6);
    const html = '<html><body>' + NEWSLETTER_CHROME +
      '<p>Regional Reviews: Chicago</p><p><i>Some History Play</i><br><font>Fleetwood Theatre</font>' +
      "<br><font>Also see Christine's reviews of <i>Three Sisters</i></font></p>" +
      '<table><tr><td><b>Cast Member and Other Actor</b><br><font><i>Photo by Basil Clunie</i></font></td></tr></table>' +
      `<p>${para}</p><p>${para}</p><p><i>Some History Play</i> runs through July 14, 2024.</p>` +
      '<div>Discover more</div><span>Broadway show tickets</span><p>Share:</p></body></html>';
    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text, 'older layout extracts');
    assert.ok(text.startsWith('The ensemble carries'), text.slice(0, 80));
    assert.ok(text.includes('runs through July 14'));
    for (const chrome of ['Sound Advice', 'Photo by', 'Also see', 'Discover more', 'Broadway show tickets', 'Share:']) {
      assert.ok(!text.includes(chrome), `excludes ${chrome}`);
    }
  });

  test('older unsigned layout: two "Regional Reviews:" headers (stacked runs) are refused (BRO-7262)', () => {
    const para = 'A long paragraph of review prose for the stacked run. '.repeat(8);
    const html = '<html><body><p>Regional Reviews: Chicago</p><p>' + para + '</p>' +
      '<p>Regional Reviews: Chicago</p><p>' + para + '</p></body></html>';
    assert.equal(extractArticleText(html, 'www.talkinbroadway.com'), null);
  });

  test('older unsigned layout: a regional listing page (no "Also see" line) is not a review (BRO-7262 review)', () => {
    const links = Array.from({ length: 30 }, (_, i) => `<li><a href="ch${700 + i}.html">Some Show ${i}</a> - Some Theatre</li>`).join('');
    const html = '<html><body>' + NEWSLETTER_CHROME + `<p>Regional Reviews: Chicago</p><ul>${links}</ul><p>Share:</p></body></html>`;
    assert.equal(extractArticleText(html, 'www.talkinbroadway.com'), null);
  });

  test('older unsigned layout with no "Also see" line: the photo credit marks the review (ch790 Macbeth shape, BRO-7262)', () => {
    const para = 'Invictus stages a lean, candlelit tragedy with a sharp ensemble. '.repeat(10);
    const html = '<html><head><title>Chicago - "The Tragedy of Macbeth"</title></head><body>' + NEWSLETTER_CHROME + '<p>Share:</p>' +
      '<p>Regional Reviews: Chicago</p><i>The Tragedy of Macbeth</i><font>Invictus Theatre Company</font>' +
      '<b>Carolyn Kruse and Mikha\'el Amin</b><br><font size="-2"><i>Photo by Aaron Reese Boseman Photography</i></font>' +
      `<p>${para}</p><p>${para}</p><p>Invictus Theatre Company's <i>The Tragedy of Macbeth</i> runs through May.</p>` +
      '<p>Share:</p><p>Copyright 1997 - 2026</p></body></html>';
    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text && text.includes('candlelit tragedy'), String(text).slice(0, 80));
    assert.ok(!text.includes('Photo by'), 'photo credit excluded');
    assert.ok(!text.includes('Share:') && !text.includes('Copyright'), 'footer excluded');
    assert.ok(!text.includes('Sound Advice'), 'newsletter chrome excluded');
  });

  test('older unsigned layout: a photo credit far below the header does not qualify a listing page (BRO-7262)', () => {
    const links = Array.from({ length: 60 }, (_, i) => `<li><a href="ch${700 + i}.html">Some Show ${i}</a> - Some Theatre</li>`).join('');
    const html = '<html><body><p>Regional Reviews: Chicago</p><ul>' + links + '</ul><i>Photo by Someone</i>' + '<p>' + 'x '.repeat(400) + '</p></body></html>';
    assert.equal(extractArticleText(html, 'www.talkinbroadway.com'), null);
  });

  test('older unsigned layout: a stacked page with two photo credits and no "Also see" is refused (BRO-7262 review)', () => {
    const para = 'Prose for one of two stacked runs on a single page. '.repeat(8);
    const html = '<html><body><p>Regional Reviews: Chicago</p><i>Show A</i><i>Photo by X</i><p>' + para +
      '</p><i>Show B</i><i>Photo by Y</i><p>' + para + '</p></body></html>';
    assert.equal(extractArticleText(html, 'www.talkinbroadway.com'), null);
  });

  test('older unsigned layout: a stacked page with a Share bar between its reviews is refused (BRO-7262 review)', () => {
    const para = 'Prose for one of two stacked runs on a single page. '.repeat(8);
    const html = "<html><body><p>Regional Reviews: Chicago</p><font>Also see Karen's reviews of <i>A</i></font><p>" + para +
      "</p><p>Share:</p><font>Also see Karen's reviews of <i>B</i></font><p>" + para + '</p></body></html>';
    assert.equal(extractArticleText(html, 'www.talkinbroadway.com'), null);
  });

  test('older unsigned layout: a listing page with a photo near the top is refused (BRO-7262 review)', () => {
    const links = Array.from({ length: 40 }, (_, i) => `<li><a href="ch${700 + i}.html">Some Show ${i}</a> - Some Theatre</li>`).join('');
    const html = '<html><body><p>Regional Reviews: Chicago</p><i>Photo by Z</i><ul>' + links + '</ul></body></html>';
    assert.equal(extractArticleText(html, 'www.talkinbroadway.com'), null);
  });

  test('older unsigned layout: a table-wrapped caption is skipped whole, prose in a following table is kept (BRO-7262 review)', () => {
    const para = 'Prose that starts in a table row and must survive the skip. '.repeat(8);
    const html = "<html><body><p>Regional Reviews: Chicago</p><font>Also see Karen's reviews of <i>A</i></font>" +
      '<table><tr><td><b>Cast A and B</b><br><font><i>Photo by Q</i></font></td></tr></table>' +
      '<table><tr><td>First short para kept.</td></tr><tr><td>' + para + '</td></tr></table></body></html>';
    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text && text.includes('First short para kept.'), String(text).slice(0, 80));
    assert.ok(!text.includes('Photo by') && !text.includes('Cast A and B'));
  });

  test('older unsigned layout: two "Also see" lines under one header (stacked) are refused (BRO-7262 review)', () => {
    const para = 'Prose for one of two stacked runs on a single page. '.repeat(8);
    const html = "<html><body><p>Regional Reviews: Chicago</p><font>Also see Karen's reviews of <i>A</i></font><p>" + para +
      "</p><font>Also see Karen's reviews of <i>B</i></font><p>" + para + '</p></body></html>';
    assert.equal(extractArticleText(html, 'www.talkinbroadway.com'), null);
  });

  test('older unsigned layout without a photo starts at the header (BRO-7262)', () => {
    const para = 'A clear and confident staging that rewards attention. '.repeat(8);
    const html = '<html><head><title>Regional Reviews: Chicago - "Play"</title></head><body>' + NEWSLETTER_CHROME +
      "<p>Regional Reviews: Chicago</p><p><font>Also Christine's review of <i>Three Sisters</i></font></p><p>" + para + '</p><p>Share:</p></body></html>';
    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text && text.startsWith('Regional Reviews: Chicago'), String(text).slice(0, 80));
    assert.ok(!text.includes('Share:') && !text.includes('Sound Advice'));
  });
  test('older unsigned layout: an HTML-encoded apostrophe in "Also see Karen&#39;s" still qualifies (BRO-7262)', () => {
    const para = 'Confident direction and a sharp ensemble. '.repeat(10);
    for (const ap of ['&#39;', '&rsquo;', '&#8217;']) {
      const html = `<html><body><p>Regional Reviews: Chicago</p><font>Also see Karen${ap}s reviews of <i>A</i></font><p>${para}</p><p>Share:</p></body></html>`;
      assert.ok(extractArticleText(html, 'www.talkinbroadway.com'), ap);
    }
  });
});
