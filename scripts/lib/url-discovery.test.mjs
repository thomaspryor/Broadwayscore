/**
 * BRO-928 acceptance test — Talkin' Broadway URL slug discovery + content
 * extraction, opening-night reliability.
 *
 * BRO-928's own evidence ("Tonight Fear of 13: scraper got 34 chars 'Books on
 * theater history...' from TheFearof132026.html... URL was correct") is the
 * exact incident later filed and fixed as task #1887 / BRO-912: the slug
 * guess was right, but the naive content scrape grabbed the newsletter-signup
 * sidebar (TB's only <article> tag) instead of the review body. Both pieces
 * of BRO-928's proposed fix landed in modules that didn't exist when this
 * ticket was filed:
 *   - slug variants + soft-404/wrong-show/date-window verification:
 *     scripts/lib/tb-direct-url.js (buildTbCandidateUrls / verifyTbPage)
 *   - byline-anchored content extraction (excludes the newsletter sidebar,
 *     isolates one run on multi-run "Past Reviews" pages):
 *     scripts/lib/article-extractor.js (extractTalkinBroadwayBody)
 * This file is the acceptance-criteria regression: it fails loudly if either
 * piece regresses back to a 404'd guess or a short garbage extraction.
 *
 * Run: node --test scripts/lib/url-discovery.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildTbCandidateUrls, verifyTbPage } = require('./tb-direct-url.js');
const { extractArticleText } = require('./article-extractor.js');

describe('BRO-928: Talkin\' Broadway slug discovery produces multiple candidates', () => {
  it('guesses more than one slug variant so a single wrong guess is not fatal', () => {
    const candidates = buildTbCandidateUrls('The Fear of 13', 2026);
    assert.ok(candidates.length >= 4, `expected >=4 slug variants, got ${candidates.length}`);
    assert.ok(new Set(candidates).size === candidates.length, 'variants must be distinct');
    // The exact slug the original incident hit — proves this show's guess is
    // still one of the candidates, not silently dropped by a later refactor.
    assert.ok(
      candidates.some((u) => u.endsWith('/TheFearof132026.html')),
      `expected a CamelCase+year candidate among: ${candidates.join(', ')}`
    );
  });
});

describe('BRO-928: verifyTbPage rejects a soft-404 / menu-only page', () => {
  it('rejects short content instead of accepting a 34-char menu scrape', () => {
    // Shape of the actual failure: page loads (200), but the "content" is a
    // few nav/menu fragments, nowhere near a real review.
    const menuGarbage = '<html><head><title>Talkin\' Broadway</title></head><body>Books on theater historyMicrophone equipment</body></html>';
    const v = verifyTbPage(menuGarbage, { showTitle: 'The Fear of 13', openingDate: '2026-04-19' });
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /content too short/, `expected the byte-length gate to fire, got: ${v.reason}`);
  });
});

describe('BRO-928: content extraction isolates the review body, not the newsletter sidebar', () => {
  it('extracts >2000 chars of real review prose, excluding the E-Blast sidebar', () => {
    const newsletterChrome =
      "<aside class='sidebar'><article class='newsletter'>" +
      "<h2>Talkin' Broadway E-Blast List</h2>" +
      "<label>Sound Advice Weekly html emails about new and upcoming theatre-related CD, DVD and Book releases.</label>" +
      '</article></aside>';
    const reviewSentence = 'This haunted-house immersive show earns its scares through committed performances and confident staging. ';
    const reviewBody = reviewSentence.repeat(Math.ceil(2100 / reviewSentence.length));
    const html =
      '<html><body>' + newsletterChrome +
      "<section class='page'>" +
      "<P><B>Theatre Review by <A HREF='mailto:hm@talkinbroadway.com'>Howard Miller</A> - April 19, 2026</B></CENTER>" +
      `<P>${reviewBody}` +
      '</section></body></html>';

    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.ok(text, 'should extract review text, not return null/empty');
    assert.ok(text.length > 2000, `expected >2000 chars per acceptance criteria, got ${text.length}`);
    assert.ok(!text.includes('Sound Advice Weekly'), 'newsletter sidebar chrome must not leak into the review text');
    assert.ok(text.includes('haunted-house immersive show'), 'real review prose must be present');
  });

  it('returns null (not the newsletter sidebar) when no byline marker is present', () => {
    const newsletterChrome =
      "<aside class='sidebar'><article class='newsletter'>" +
      "<h2>Talkin' Broadway E-Blast List</h2>" +
      '<label>Sound Advice Weekly.</label>' +
      '</article></aside>';
    const html = '<html><body>' + newsletterChrome + '</body></html>';
    const text = extractArticleText(html, 'www.talkinbroadway.com');
    assert.strictEqual(text, null, 'a non-review page must not fall through to the newsletter <article> tag');
  });
});
