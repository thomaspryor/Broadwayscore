// BRO-2726 — theatre.reviews links only PART of an outlet's name on some rows
// ("T<a>he Standard</a>‘s", "<a>Time Ou</a>t’s") and writes possessives with
// an opening curly quote. The scraper took the link text as the outlet
// (outletIds "he-standard", "time-ou") and opened an excerpt at the possessive
// ("s Nick Curtis called the play ..."). Markup below mirrors the live
// 2026 round-ups' structure with placeholder prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractReviews } = require('./scrape-theatre-reviews.js');

function page(...paragraphs) {
  return `<html><body><div class="entry-content"><p>4 stars ⭑⭑⭑⭑</p>${paragraphs.join('')}</div></body></html>`;
}

test('link that starts mid-name: outlet comes from the prose, not the fragment', () => {
  const [r] = extractReviews(page(
    '<p>T<a href="https://www.standard.co.uk/culture/theatre/x.html">he Standard</a>&#8216;s Nick Curtis called the play &#8216;a crisp, quick comedy in the director&#8217;s polished revival, and a good night out.&#8217;</p>',
  ), 'show');
  assert.equal(r.outlet, 'The Standard');
  assert.equal(r.outletId, 'standard');
  assert.equal(r.critic, 'Nick Curtis');
  assert.equal(r.url, 'https://www.standard.co.uk/culture/theatre/x.html');
});

test('link that ends mid-name: outlet comes from the prose, not the fragment', () => {
  const [r] = extractReviews(page(
    '<p><a href="https://www.timeout.com/london/x">Time Ou</a>t&#8217;s Andrzej Lukowski wrote: &#8216;The lead is fine, the production around him is better than fine.&#8217;</p>',
  ), 'show');
  assert.equal(r.outlet, 'Time Out');
  assert.notEqual(r.outletId, 'time-ou');
  assert.equal(r.critic, 'Andrzej Lukowski');
});

test('whole-name link is unchanged', () => {
  const [r] = extractReviews(page(
    '<p><a href="https://www.theguardian.com/stage/x">The Guardian</a>&#8217;s Arifa Akbar noted: &#8216;the first thing that hits you here is the sound of the band.&#8217;</p>',
  ), 'show');
  assert.equal(r.outlet, 'The Guardian');
  assert.equal(r.critic, 'Arifa Akbar');
});

test('excerpt starts at the real quote, not the left-quote possessive', () => {
  const [r] = extractReviews(page(
    '<p>T<a href="https://www.standard.co.uk/x">he Standard</a>&#8216;s Nick Curtis called the play &#8216;a crisp, quick comedy in the director&#8217;s polished revival, and a good night out.&#8217;</p>',
  ), 'show');
  assert.equal(r.excerpt, 'a crisp, quick comedy in the director’s polished revival, and a good night out.');
});

test('apostrophes inside a quote do not end the excerpt; several quotes are joined', () => {
  const [r] = extractReviews(page(
    '<p><a href="https://www.timeout.com/london/x">Time Out</a>&#8217;s Andrzej Lukowski began: &#8216;The star is not the Messiah.&#8217; He said he &#8216;looks like a man who can&#8217;t remember where he parked the car.&#8217; It wasn&#8217;t all bad: &#8216;elsewhere it&#8217;s a pretty good production with a stark set&#8217;.</p>',
  ), 'show');
  assert.equal(
    r.excerpt,
    'The star is not the Messiah. … looks like a man who can’t remember where he parked the car. … elsewhere it’s a pretty good production with a stark set',
  );
});

test('a link inside the name (not a prefix/suffix fragment) keeps the link text', () => {
  const [r] = extractReviews(page(
    '<p>The <a href="https://inews.co.uk/x">i</a>&#8217;s Fiona Mountford wrote: &#8216;a long evening of fine acting and little else.&#8217;</p>',
  ), 'show');
  assert.equal(r.outlet, 'i');
});
