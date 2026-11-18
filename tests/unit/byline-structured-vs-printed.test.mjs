/**
 * BRO-7745 — a page's structured author (JSON-LD / meta / CMS account) is the
 * person who POSTED it, not always the critic. TheaterMania's JSON-LD names the
 * posting editor (/author/dgordon/ = David Gordon) while the visible byline
 * <a id="article-author-tag" href="/authors/dan-rubins">Dan Rubins</a> names the
 * critic; All That Dazzles' meta/JSON-LD is the poster ("Sam Woodward") while
 * the body prints "Review by Ruth Sealey"; Theatre and Tonic's Squarespace
 * author is the account holder while the review ends "Written by Roby for
 * Theatre and Tonic". extractAuthorFromHtml used to return the structured name.
 *
 * Fixtures are trimmed byline-only excerpts of the live pages (2026-11-18);
 * no review text is stored here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractAuthorFromHtml, cleanAuthorName } = require('../../scripts/lib/content-quality.js');
const { detectBylineConflict, extractTheaterManiaAuthorTag } = require('../../scripts/lib/byline-extraction.js');

// TheaterMania roster as the gitignored critic registry lists it; injected so
// the test does not depend on data/critic-registry.json being on disk.
const TM_ROSTER = ['David Gordon', 'Dan Rubins', 'Zachary Stewart', 'Pete Hempstead'];
const TM_URL = 'https://www.theatermania.com/news/review-blue-man-groups-broadway-christmas-show-is-a-lump-of-coal_1860029/';
const TM_JSONLD = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"NewsArticle","author":{"@id":"https:\\/\\/www.theatermania.com\\/author\\/dgordon\\/#author"},"publisher":{"@id":"https:\\/\\/www.theatermania.com\\/#organization"}}]}</script>';
const TM_AUTHOR_AREA = '<section class="author-area d-flex align-items-center mb-4">\n    <a href="https://www.theatermania.com/authors/dan-rubins" rel="noopener noreferrer"><img class="square-image-author" src="x.jpg" alt="Dan Rubins" /></a><p class="author-name mb-0 me-2 text-decoration-none text-blue"><a id="article-author-tag" class="text-decoration-none text-blue" href="https://www.theatermania.com/authors/dan-rubins" rel="noopener noreferrer">Dan Rubins</a></p>\n    <span class="me-2 text-blue">|</span>\n    <p id="article-date-tag" class="mb-0">November 17, 2026</p>\n</section>';
const TM_PAGE = `<html><head>${TM_JSONLD}</head><body><h1>Review</h1>${TM_AUTHOR_AREA}<div class="news-content"><p>…</p></div></body></html>`;
// Same template with the author area left empty (47 older reviews today).
const TM_EMPTY_AREA_PAGE = `<html><head>${TM_JSONLD}</head><body><section class="author-area d-flex align-items-center mb-4">\n<span class="me-2 text-blue">|</span>\n<p id="article-date-tag" class="mb-0">January 21, 2020</p>\n</section></body></html>`;

describe('TheaterMania: the visible byline beats the JSON-LD editor slug', () => {
  test('Blue Man Group page credits Dan Rubins, not the posting editor', () => {
    assert.equal(extractAuthorFromHtml(TM_PAGE, '', { url: TM_URL, theaterManiaCritics: TM_ROSTER }), 'Dan Rubins');
  });
  test('the visible tag is read without a url (callers that pass none)', () => {
    assert.equal(extractTheaterManiaAuthorTag(TM_PAGE), 'Dan Rubins');
    assert.equal(extractAuthorFromHtml(TM_PAGE, '', { theaterManiaCritics: TM_ROSTER }), 'Dan Rubins');
  });
  test('an empty author area names nobody: the editor slug is not a byline', () => {
    assert.equal(extractAuthorFromHtml(TM_EMPTY_AREA_PAGE, '', { url: TM_URL, theaterManiaCritics: TM_ROSTER }), null);
  });
  test('an author-area name in a markup variant (span-wrapped, no tag id) is still read', () => {
    const variant = TM_PAGE.replace(/<a id="article-author-tag"[^>]*>Dan Rubins<\/a>/, '<a href="https://www.theatermania.com/authors/dan-rubins"><span>Dan Rubins</span></a>');
    assert.equal(extractAuthorFromHtml(variant, '', { url: TM_URL, theaterManiaCritics: TM_ROSTER }), 'Dan Rubins');
  });
  // BRO-7777 (a): the @id slug is the POSTING account, so an old template with no author area
  // never resolves it. A printed "By Name" opening line is read; otherwise nobody.
  test('an old template with no author area does not trust the JSON-LD slug (BRO-7777)', () => {
    const old = `<html><head>${TM_JSONLD.replace('dgordon', 'phempstead')}</head><body><h1>x</h1></body></html>`;
    assert.equal(extractAuthorFromHtml(old, '', { url: TM_URL, theaterManiaCritics: TM_ROSTER }), null);
    assert.equal(extractAuthorFromHtml(old, 'By Kenji Fujishima\nThe review opens here.', { url: TM_URL, theaterManiaCritics: TM_ROSTER }), 'Kenji Fujishima');
  });
});

const ATD_URL = 'https://www.allthatdazzles.co.uk/post/review-memoriam-southwark-playhouse-borough';
const ATD_HEAD = '<meta property="article:author" content="Sam Woodward"/><script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","author":{"@type":"Person","name":"Sam Woodward","url":"https://www.allthatdazzles.co.uk/profile/srgwoodward14262/profile"}}</script>';
const ATD_PAGE = `<html><head>${ATD_HEAD}</head><body><p class="_7d56m"><span><strong><span><span>Review by Ruth Sealey</span></span></strong></span></p></body></html>`;
const ATD_TEXT = 'Sam Woodward Oct 27 5 min read Review by Ruth Sealey ⭐️⭐️⭐️⭐️⭐️ Virtual reality technology has moved on.';

const TT_URL = 'https://theatreandtonic.co.uk/blog/rent-at-tom-stoppard-theatre-review';
const TT_PAGE = '<html><body><div class="blog-meta-item blog-meta-item--author p-author author" data-content-field="author">Written by <a href="/blog?author=1" class="blog-author-name">Penny Walshe</a></div><p><em>Written by Roby for Theatre and Tonic, October 2026.</em></p></body></html>';
const TT_TEXT = 'Rent Review Reviews 9 Oct Written by Penny Walshe It has been a long time. Written by Roby for Theatre and Tonic, October 2026.';

describe('Printed-credit outlets: the article\'s own credit beats the CMS author', () => {
  test('All That Dazzles: "Review by Ruth Sealey" beats meta/JSON-LD poster Sam Woodward', () => {
    assert.equal(extractAuthorFromHtml(ATD_PAGE, ATD_TEXT, { url: ATD_URL }), 'Ruth Sealey');
  });
  test('Theatre and Tonic: "Written by Roby for Theatre and Tonic" beats the account holder', () => {
    assert.equal(extractAuthorFromHtml(TT_PAGE, TT_TEXT, { url: TT_URL }), 'Roby');
  });
  test('a Squarespace "Written by <a>Name</a>" header yields the name, not "Written by"', () => {
    assert.equal(extractAuthorFromHtml(TT_PAGE, '', {}), 'Penny Walshe');
  });
  test('a printed first name for the same person keeps the fuller CMS name', () => {
    const text = TT_TEXT.replace('Written by Roby', 'Written by Penny');
    assert.equal(extractAuthorFromHtml(TT_PAGE, text, { url: TT_URL }), 'Penny Walshe');
  });
});

describe('Title suffixes are not part of the name', () => {
  test('"Victor Gluck, Editor-in-Chief" (Theater Scene meta) is cleaned to the person', () => {
    assert.equal(cleanAuthorName('Victor Gluck, Editor-in-Chief'), 'Victor Gluck');
  });
});

describe('Ingest guard: structured author chosen while a visible byline disagrees', () => {
  test('flags the old TheaterMania outcome (editor slug chosen, visible Dan Rubins)', () => {
    const c = detectBylineConflict({ html: TM_PAGE, text: '', url: TM_URL, chosen: 'David Gordon' });
    assert.deepEqual(c, { structured: 'theatermania-slug:dgordon', visible: 'Dan Rubins' });
  });
  test('flags a meta/JSON-LD poster chosen over a printed credit', () => {
    const c = detectBylineConflict({ html: ATD_PAGE, text: ATD_TEXT, url: ATD_URL, chosen: 'Sam Woodward' });
    assert.deepEqual(c, { structured: 'Sam Woodward', visible: 'Ruth Sealey' });
  });
  test('no flag once the visible byline is chosen', () => {
    assert.equal(detectBylineConflict({ html: TM_PAGE, text: '', url: TM_URL, chosen: 'Dan Rubins' }), null);
    assert.equal(detectBylineConflict({ html: ATD_PAGE, text: ATD_TEXT, url: ATD_URL, chosen: 'Ruth Sealey' }), null);
  });
  test('no flag when structured and visible agree, or when there is no visible byline', () => {
    const agree = TM_PAGE.replace(/dan-rubins/g, 'david-gordon').replace(/Dan Rubins/g, 'David Gordon');
    assert.equal(detectBylineConflict({ html: agree, text: '', url: TM_URL, chosen: 'David Gordon' }), null);
    assert.equal(detectBylineConflict({ html: TM_EMPTY_AREA_PAGE, text: '', url: TM_URL, chosen: 'David Gordon' }), null);
  });
  test('house accounts (chosen differs from structured) do not flag', () => {
    const hub = '<meta name="author" content="The Reviews Hub - London"><p class="sub">Reviewer: Scott Matthewman</p>';
    assert.equal(detectBylineConflict({ html: hub, text: '', url: 'https://www.thereviewshub.com/x/', chosen: 'Scott Matthewman' }), null);
  });
});
