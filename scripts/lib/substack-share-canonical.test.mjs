// BRO-8204: a Substack share link (substack.com/home/post/p-<id>) must be
// swapped for the publication's canonical URL so the outlet resolves to the
// publication, not a generic "substack" outlet the misattribution guard holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { substackShareCanonicalUrl, isSubstackShareUrl } = require('./non-review-url-patterns.js');

const page = (href) => `<html><head><link rel="canonical" href="${href}" /></head><body>x</body></html>`;

test('home/post share link adopts the publication canonical (issue #1198)', () => {
  assert.equal(
    substackShareCanonicalUrl('https://substack.com/home/post/p-218072386', page('https://stephenkearley.substack.com/p/stephen-kearley-reviews-falls-for')),
    'https://stephenkearley.substack.com/p/stephen-kearley-reviews-falls-for');
});

test('@profile share link adopts a custom-domain canonical', () => {
  assert.equal(
    substackShareCanonicalUrl('https://substack.com/@someone/p-123', page('https://www.example-blog.com/p/review')),
    'https://www.example-blog.com/p/review');
});

test('non-share URLs and unusable canonicals are left alone', () => {
  assert.equal(substackShareCanonicalUrl('https://stephenkearley.substack.com/p/x', page('https://other.substack.com/p/y')), null);
  assert.equal(substackShareCanonicalUrl('https://substack.com/home/post/p-1', page('https://substack.com/home/post/p-1')), null);
  assert.equal(substackShareCanonicalUrl('https://substack.com/home/post/p-1', '<html>no canonical</html>'), null);
  assert.equal(substackShareCanonicalUrl('https://substack.com/home/post/p-1', page('javascript:alert(1)')), null);
  assert.equal(isSubstackShareUrl('https://substack.com/browse'), false);
  assert.equal(isSubstackShareUrl('https://www.substack.com/home/post/p-9'), true);
});

test('a canonical that is not a /p/<slug> post cannot re-home the review', () => {
  const share = 'https://substack.com/home/post/p-1';
  assert.equal(substackShareCanonicalUrl(share, page('https://www.nytimes.com/2026/11/20/theater/review.html')), null);
  assert.equal(substackShareCanonicalUrl(share, page('https://someone.substack.com/')), null);
});

test('attribute order, spacing and data- attributes', () => {
  const share = 'https://substack.com/home/post/p-1';
  const want = 'https://x.substack.com/p/review';
  assert.equal(substackShareCanonicalUrl(share, `<link href='${want}' rel='canonical'>`), want);
  assert.equal(substackShareCanonicalUrl(share, `<link rel = "canonical" href = "${want}">`), want);
  assert.equal(substackShareCanonicalUrl(share, `<link data-rel="canonical" href="${want}">`), null);
});

// BRO-8211: a multi-critic Substack's byline is the publication name; the critic
// must come from the submitter or the "NAME reviews TITLE" post title.
const { resolveCritic, isPublicationName, criticFromReviewsTitle } = require('./resolve-critic.js');
const BG = { displayName: 'The BroadGAYS', aliases: ['stephenkearley', 'the-broadgays', 'broadgays'] };

test('publication-name byline never becomes the critic (title pattern)', () => {
  assert.equal(resolveCritic({ byline: 'The BroadGAYS', outletEntry: BG, outletId: 'stephenkearley',
    pageTitle: 'TONY MARINELLI reviews FALLS FOR JODIE at The Tank' }), 'Tony Marinelli');
  assert.equal(resolveCritic({ byline: 'The BroadGAYS', outletEntry: BG, outletId: 'stephenkearley',
    text: 'STEPHEN KEARLEY reviews CRAZY MAMA at 59E59' }), 'Stephen Kearley');
});

test('submitter critic beats the title; --critic beats both', () => {
  const base = { byline: 'The BroadGAYS', outletEntry: BG, outletId: 'stephenkearley', pageTitle: 'TONY MARINELLI reviews X' };
  assert.equal(resolveCritic({ ...base, submitterCritic: 'Stephen Kearley' }), 'Stephen Kearley');
  assert.equal(resolveCritic({ ...base, criticArg: 'Someone Else', submitterCritic: 'Stephen Kearley' }), 'Someone Else');
});

test('publication byline with no critic signal resolves Unknown, real bylines untouched', () => {
  assert.equal(resolveCritic({ byline: 'The BroadGAYS', outletEntry: BG, outletId: 'stephenkearley' }), 'Unknown');
  assert.equal(resolveCritic({ byline: 'Jesse Green', outletEntry: BG, outletId: 'stephenkearley', submitterCritic: 'X Y' }), 'Jesse Green');
  assert.equal(isPublicationName('the-broadgays', BG, 'stephenkearley'), true);
  assert.equal(criticFromReviewsTitle('Variety reviews the show'), null);
  assert.equal(criticFromReviewsTitle('We review the show'), null);
});

test('BRO-8211 review: one-critic outlets keep their real byline; junk titles/submitters rejected', () => {
  const KM = { displayName: 'Stephen Kearley', aliases: ['stephenkearley'] };
  assert.equal(resolveCritic({ byline: 'Stephen Kearley', outletEntry: KM, outletId: 'stephenkearley' }), 'Stephen Kearley');
  assert.equal(resolveCritic({ byline: 'Jonathan Kalb', outletEntry: { displayName: 'Jonathan Kalb', defaultCritic: 'Jonathan Kalb' }, outletId: 'jonathankalb' }), 'Jonathan Kalb');
  assert.equal(criticFromReviewsTitle('Crazy Mama earns glowing reviews from critics'), null);
  assert.equal(criticFromReviewsTitle('Subscribe To The Broadgays reviews x'), null);
  assert.equal(resolveCritic({ byline: 'The BroadGAYS', outletEntry: BG, outletId: 'stephenkearley', submitterCritic: 'The BroadGAYS' }), 'Unknown');
});
