/**
 * BRO-5222 gap 3: Time Out listing capsules vs real reviews. Fixtures copy the
 * page structure only (synthetic prose, no review text).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyTimeoutPage, parseTimeoutPage, isTimeoutUrl, keepsStoredTimeoutReview } = require('../../scripts/lib/timeout-capsule.js');
const { classifyReviewUrl, namedNonReviewReason, listingPageUrlReason } = require('../../scripts/lib/non-review-url-patterns.js');

const shell = (inner) => `<html><head><title>Show</title><script>var x="Time Out says";</script></head><body><nav>Things to do</nav>${inner}<div>Details</div><p>Event website: example.com</p></body></html>`;
const prose = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

const REVIEW = shell(`<p>Written by Adam Feldman</p><h2>Time Out says</h2><p>Broadway review by Adam Feldman</p><p>${prose(900)}</p>`);
const OLD_REVIEW = shell(`<h2>Time Out says</h2><p>Machinal. Some Theatre. By A Writer. Running time: 1hr 30mins.</p><p>Machinal: Theater review by David Cote</p><p>${prose(700)}</p>`);
const CAPSULE = (signer) => shell(`<h2>Time Out says</h2><p>${prose(60)} &mdash;${signer}</p>`);

test('real review with matching byline is accepted', () => {
  assert.equal(classifyTimeoutPage({ html: REVIEW, critic: 'Adam Feldman', showYear: 2023 }).verdict, 'review');
  assert.equal(classifyTimeoutPage({ html: OLD_REVIEW, critic: 'David Cote', showYear: 2014 }).verdict, 'review');
});

test('review byline for another critic is wrong_critic (all-my-sons-2019 class)', () => {
  const v = classifyTimeoutPage({ html: REVIEW, critic: 'Helen Shaw', showYear: 2019 });
  assert.equal(v.verdict, 'wrong_critic');
  assert.match(v.reason, /Adam Feldman/);
  assert.equal(classifyTimeoutPage({ html: OLD_REVIEW, critic: 'Adam Feldman', showYear: 2015 }).verdict, 'wrong_critic');
});

test('capsule signed by another critic is wrong_critic (once-2012)', () => {
  const v = classifyTimeoutPage({ html: CAPSULE('David Cote'), critic: 'Adam Feldman', showYear: 2012 });
  assert.equal(v.verdict, 'wrong_critic');
  assert.equal(parseTimeoutPage(CAPSULE('David Cote')).capsuleSigner, 'David Cote');
});

test('post-2014 capsule by the right critic is a listing capsule (the-minutes-2022)', () => {
  assert.equal(classifyTimeoutPage({ html: CAPSULE('Adam Feldman'), critic: 'Adam Feldman', showYear: 2022 }).verdict, 'listing_capsule');
});

test('pre-2014 TONY capsule by the right critic is the published review (la-bete-2010)', () => {
  assert.equal(classifyTimeoutPage({ html: CAPSULE('David Cote'), critic: 'David Cote', showYear: 2010 }).verdict, 'review');
});

test('Unknown critic and pages without the Time Out says block are left alone', () => {
  assert.equal(classifyTimeoutPage({ html: REVIEW, critic: 'Unknown', showYear: 2025 }).verdict, 'review');
  const news = shell('<h1>Broadway review: a headline</h1><p>Written by Adam Feldman</p><p>' + prose(800) + '</p>');
  assert.equal(classifyTimeoutPage({ html: news, critic: 'David Cote', showYear: 2016 }).verdict, 'unknown');
});

test('Time Out review and capsule URLs share a shape, so URL rules must not drop them', () => {
  for (const u of [
    'https://www.timeout.com/newyork/theater/dolls-house-broadway-review-jessica-chastain-ibsen',
    'https://www.timeout.com/newyork/theater/the-minutes',
  ]) {
    assert.equal(isTimeoutUrl(u), true);
    assert.equal(namedNonReviewReason(u), null);
    assert.equal(listingPageUrlReason(u), null);
    assert.equal(classifyReviewUrl(u).ok, true);
  }
  assert.equal(isTimeoutUrl('https://www.nottimeout.com/x'), false);
});

test('unsigned post-2014 listing blurb is a listing capsule (dancin-2023 class)', () => {
  const blurb = shell(`<h2>Time Out says</h2><p>${prose(75)}</p><h3>Details</h3><p>Address</p>`);
  assert.equal(classifyTimeoutPage({ html: blurb, critic: 'Adam Feldman', showYear: 2023 }).verdict, 'listing_capsule');
  assert.equal(classifyTimeoutPage({ html: blurb, critic: 'David Cote', showYear: 2009 }).verdict, 'unknown');
});

test('signature followed by a Follow link and entity-quoted bodies still parse (once-2012, amelie-2017)', () => {
  const signed = shell(`<h2>Time Out says</h2><p>${prose(60)} &mdash;David Cote</p><p>Follow David Cote on Twitter.</p>`);
  assert.equal(parseTimeoutPage(signed).capsuleSigner, 'David Cote');
  const quoted = shell(`<h2>Time Out says</h2><p>Broadway review by David Cote</p><p>&ldquo;Words&rdquo; ${prose(600)}</p>`);
  const v = classifyTimeoutPage({ html: quoted, critic: 'Adam Feldman', showYear: 2017 });
  assert.equal(v.verdict, 'wrong_critic');
  assert.match(v.reason, /by David Cote,/);
});

test('a long signed review keeps its verdict: right signer is review, other signer is wrong_critic', () => {
  const long = (s) => shell(`<h2>Time Out says</h2><p>${prose(290)} &mdash;${s}</p><p>Follow ${s} on Twitter.</p><h3>Details</h3>`);
  assert.equal(classifyTimeoutPage({ html: long('David Cote'), critic: 'David Cote', showYear: 2012 }).verdict, 'review');
  assert.equal(classifyTimeoutPage({ html: long('David Cote'), critic: 'Adam Feldman', showYear: 2012 }).verdict, 'wrong_critic');
});

test('a stored full review survives a refetch that finds the listing blurb (the-present-2017)', () => {
  assert.equal(keepsStoredTimeoutReview({ tier: 'complete', textLength: 3140 }), true);
  assert.equal(keepsStoredTimeoutReview({ tier: 'truncated', textLength: 1600 }), true);
  assert.equal(keepsStoredTimeoutReview({ tier: 'stub', textLength: 0 }), false);
  assert.equal(keepsStoredTimeoutReview({ tier: 'complete', textLength: 400 }), false);
  assert.equal(keepsStoredTimeoutReview({}), false);
});

// BRO-5261 retro-review of BRO-5222.
test('a signature with an encoded apostrophe parses (O&#039;Brien)', () => {
  const html = `<p>Time Out says</p><p>${'word '.repeat(30)}&mdash;Ben O&#039;Brien</p> Details`;
  assert.equal(parseTimeoutPage(html).capsuleSigner, "Ben O'Brien");
});

test('stored text flagged as not this url\'s review is never kept over a capsule', () => {
  assert.equal(keepsStoredTimeoutReview({ tier: 'complete', textLength: 3000 }), true);
  assert.equal(keepsStoredTimeoutReview({ tier: 'complete', textLength: 3000, suspect: true }), false);
});
