/**
 * BRO-5572: reviews with an Unknown / missing critic name.
 *
 * 1. Impact: live review lists never print "Unknown" as a byline (ReviewsList credits
 *    "<outlet> Staff") and never mint /critics/unknown (criticProfileKey).
 * 2. Parser fixes for the top single-name offenders:
 *    - All That Dazzles: the page prints a bold "Review by X" body paragraph while its JSON-LD
 *      author is the site itself; the page reader now reads the credit (gather/ingest via
 *      readPageByline) and fix-printed-bylines --fetch can rename files stored under the site name.
 *    - The Arts Desk: when the stored text lost the byline, fix-printed-bylines --fetch reads the
 *      page's class="author" credit only (extractArtsdeskPageByline).
 * 3. The live backlog ceiling is in unknown-critic-backlog-live-data.test.mjs (live-data lane).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The writer's credited-creative guard loads shows.json: point it at an empty fixture, never live data.
process.on('exit', require('../../scripts/lib/shows-json-fixture.js').useShowsFixture([]));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

const { criticProfileKey } = require('../../scripts/lib/url-slug.js');
const { extractByline, extractAllThatDazzlesPageByline, extractArtsdeskPageByline } = require('../../scripts/lib/byline-extraction.js');
const { readPageByline } = require('../../scripts/lib/page-byline.js');
const { decideByline, isOutletNamePlaceholder } = require('../../scripts/fix-printed-bylines.js');
const { pageBylineRefusal } = require('../../scripts/lib/review-file-writer.js');

describe('live pages hide Unknown bylines', () => {
  test('ReviewsList credits the outlet staff instead of printing Unknown', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/components/ReviewsList.tsx'), 'utf8');
    assert.match(src, /const hasCritic = !!review\.criticName && review\.criticName !== 'Unknown';/);
    assert.match(src, /\{review\.outlet\} Staff/);
  });
  test('no critic page for an Unknown or missing name', () => {
    assert.equal(criticProfileKey('Unknown'), null);
    assert.equal(criticProfileKey(null), null);
    assert.equal(criticProfileKey('  '), null);
    assert.equal(criticProfileKey('Daz Gale'), 'daz-gale');
  });
});

// Cut-down copy of a real All That Dazzles (Wix) post: site-named JSON-LD author, the credit in a
// bold body paragraph, and a related-post teaser outside the article.
const atdPage = (credit, teaser = '') => `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","author":{"@type":"Person","name":"All That Dazzles","url":"https://www.allthatdazzles.co.uk/profile/admin/profile"}}</script>
</head><body><article class="tgMH9T" data-hook="post"><header>Review: Oliver! (Gielgud Theatre)</header>
<div data-hook="post-description"><div class="i9knh">${credit ? `<div data-breakout="normal"><p class="x9PDq" dir="auto"><span class="yZXDq"><strong style="font-weight:700"><span>${credit}</span></strong></span></p></div>` : ''}
<div data-breakout="normal"><p class="x9PDq" dir="auto"><span>There are few shows I can think of as iconic and timeless as Lionel Bart&#8217;s Oliver!</span></p></div></div></div>
</article><section data-hook="recent-posts">${teaser}</section></body></html>`;

describe('All That Dazzles page byline', () => {
  test('reads the printed credit over the site-named JSON-LD author', () => {
    const html = atdPage('Review by Sam Waite');
    assert.equal(extractAllThatDazzlesPageByline(html), 'Sam Waite');
    assert.equal(extractByline(html, { outletId: 'all-that-dazzles-uk' }), 'Sam Waite');
    assert.equal(readPageByline({ html, outletId: 'all-that-dazzles-uk' }).criticName, 'Sam Waite');
  });
  test('star ratings after the name are not part of it', () => {
    assert.equal(extractAllThatDazzlesPageByline(atdPage('Review by Daz Gale ⭐⭐⭐⭐⭐')), 'Daz Gale');
  });
  test('no printed credit: names nobody (never the site), even with a teaser credit elsewhere', () => {
    const html = atdPage(null, '<p><span>Review by Someone Else</span></p>');
    assert.equal(extractAllThatDazzlesPageByline(html), null);
    assert.notEqual(extractByline(html, { outletId: 'all-that-dazzles-uk' }), 'Someone Else');
  });
  test('scoped to All That Dazzles: other outlets keep their own chain', () => {
    assert.equal(extractAllThatDazzlesPageByline('<p>Review by Sam Waite</p>'), null);
  });
});

describe('fix-printed-bylines: page credit replaces the outlet name stored as a byline', () => {
  const base = { outlet: 'All That Dazzles (UK)', url: 'https://www.allthatdazzles.co.uk/post/review-x', fullText: 'There are few shows I can think of as iconic.' };
  test('site name is a placeholder; a real critic and a self-branded outlet own name are not', () => {
    assert.equal(isOutletNamePlaceholder('all-that-dazzles-uk', { ...base, criticName: 'All That Dazzles' }), true);
    assert.equal(isOutletNamePlaceholder('all-that-dazzles-uk', { ...base, criticName: 'Daz Gale' }), false);
    assert.equal(isOutletNamePlaceholder('carole-di-tosti', { outlet: 'Carole Di Tosti', criticName: 'Carole Di Tosti' }), false);
  });
  test('placeholder + page credit -> page-override; no page -> nothing', () => {
    const data = { ...base, criticName: 'All That Dazzles' };
    assert.deepEqual(decideByline('all-that-dazzles-uk', data, atdPage('Review by Daz Gale')), { kind: 'page-override', name: 'Daz Gale' });
    assert.equal(decideByline('all-that-dazzles-uk', data, null), null);
    assert.equal(decideByline('all-that-dazzles-uk', data, atdPage(null)), null);
  });
  test('Unknown + page credit -> guarded page fill; a stored real name is never replaced from the page', () => {
    assert.deepEqual(decideByline('all-that-dazzles-uk', { ...base, criticName: 'Unknown' }, atdPage('Review by Daz Gale')), { kind: 'page', name: 'Daz Gale' });
    assert.equal(decideByline('all-that-dazzles-uk', { ...base, criticName: 'Sam Waite' }, atdPage('Review by Daz Gale')), null);
  });
  test('flagged files are left alone', () => {
    assert.equal(decideByline('all-that-dazzles-uk', { ...base, criticName: 'All That Dazzles', wrongProduction: true }, atdPage('Review by Daz Gale')), null);
  });
});

test('page-override refuses a non-person page credit', () => {
  const data = { outlet: 'All That Dazzles (UK)', url: 'u', fullText: 'x', criticName: 'All That Dazzles' };
  assert.equal(decideByline('all-that-dazzles-uk', data, atdPage('Review by All That Dazzles')), null);
});

test('ATD: no closing </article> -> names nobody (body end unknown)', () => {
  assert.equal(extractAllThatDazzlesPageByline(atdPage('Review by Daz Gale').replace('</article>', '')), null);
});

test('Arts Desk page reader reads only the class="author" byline, never JSON-LD', () => {
  const ld = '<script type="application/ld+json">{"@type":"Article","author":{"@type":"Person","name":"Some Editor"}}</script>';
  assert.equal(extractArtsdeskPageByline(`${ld}<div class="field author">by&nbsp;<a href="/user/1">Rachel Halliburton</a></div>`), 'Rachel Halliburton');
  assert.equal(extractArtsdeskPageByline(`${ld}<p>No byline here</p>`), null);
});

test('page-override runs the Unknown-fill guards (placeholderNamed), and only with that claim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5572-'));
  const show = path.join(dir, 'some-show');
  fs.mkdirSync(show);
  const f = path.join(show, 'all-that-dazzles-uk--all-that-dazzles.json');
  const rec = { outletId: 'all-that-dazzles-uk', outlet: 'All That Dazzles (UK)', criticName: 'All That Dazzles', url: 'https://www.allthatdazzles.co.uk/post/review-x' };
  fs.writeFileSync(f, JSON.stringify(rec));
  try {
    assert.equal(pageBylineRefusal(f, rec, { showId: 'some-show', criticName: 'Daz Gale' }), 'not-unknown-file');
    assert.equal(pageBylineRefusal(f, rec, { showId: 'some-show', criticName: 'Daz Gale', placeholderNamed: true }), null);
    // A sibling already holding this URL still refuses, as for an --unknown file.
    fs.writeFileSync(path.join(show, 'all-that-dazzles-uk--daz-gale-2.json'), JSON.stringify({ ...rec, criticName: 'Someone' }));
    assert.equal(pageBylineRefusal(f, rec, { showId: 'some-show', criticName: 'Daz Gale', placeholderNamed: true }), 'sibling-same-url');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
