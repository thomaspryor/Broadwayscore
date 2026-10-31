/**
 * BRO-4858: WestEndTheatre round-up critic/URL bleed.
 *
 * BRO-4851 fixed extractSectionReviews: an outlet block with no byline used
 * to take the NEXT outlet's critic and review URL (unbounded nextAll()). The
 * archive keeps parsed rows, not HTML, so stored rows cannot be re-parsed.
 * lib/wet-bleed-audit.js finds the rows the old parser bled by the fingerprint
 * it left (same critic + url as a later row, url owned by that row's outlet),
 * and these tests pin that its re-derived value is exactly what the fixed
 * extractSectionReviews returns for such a block. Per CLAUDE.md rule 15 the
 * real functions are require()d, never copied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractSectionReviews } = require('./scrape-westendtheatre-roundups.js');
const {
  normalizeArchiveRows, findArchiveBleeds, scrubArchiveBleeds, matchBleedFiles,
  defaultOutletIdFor, defaultOwnsUrl, sameHouse,
} = require('./lib/wet-bleed-audit.js');

const GUARDIAN_URL = 'https://www.theguardian.com/stage/2024/oct/07/juno-and-the-paycock-review';
// The FT block has no byline and no link (the BRO-4851 reproduction).
const BLEED_HTML = `
  <div>
    <p class="reviewnewpubhead">Financial Times</p>
    <p class="reviewnewstars">★★★</p>
    <p class="reviewnewquote">"A handsome but chilly revival"</p>
    <p class="reviewnewpubhead">The Guardian</p>
    <p class="reviewnewstars">★★★★</p>
    <p class="reviewnewquote">"Mark Rylance is magnificent"</p>
    <p class="reviewnewauthor">Arifa Akbar</p>
    <a href="${GUARDIAN_URL}">read</a>
  </div>`;

// What the pre-fix parser archived for BLEED_HTML: the FT row carries the
// Guardian's critic and url.
const STORED_RATINGS = [
  { outlet: 'Financial Times', stars: 3, critic: 'Arifa Akbar', excerpt: 'A handsome but chilly revival', reviewUrl: GUARDIAN_URL },
  { outlet: 'The Guardian', stars: 4, critic: 'Arifa Akbar', excerpt: 'Mark Rylance is magnificent', reviewUrl: GUARDIAN_URL },
];

const deps = { outletIdFor: defaultOutletIdFor, ownsUrl: defaultOwnsUrl, sameHouse };

test('extractSectionReviews: a block with no byline gets no critic and no url', () => {
  const rows = extractSectionReviews(BLEED_HTML);
  const ft = rows.find(r => r.outlet === 'Financial Times');
  const g = rows.find(r => r.outlet === 'The Guardian');
  assert.equal(ft.critic, null);
  assert.equal(ft.reviewUrl, null);
  assert.equal(g.critic, 'Arifa Akbar');
  assert.equal(g.reviewUrl, GUARDIAN_URL);
});

test('findArchiveBleeds flags the bled row and re-derives exactly what the fixed parser returns', () => {
  const { bleeds } = findArchiveBleeds(normalizeArchiveRows({ ratings: STORED_RATINGS }), deps);
  assert.equal(bleeds.length, 1);
  const [b] = bleeds;
  assert.equal(b.index, 0);
  assert.equal(b.outletId, 'financialtimes');
  assert.equal(b.donor.outletId, 'guardian');
  const fixed = extractSectionReviews(BLEED_HTML).find(r => r.outlet === 'Financial Times');
  assert.deepEqual(b.reparsed, { critic: fixed.critic, url: fixed.reviewUrl });
});

test('a chain of byline-less blocks: every block before the donor is a bleed, the donor is not', () => {
  const rows = normalizeArchiveRows({ ratings: [
    { outlet: 'The Times', stars: 4, critic: 'Arifa Akbar', reviewUrl: GUARDIAN_URL },
    { outlet: 'Financial Times', stars: 3, critic: 'Arifa Akbar', reviewUrl: GUARDIAN_URL },
    { outlet: 'The Guardian', stars: 4, critic: 'Arifa Akbar', reviewUrl: GUARDIAN_URL },
  ] });
  const { bleeds, leads } = findArchiveBleeds(rows, deps);
  assert.deepEqual(bleeds.map(b => b.index), [0, 1]);
  assert.ok(bleeds.every(b => b.donor.index === 2));
  assert.equal(leads.length, 0, 'the donor is explained by the bleeds, not a lead');
});

test('not a bleed: the shared url belongs to the row\'s own outlet (edition siblings)', () => {
  const url = 'https://www.thetimes.com/article/abc';
  const rows = normalizeArchiveRows({ reviews: [
    { outlet: 'The Times', critic: 'Dominic Maxwell', url },
    { outlet: 'The Sunday Times', critic: 'Dominic Maxwell', url },
  ] });
  const { bleeds, leads } = findArchiveBleeds(rows, deps);
  assert.equal(bleeds.length, 0);
  assert.equal(leads.length, 0, 'Times / Sunday Times share a masthead');
});

test('not a bleed: same critic, different urls is only a lead (a freelancer can file twice)', () => {
  const rows = normalizeArchiveRows({ ratings: [
    { outlet: 'The Times', critic: 'Dominic Cavendish', reviewUrl: 'https://www.thetimes.com/article/x' },
    { outlet: 'The Telegraph', critic: 'Dominic Cavendish', reviewUrl: 'https://www.telegraph.co.uk/theatre/what-to-see/y/' },
  ] });
  const { bleeds, leads } = findArchiveBleeds(rows, deps);
  assert.equal(bleeds.length, 0);
  assert.equal(leads.length, 2);
});

test('a WET round-up url on a row is not a review url and never forms a bleed', () => {
  const wet = 'https://www.westendtheatre.com/354402/news/reviews/1536-ambassadors-reviews/';
  const rows = normalizeArchiveRows({ reviews: [
    { outlet: 'The Telegraph', critic: 'Unknown', url: wet },
    { outlet: 'The Standard', critic: 'Unknown', url: wet },
  ] });
  assert.equal(rows[0].url, null);
  assert.equal(findArchiveBleeds(rows, deps).bleeds.length, 0);
});

test('scrubArchiveBleeds keeps each writer\'s empty shape and does not mutate the cache', () => {
  const ratings = STORED_RATINGS.map(r => ({ ...r }));
  const { rows, scrubbed } = scrubArchiveBleeds(ratings);
  assert.equal(scrubbed.length, 1);
  assert.equal(rows[0].critic, null);
  assert.equal(rows[0].reviewUrl, null);
  assert.equal(rows[0].stars, 3, 'the outlet keeps its own star rating');
  assert.equal(rows[1].critic, 'Arifa Akbar');
  assert.equal(ratings[0].critic, 'Arifa Akbar', 'input untouched');

  const reviews = STORED_RATINGS.map(({ reviewUrl, ...r }) => ({ ...r, url: reviewUrl }));
  const out = scrubArchiveBleeds(reviews).rows;
  assert.equal(out[0].critic, 'Unknown');
  assert.equal(out[0].url, '');
  assert.equal(out[1].url, GUARDIAN_URL);
});

test('scrubArchiveBleeds is a no-op on a clean round-up', () => {
  const clean = [
    { outlet: 'The Guardian', critic: 'Arifa Akbar', url: GUARDIAN_URL },
    { outlet: 'The Stage', critic: 'Tim Bano', url: 'https://www.thestage.co.uk/reviews/x' },
  ];
  const { rows, scrubbed } = scrubArchiveBleeds(clean);
  assert.equal(rows, clean);
  assert.equal(scrubbed.length, 0);
});

test('matchBleedFiles finds the review-text file holding the borrowed critic or url', () => {
  const { bleeds } = findArchiveBleeds(normalizeArchiveRows({ ratings: STORED_RATINGS }), deps);
  const files = [
    { file: 's/financialtimes--arifa-akbar.json', data: { outletId: 'financialtimes', criticName: 'Arifa Akbar', url: GUARDIAN_URL } },
    { file: 's/financialtimes--sarah-hemming.json', data: { outletId: 'financialtimes', criticName: 'Sarah Hemming', url: 'https://www.ft.com/content/z' } },
    { file: 's/guardian--arifa-akbar.json', data: { outletId: 'guardian', criticName: 'Arifa Akbar', url: GUARDIAN_URL } },
  ];
  assert.deepEqual(matchBleedFiles(bleeds[0], files).map(f => f.file), ['s/financialtimes--arifa-akbar.json']);
});
