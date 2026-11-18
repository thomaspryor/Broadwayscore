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

// BRO-7777 (b): only the outlet's own printed-byline reader counts as the visible byline. A generic
// closing credit ("Review: X Photos Y") in an outlet without one used to flag the real critic.
describe('BRO-7777: detectBylineConflict ignores the generic text-tail credit', () => {
  const page = '<html><head><script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Person","name":"Jane Doe"}}</script></head><body></body></html>';
  test('a closing credit line in an outlet with no printed-byline reader is not a conflict', () => {
    const text = 'The production runs through March.\nReview: Emma Foxhall Photos Helen Murray';
    assert.equal(detectBylineConflict({ html: page, text, outletId: 'broadwayworld', chosen: 'Jane Doe' }), null);
  });
  test('the outlet reader still flags (All That Dazzles "Review by Ruth Sealey")', () => {
    const c = detectBylineConflict({ html: ATD_PAGE, text: ATD_TEXT, url: ATD_URL, outletId: 'all-that-dazzles-uk', chosen: 'Sam Woodward' });
    assert.deepEqual(c, { structured: 'Sam Woodward', visible: 'Ruth Sealey' });
  });
});

// BRO-7777 (c): ingest compared the name before the writer normalizes it, so an alias spelling of
// the same critic ("Zach Stewart" / "Zachary Stewart") raised a conflict warning.
describe('BRO-7777: the ingest conflict warning compares names as the writer stores them', () => {
  const { bylineConflictStands } = require('../../scripts/lib/page-byline.js');
  test('an alias of the visible byline is not a conflict', () => {
    assert.equal(bylineConflictStands('Zach Stewart', { structured: 'Zach Stewart', visible: 'Zachary Stewart' }), false);
  });
  test('a different person is', () => {
    assert.equal(bylineConflictStands('David Gordon', { structured: 'David Gordon', visible: 'Jonas Schwartz' }), true);
  });
  test('Unknown is never a conflict', () => {
    assert.equal(bylineConflictStands(null, { structured: 'x', visible: 'Jonas Schwartz' }), false);
  });
});

// BRO-7780: one reader for lane and ingest. An outlet rule that says "names nobody" ends the read.
describe('BRO-7780: readPageByline', () => {
  const { readPageByline } = require('../../scripts/lib/page-byline.js');
  const { extractByline } = require('../../scripts/lib/byline-extraction.js');
  const editorLd = TM_JSONLD.replace('{"@id":"https:\\/\\/www.theatermania.com\\/author\\/dgordon\\/#author"}', '{"@type":"Person","name":"David Gordon"}');
  test('TheaterMania tag beats a JSON-LD Person editor in the lane reader', () => {
    const page = `<html><head>${editorLd}</head><body>${TM_AUTHOR_AREA}</body></html>`;
    assert.equal(extractByline(page), 'Dan Rubins');
    assert.equal(readPageByline({ html: page, url: TM_URL, outletId: 'theatermania' }).criticName, 'Dan Rubins');
  });
  test('TheaterMania empty author area + JSON-LD Person editor names nobody', () => {
    const page = TM_EMPTY_AREA_PAGE.replace(TM_JSONLD, editorLd);
    const r = readPageByline({ html: page, url: TM_URL, outletId: 'theatermania' });
    assert.equal(r.criticName, null);
    assert.equal(r.source, 'outlet-rule-none');
  });
  test('a site-wide account host names nobody (BRO-6518)', () => {
    const page = '<html><head><meta name="author" content="Jacob Davis"><script type="application/ld+json">{"author":{"@type":"Person","name":"Jacob Davis"}}</script></head><body><span class="byline">By Jacob Davis</span></body></html>';
    assert.equal(readPageByline({ html: page, url: 'https://aroundthetownchicago.com/theatre-reviews/x/', outletId: 'around-the-town-chicago' }).criticName, null);
  });
  test('a publisher meta author loses to the Condé Nast name link', () => {
    const page = '<html><head><meta name="author" content="Condé Nast"></head><body><span>By </span><a class="byline__name-link button" href="/contributors/helen-shaw">Helen Shaw</a></body></html>';
    assert.equal(readPageByline({ html: page, url: 'https://www.newyorker.com/magazine/x', outletId: 'new-yorker' }).criticName, 'Helen Shaw');
  });
  test('a photo credit at the end of the text is never the byline', () => {
    const r = readPageByline({ html: '<html><body><h1>x</h1></body></html>', text: 'Body.\nReview: Joan Marcus Photos Helen Murray', url: 'https://www.broadwayworld.com/x', outletId: 'broadwayworld' });
    assert.equal(r.criticName, null);
  });
  test('link labels and a CamelCase house name are cut from the name', () => {
    assert.equal(cleanAuthorName('Read more articles by Loren Noveck'), 'Loren Noveck');
    assert.equal(cleanAuthorName('CurtainUp, Dan Rubins'), 'Dan Rubins');
    assert.equal(cleanAuthorName('McDonald, John Paul'), 'McDonald, John Paul');
  });
});

