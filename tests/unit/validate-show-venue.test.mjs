// Tests for scripts/validate-show-venue.js's pure decision functions (card
// #590, Bronco Billy: The Musical). Guards against stub entries where the
// venue/year are wrong by exercising the actual comparison logic against a
// real fixture (the Charing Cross Theatre / Bronco Billy production added
// by this card) rather than re-implementing the checks in the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isProvisional, shortTitleSlug, scorePlaybillUrl,
  parseTitleVenueYear, parseFactDates, urlYear, daysBetween, compareShow,
} = require('../../scripts/validate-show-venue.js');

const broncoBilly = {
  id: 'bronco-billy-the-musical-west-end-2024',
  title: 'Bronco Billy – The Musical',
  venue: 'Charing Cross Theatre',
  category: 'off-west-end',
  openingDate: '2024-01-31',
  closingDate: '2024-04-07',
};
const broncoBillyPlaybillUrl = 'https://playbill.com/production/bronco-billy-the-musical-london-charing-cross-theatre-2024';

test('shortTitleSlug normalizes punctuation and dashes like Playbill URL slugs', () => {
  assert.equal(shortTitleSlug('Bronco Billy – The Musical'), 'bronco-billy-the-musical');
  assert.equal(shortTitleSlug("Schmigadoon!"), 'schmigadoon');
});

test('scorePlaybillUrl accepts the real Bronco Billy Playbill URL for the show', () => {
  const score = scorePlaybillUrl(broncoBillyPlaybillUrl, broncoBilly);
  assert.ok(score !== null, 'expected a non-null score for a matching URL');
  assert.ok(score > 0);
});

test('scorePlaybillUrl hard-rejects a same-titled London URL for a Broadway show (cross-market guard)', () => {
  // Regression for a P0 the adversarial review caught: adding "london" as a
  // recognized market segment must not let a same-titled London production
  // pass as a match for a Broadway/Off-Broadway show via the soft -5 penalty
  // (+10 title match - 5 = net positive, which findPlaybillUrl's `score > 0`
  // filter would have accepted).
  const broadwayShow = { id: 'bronco-billy-broadway-2030', title: 'Bronco Billy – The Musical', venue: 'Some Broadway House', category: 'broadway' };
  const score = scorePlaybillUrl(broncoBillyPlaybillUrl, broadwayShow);
  assert.equal(score, null);
});

test('scorePlaybillUrl hard-rejects a same-titled Broadway/Off-Broadway URL for a West End show (cross-market guard, reverse direction)', () => {
  const westEndShow = { ...broncoBilly };
  const score = scorePlaybillUrl(
    'https://playbill.com/production/bronco-billy-the-musical-broadway-some-theatre-2030',
    westEndShow
  );
  assert.equal(score, null);
});

test('scorePlaybillUrl rejects a URL for a different title', () => {
  const score = scorePlaybillUrl(
    'https://playbill.com/production/some-other-show-west-end-charing-cross-theatre-2024',
    broncoBilly
  );
  assert.equal(score, null);
});

test('parseTitleVenueYear extracts market/venue/year from a Playbill <title> tag', () => {
  const html = '<title>Bronco Billy - The Musical (West End, Charing Cross Theatre, 2024) | Playbill</title>';
  const parsed = parseTitleVenueYear(html);
  assert.equal(parsed.market, 'West End');
  assert.equal(parsed.venue, 'Charing Cross Theatre');
  assert.equal(parsed.year, 2024);
});

test('parseFactDates extracts opening/closing dates from Playbill fact blocks', () => {
  const html = `
    <div class="bsp-list-promo-title">First Preview</div>
    <span class="info-circular-pre-text">Jan</span><span class="info-circular-text">24</span><span class="info-circular-post-text">2024</span>
    <div class="bsp-list-promo-title">Opening Date</div>
    <span class="info-circular-pre-text">Jan</span><span class="info-circular-text">31</span><span class="info-circular-post-text">2024</span>
    <div class="bsp-list-promo-title">Closing Date</div>
    <span class="info-circular-pre-text">Apr</span><span class="info-circular-text">7</span><span class="info-circular-post-text">2024</span>
  `;
  const dates = parseFactDates(html);
  assert.deepEqual(dates, {
    firstPreview: '2024-01-24',
    openingDate: '2024-01-31',
    closingDate: '2024-04-07',
  });
});

test('urlYear reads the trailing year off a Playbill production URL', () => {
  assert.equal(urlYear(broncoBillyPlaybillUrl), 2024);
});

test('daysBetween is null when either date is missing or unparseable', () => {
  assert.equal(daysBetween(null, '2024-01-31'), null);
  assert.equal(daysBetween('2024-01-31', 'not-a-date'), null);
  assert.equal(daysBetween('2024-01-31', '2024-02-02'), 2);
});

test('compareShow reports no mismatches when shows.json matches Playbill (Bronco Billy fixture)', () => {
  const parsed = {
    titleParse: { rawTitle: 'Bronco Billy - The Musical', market: 'West End', venue: 'Charing Cross Theatre', year: 2024 },
    dates: { firstPreview: '2024-01-24', openingDate: '2024-01-31', closingDate: '2024-04-07' },
  };
  const mismatches = compareShow(broncoBilly, parsed, broncoBillyPlaybillUrl);
  assert.deepEqual(mismatches, []);
});

test('compareShow flags a venue mismatch (wrong-venue stub guard)', () => {
  const parsed = {
    titleParse: { rawTitle: 'Bronco Billy - The Musical', market: 'West End', venue: 'Prince Edward Theatre', year: 2024 },
    dates: { firstPreview: '2024-01-24', openingDate: '2024-01-31', closingDate: '2024-04-07' },
  };
  const mismatches = compareShow(broncoBilly, parsed, broncoBillyPlaybillUrl);
  assert.ok(mismatches.some(m => m.field === 'venue'));
});

test('compareShow flags an opening-date delta beyond the 30-day threshold', () => {
  const parsed = {
    titleParse: { rawTitle: 'Bronco Billy - The Musical', market: 'West End', venue: 'Charing Cross Theatre', year: 2024 },
    dates: { firstPreview: null, openingDate: '2024-04-01', closingDate: '2024-04-07' },
  };
  const mismatches = compareShow(broncoBilly, parsed, broncoBillyPlaybillUrl);
  assert.ok(mismatches.some(m => m.field === 'openingDate'));
});

test('isProvisional flags manual-user-request entries like Bronco Billy for validation', () => {
  assert.equal(isProvisional({ discoverySource: 'manual-user-request', provisional: true }), true);
  assert.equal(isProvisional({ discoverySource: 'todaytix-sync', provisional: false }), false);
});
