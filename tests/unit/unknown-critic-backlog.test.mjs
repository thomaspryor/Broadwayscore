/**
 * BRO-5572: reviews with an Unknown / missing critic name.
 *
 * 1. Impact: live review lists never print "Unknown" as a byline (ReviewsList credits
 *    "<outlet> Staff") and never mint /critics/unknown (criticProfileKey).
 * 2. Parser fixes for the top single-name offenders:
 *    - All That Dazzles: the page prints a bold "Review by X" body paragraph while its JSON-LD
 *      author is the site itself; the page reader now reads the credit (gather/ingest via
 *      readPageByline) and fix-printed-bylines --fetch can rename files stored under the site name.
 *    - sierz.co.uk is Aleks Sierz's own site (schema.org publisher Person "Aleks Sierz"):
 *      registry defaultCritic, so rebuild/gather fill his name.
 *    - The Arts Desk: "Aleks Sierz" fills were refused as an outlet name because sierz.co.uk is
 *      named after him.
 * 3. Backlog ceiling: the live reviews.json Unknown count may not grow past what was measured
 *    (2,979 on 2026-11-27, ceiling 3,000). Lower it as fixes land. Skipped when data is absent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

const { criticProfileKey } = require('../../scripts/lib/url-slug.js');
const { extractByline, extractAllThatDazzlesPageByline } = require('../../scripts/lib/byline-extraction.js');
const { readPageByline } = require('../../scripts/lib/page-byline.js');
const { decideByline, isOutletNamePlaceholder } = require('../../scripts/fix-printed-bylines.js');
const { isOutletRegistryName } = require('../../scripts/lib/review-file-writer.js');
const { shouldFillDefaultCritic } = require('../../scripts/lib/critic-fill-rules.js');

const UNKNOWN_CEILING = 3000;

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
  test('site name is a placeholder; a real critic and a self-branded defaultCritic are not', () => {
    assert.equal(isOutletNamePlaceholder('all-that-dazzles-uk', { ...base, criticName: 'All That Dazzles' }), true);
    assert.equal(isOutletNamePlaceholder('all-that-dazzles-uk', { ...base, criticName: 'Daz Gale' }), false);
    assert.equal(isOutletNamePlaceholder('sierz-co-uk', { outlet: 'Aleks Sierz', criticName: 'Aleks Sierz' }), false);
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

describe('Aleks Sierz: single-author site and Arts Desk critic', () => {
  test('sierz.co.uk fills its own critic', () => {
    const reg = require('../../data/outlet-registry.json');
    const e = (reg.outlets || reg)['sierz-co-uk'];
    assert.equal(e.defaultCritic, 'Aleks Sierz');
    assert.equal(shouldFillDefaultCritic(e), true);
  });
  test('his name is not an outlet name (Arts Desk fills were refused), real outlet names still are', () => {
    assert.equal(isOutletRegistryName('Aleks Sierz'), false);
    assert.equal(isOutletRegistryName('All That Dazzles'), true);
    assert.equal(isOutletRegistryName('The Arts Desk'), true);
  });
});

describe('Unknown-critic backlog ceiling', () => {
  const file = path.join(ROOT, 'data/reviews.json');
  test(`live reviews.json carries at most ${UNKNOWN_CEILING} Unknown/missing critic names`, { skip: !fs.existsSync(file) && 'data/reviews.json not present' }, () => {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const reviews = Array.isArray(data) ? data : data.reviews || [];
    assert.ok(reviews.length > 1000, `reviews.json looks truncated (${reviews.length} rows)`);
    const unknown = reviews.filter((r) => !r.criticName || /^(unknown|unnamed)$/i.test(String(r.criticName).trim())).length;
    assert.ok(unknown <= UNKNOWN_CEILING, `${unknown} reviews have no critic name (ceiling ${UNKNOWN_CEILING}); fix the source parser, do not raise the ceiling`);
  });
});

test('page-override refuses a non-person page credit', () => {
  const data = { outlet: 'All That Dazzles (UK)', url: 'u', fullText: 'x', criticName: 'All That Dazzles' };
  assert.equal(decideByline('all-that-dazzles-uk', data, atdPage('Review by All That Dazzles')), null);
});