// BRO-7780: a tier 1-2 outlet's own name in JSON-LD / meta author is the publisher, not the
// critic. The sweep found the reader returning "USA TODAY" for a USA Today review.
describe('publication names are never a critic (BRO-7780)', () => {
  const { readPageByline } = require('../../scripts/lib/page-byline.js');
  const { isNotACriticName, isPublicationName } = require('../../scripts/lib/byline-extraction.js');
  const ld = (author) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', author })}</script></head><body><p>x</p></body></html>`;
  const REG = { outlets: {
    usatoday: { displayName: 'USA Today', tier: 2 }, nypost: { displayName: 'New York Post', tier: 2 },
    liamodell: { displayName: "Liam O'Dell", tier: 4 }, ipaper: { displayName: 'i', tier: 2 },
  } };

  test('JSON-LD Person named "USA TODAY" reads as nobody', () => {
    assert.equal(readPageByline({ html: ld({ '@type': 'Person', name: 'USA TODAY' }), outletId: 'usatoday' }).criticName, null);
  });
  test('meta author "New York Post" reads as nobody', () => {
    assert.equal(readPageByline({ html: '<html><head><meta name="author" content="New York Post"></head><body></body></html>', outletId: 'nypost' }).criticName, null);
  });
  test('publisher listed first, critic second: the critic wins', () => {
    assert.equal(readPageByline({ html: ld([{ '@type': 'Person', name: 'USA TODAY' }, { '@type': 'Person', name: 'Patrick Ryan' }]), outletId: 'usatoday' }).criticName, 'Patrick Ryan');
  });
  test('a personal blog named after its critic still credits the critic', () => {
    assert.equal(readPageByline({ html: ld({ '@type': 'Person', name: "Liam O'Dell" }), outletId: 'liamodell' }).criticName, "Liam O'Dell");
  });
  test('only tier 1-2 display names count; short names are ignored', () => {
    assert.equal(isPublicationName('USA TODAY', REG), true);
    assert.equal(isPublicationName('The New York Post', REG), true);
    assert.equal(isPublicationName("Liam O'Dell", REG), false);
    assert.equal(isPublicationName('I', REG), false);
    assert.equal(isNotACriticName('USA TODAY'), true);
    assert.equal(isNotACriticName('Patrick Ryan'), false);
  });
});

// BRO-7780 ship-check: the shared reader called the generic reader with no text, so an outlet whose
// only byline is in the article text (CultureSauce "Date: ... Author: X") came back with nobody.
test('text-only bylines still read through the shared reader (CultureSauce)', () => {
  const { readPageByline } = require('../../scripts/lib/page-byline.js');
  const html = '<html><head><title>Review</title></head><body><article><p>Date: March 3, 2026 Author: Slam Frank</p><p>The show.</p></article></body></html>';
  const got = readPageByline({ html, text: 'Date: March 3, 2026 Author: Slam Frank\nThe show was a riot.', url: 'https://culturesauce.com/2026/03/03/review-x/', outletId: 'culturesauce' });
  assert.equal(got.criticName, 'Slam Frank');
});

// BRO-7780 sweep (All That Dazzles / Theatre and Tonic): two printed-credit shapes the readers missed.
describe('printed credits found by the BRO-7780 sweep', () => {
  const { printedOutletByline } = require('../../scripts/lib/byline-from-text.js');
  test('All That Dazzles pre-star posts: "N min read [Updated: ...] Review by First Last <sentence>"', () => {
    const t = "Review: The Pillowman (Duke Of York's Theatre) All That Dazzles Jun 21, 2023 5 min read Updated: Jun 22, 2023 Review by Daz Gale If you walk the streets of LDN";
    assert.equal(printedOutletByline('all-that-dazzles-uk', t)?.name, 'Daz Gale');
    const t2 = 'Review: Operation Mincemeat (Fortune Theatre) All That Dazzles May 10, 2023 5 min read Review by Daz Gale Every now and then';
    assert.equal(printedOutletByline('all-that-dazzles-uk', t2)?.name, 'Daz Gale');
  });
  test('All That Dazzles: star posts still read; prose "reviewed by" away from the header does not', () => {
    assert.equal(printedOutletByline('all-that-dazzles-uk', 'Sam Woodward Oct 27 5 min read Review by Ruth Sealey ⭐️⭐️⭐️⭐️⭐️ Virtual')?.name, 'Ruth Sealey');
    assert.equal(printedOutletByline('all-that-dazzles-uk', 'A show first reviewed by Daz Gale In the body later on'), null);
  });
  test('Theatre and Tonic: "Reviewed by Annie for Theatre and Tonic" as well as "Written by"', () => {
    assert.equal(printedOutletByline('theatreandtonic', 'a lovely show. Reviewed by Annie for Theatre and Tonic Disclaimer: Gifted')?.name, 'Annie');
    assert.equal(printedOutletByline('theatreandtonic', 'Written by Ann Lee ... Written by Bo for Theatre and Tonic, October 2026')?.name, 'Bo');
  });
});
