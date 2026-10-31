import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { classifyClaim, quoteOnPage, isTrustedHost } = require('../../scripts/lib/deep-research-claim-check');

// Long enough to read as an article rather than a paywall stub.
const pad = (s) => `<html><head><title>Broadway news</title></head><body><p>${'Theater news filler sentence. '.repeat(60)}</p><p>${s}</p><p>${'More unrelated filler text. '.repeat(30)}</p></body></html>`;
const seaWall = { title: 'Sea Wall / A Life', openingDate: '2019-08-08' };
const celeb = { title: 'Celebrity Autobiography', openingDate: '2025-10-01' };
const beaches = { title: 'Beaches, A New Musical', openingDate: '2026-04-01' };
const cap = (show, value) => ({ show: show.title, field: 'capitalization', value, source_url: 'https://broadwaynews.com/x', quote: '' });

test('a figure stated next to the show title is confirmed', () => {
  const page = pad('Sea Wall/A Life, which opened in 2019, was capitalized for up to $2.8 million, according to SEC filings.');
  assert.equal(classifyClaim(cap(seaWall, 2800000), page, seaWall).verdict, 'confirmed');
});

test("another show's figure is not confirmed for this show (the Celebrity Autobiography case)", () => {
  // The Sea Wall article's $2.3M came back as Celebrity Autobiography's budget.
  const page = pad('Sea Wall/A Life, which opened in 2019, cost producers $2.3 million to mount.');
  const r = classifyClaim(cap(celeb, 2300000), page, celeb);
  assert.notEqual(r.verdict, 'confirmed');
  assert.equal(r.verdict, 'wrong-context');
});

test('a subtitle-free title still matches (Beaches, A New Musical as "Beaches")', () => {
  const page = pad('Beaches, which opens in 2026, is capitalized at $14 million.');
  assert.equal(classifyClaim(cap(beaches, 14000000), page, beaches).verdict, 'confirmed');
});

test("Just in Time's $12.5M is not confirmed as Beaches'", () => {
  const page = pad(`Just in Time, which opened in 2026, was capitalized at $12.5 million and recouped. ${'Other paragraph. '.repeat(40)} Beaches opens in 2026.`);
  assert.notEqual(classifyClaim(cap(beaches, 12500000), page, beaches).verdict, 'confirmed');
  const outcome = { show: 'Beaches', field: 'outcome for investors', value: 'recouped', source_url: 'https://x.com/a', quote: '' };
  assert.notEqual(classifyClaim(outcome, page, beaches).verdict, 'confirmed');
});

test('outcome claims need matching recoupment language next to the title', () => {
  const lost = pad('Beaches, which opened in 2026, closed without recouping its investment.');
  const claim = (value) => ({ show: 'Beaches', field: 'outcome for investors', value, source_url: 'https://x.com/a', quote: '' });
  assert.equal(classifyClaim(claim('did not recoup'), lost, beaches).verdict, 'confirmed');
  assert.notEqual(classifyClaim(claim('recouped'), lost, beaches).verdict, 'confirmed');
});

test('paywall stubs, failed fetches and missing sources are never confirmed', () => {
  assert.equal(classifyClaim(cap(seaWall, 2800000), 'Subscribe to read', seaWall).verdict, 'unreadable');
  assert.equal(classifyClaim(cap(seaWall, 2800000), null, seaWall).verdict, 'unreadable');
  assert.equal(classifyClaim({ ...cap(seaWall, 2800000), source_url: null }, pad('x'), seaWall).verdict, 'no-source');
  assert.equal(classifyClaim(cap(seaWall, 2800000), pad('x'), null).verdict, 'unmatched-show');
});

test('a figure absent from the page is not-on-page', () => {
  assert.equal(classifyClaim(cap(seaWall, 9000000), pad('Sea Wall/A Life opened in 2019.'), seaWall).verdict, 'not-on-page');
});

test('quoteOnPage accepts a re-punctuated quote and rejects an invented one', () => {
  const text = 'The production, which cost $2.8 million, announced recoupment at the end of its nine-week run.';
  assert.equal(quoteOnPage('which cost $2.8 million announced recoupment at the end of its nine week run', text), true);
  assert.equal(quoteOnPage('The production lost its entire investment after a short run on Broadway', text), false);
});

test('an earlier production\'s recoupment is wrong-production, and "lost the Tony" is not a loss', () => {
  const revival = { title: 'Example', openingDate: '2025-04-01' };
  const old = { show: 'Example', field: 'outcome for investors', value: 'recouped 2013-02', source_url: 'https://broadwaynews.com/a', quote: '' };
  assert.equal(classifyClaim(old, pad('Example, the 2012 production, recouped its investment in 2013.'), revival).verdict, 'wrong-production');
  const loss = { show: 'Example', field: 'outcome for investors', value: 'did not recoup', source_url: 'https://broadwaynews.com/a', quote: '' };
  assert.notEqual(classifyClaim(loss, pad('Example, which opened in 2025, lost the Tony for best musical.'), revival).verdict, 'confirmed');
  assert.equal(classifyClaim(loss, pad('Example, which opened in 2025, lost its entire investment.'), revival).verdict, 'confirmed');
});

test('trusted host mirrors the apply path: SEC and trade hosts yes, blogs no', () => {
  assert.equal(isTrustedHost('https://www.sec.gov/Archives/edgar/data/1/x.xml'), true);
  assert.equal(isTrustedHost('https://variety.com/x'), true);
  assert.equal(isTrustedHost('https://broadwaynews.com/x'), false);
  assert.equal(isTrustedHost('https://someblog.example.com/x'), false);
  assert.equal(isTrustedHost('http://broadwaynews.com/x'), false);
});

test('loose field names and hedged values are normalized before checking', () => {
  const { normalizeClaim, parseMoney } = require('../../scripts/lib/deep-research-claim-check');
  assert.equal(parseMoney('up to 18000000'), 18000000);
  assert.equal(parseMoney('nearly $4.75 million'), 4750000);
  assert.equal(parseMoney('12000000-15000000'), null);
  assert.equal(parseMoney('>500000'), null);
  assert.equal(parseMoney('just under 600000'), null);
  const c = normalizeClaim({ show: 'X', field: 'weekly_running_cost', value: 'about 625000', source_url: ['https://a.com/x', 'https://b.com/y'] });
  assert.deepEqual([c.field, c.value, c.source_url], ['weekly running cost', 625000, 'https://a.com/x']);
  assert.equal(normalizeClaim({ field: 'outcome', value: 'did not recoup' }).field, 'outcome for investors');
  assert.equal(normalizeClaim({ field: 'sec_offering_amount', value: 7000000 }).field, 'capitalization');
  const page = pad('Sea Wall/A Life, which opened in 2019, was capitalized at $2.8 million.');
  assert.equal(classifyClaim({ ...cap(seaWall, 'up to 2800000') }, page, seaWall).verdict, 'confirmed');
  assert.equal(classifyClaim({ ...cap(seaWall, '2000000-3000000') }, page, seaWall).verdict, 'not-checkable');
});

test('a Form D figure is held for an issuer match, never confirmed on its own', () => {
  const blueberries = { title: 'Here There Are Blueberries', openingDate: '2026-04-01' };
  const form = `<html><body>Name of Issuer Blueberries Broadway Ltd Liability Co Jurisdiction of Incorporation NEW YORK Year 2026. The maximum capitalization is $7,000,000. The minimum capitalization is $5,000,000.</body></html>`;
  const claim = { show: blueberries.title, field: 'sec_offering_amount', value: 7000000, source_url: 'https://www.sec.gov/Archives/edgar/data/1/x.xml', quote: '' };
  const r = classifyClaim(claim, form, blueberries);
  assert.equal(r.verdict, 'sec-issuer');
  assert.equal(r.issuer, 'Blueberries Broadway Ltd Liability Co');
});

test('outcome titles match whole words with the same folding as the title forms', () => {
  const rent = { title: 'Rent', openingDate: '1996-04-29' };
  const outcome = (show, value) => ({ show: show.title, field: 'outcome for investors', value, source_url: 'https://variety.com/a', quote: '' });
  // "Rent" inside "current" is not the show.
  assert.notEqual(classifyClaim(outcome(rent, 'recouped'), pad('The current production has recouped its investment.'), rent).verdict, 'confirmed');
  const tommy = { title: "The Who's Tommy", openingDate: '2024-03-28' };
  assert.equal(classifyClaim(outcome(tommy, 'did not recoup'), pad('The Who’s Tommy, which opened in 2024, closed without recouping.'), tommy).verdict, 'confirmed');
  const juliet = { title: '& Juliet', openingDate: '2022-11-17' };
  assert.equal(classifyClaim(outcome(juliet, 'did not recoup'), pad('& Juliet, which opened in 2022, closed without recouping its investment.'), juliet).verdict, 'confirmed');
});

test('a running show that has not yet recouped is not a loss, and "Recouped (noted ...)" is not a loss claim', () => {
  const { claimsLoss } = require('../../scripts/lib/deep-research-claim-check');
  const show = { title: 'Example', openingDate: '2025-04-01' };
  const loss = { show: 'Example', field: 'outcome for investors', value: 'did not recoup', source_url: 'https://variety.com/a', quote: '' };
  assert.notEqual(classifyClaim(loss, pad('Example, which opened in 2025, has not yet recouped.'), show).verdict, 'confirmed');
  assert.equal(claimsLoss('Recouped (noted by Variety)'), false);
  assert.equal(claimsLoss('did not recoup'), true);
  assert.equal(claimsLoss("didn't recoup"), true);
});

test("another show's loss two sentences on is not this show's (the Variety CATS / Sunset Blvd. case)", () => {
  const cats = { title: 'CATS: The Jellicle Ball', openingDate: '2026-04-07' };
  const loss = { show: cats.title, field: 'outcome for investors', value: 'did not recoup', source_url: 'https://variety.com/a', quote: '' };
  const page = pad('Sales fell after “The Jellicle Ball” lost the best revival Tony to “Ragtime.” Lloyd Webber’s “Sunset Blvd.” was remounted in 2024 and won a Tony. However, the show failed to recoup its investment.');
  assert.notEqual(classifyClaim(loss, page, cats).verdict, 'confirmed');
  // The sentence right after the title still counts.
  assert.equal(classifyClaim(loss, pad('CATS: The Jellicle Ball, which opened in 2026, will close on Aug. 8. The show did not recoup its investment.'), cats).verdict, 'confirmed');
});

test('the live record is found by slug, as commercial.json is keyed', () => {
  const { recordFor, recordStatus } = require('../../scripts/verify-deep-research-claims.js');
  const commercial = { 'stranger-things': { capitalization: 29000000 }, 'old-id-2001': { capitalization: 1 } };
  assert.equal(recordFor(commercial, { id: 'stranger-things-2024', slug: 'stranger-things' }).capitalization, 29000000);
  assert.equal(recordFor(commercial, { id: 'old-id-2001', slug: 'old-id' }).capitalization, 1);
  assert.equal(recordFor(commercial, { id: 'x-2020', slug: 'x' }), null);
  assert.equal(recordStatus({ field: 'capitalization', value: 29000000 }, recordFor(commercial, { id: 'stranger-things-2024', slug: 'stranger-things' })), 'same');
});

test('a next sentence about another show, a separate list item or a far-off phrase does not confirm a loss', () => {
  const cats = { title: 'CATS: The Jellicle Ball', openingDate: '2026-04-07' };
  const loss = { show: cats.title, field: 'outcome for investors', value: 'did not recoup', source_url: 'https://variety.com/a', quote: '' };
  // The next sentence names another show instead of referring back.
  assert.notEqual(classifyClaim(loss, pad('CATS: The Jellicle Ball, which opened in 2026, closes Aug. 8. Sunset Blvd. never recouped its investment.'), cats).verdict, 'confirmed');
  // List items without full stops are separate sentences.
  assert.notEqual(classifyClaim(loss, pad('</p><ul><li>CATS: The Jellicle Ball opened in 2026</li><li>Hell’s Kitchen did not recoup</li></ul><p>'), cats).verdict, 'confirmed');
  // One long unpunctuated block: the loss phrase is far from the title.
  assert.notEqual(classifyClaim(loss, pad(`CATS: The Jellicle Ball opened in 2026 ${'and the season went on '.repeat(20)} another show did not recoup`), cats).verdict, 'confirmed');
  // "It" refers back.
  assert.equal(classifyClaim(loss, pad('CATS: The Jellicle Ball, which opened in 2026, closes Aug. 8. It did not recoup its investment.'), cats).verdict, 'confirmed');
});

test('another show in the same sentence, or a hedged recoupment, is not confirmed', () => {
  const cats = { title: 'CATS: The Jellicle Ball', openingDate: '2026-04-07' };
  const claim = (value) => ({ show: cats.title, field: 'outcome for investors', value, source_url: 'https://variety.com/a', quote: '' });
  assert.notEqual(classifyClaim(claim('did not recoup'), pad('CATS: The Jellicle Ball, which opened in 2026, closes Sunday, while Sunset Blvd. failed to recoup.'), cats).verdict, 'confirmed');
  assert.notEqual(classifyClaim(claim('did not recoup'), pad('CATS: The Jellicle Ball opened in 2026; Sunset Blvd. failed to recoup.'), cats).verdict, 'confirmed');
  for (const text of [
    'CATS: The Jellicle Ball, which opened in 2026, has not yet recouped.',
    'CATS: The Jellicle Ball, which opened in 2026, is expected to recoup by spring.',
    'CATS: The Jellicle Ball, which opened in 2026, sold well, unlike Hamilton, which recouped in 2016.',
  ]) assert.notEqual(classifyClaim(claim('recouped'), pad(text), cats).verdict, 'confirmed', text);
  const ok = classifyClaim(claim('recouped'), pad('CATS: The Jellicle Ball, which opened in 2026, recouped its investment in September.'), cats);
  assert.equal(ok.verdict, 'confirmed');
  assert.match(ok.quote, /recouped its investment/);
});

test('a year in brackets picks that production, and a year no production has matches nothing (the Proof 2000 case)', () => {
  const { showForClaim } = require('../../scripts/verify-deep-research-claims.js');
  const shows = [
    { id: 'proof-2026', slug: 'proof', title: 'Proof', openingDate: '2026-04-16', status: 'closed' },
    { id: 'proof-2000', slug: 'proof-2000', title: 'Proof', openingDate: '2000-10-24', status: 'closed' },
    { id: '1984-2017', slug: '1984', title: '1984', openingDate: '2017-06-22', status: 'closed' },
  ];
  assert.equal(showForClaim('Proof (2000 Broadway production)', shows).slug, 'proof-2000');
  assert.equal(showForClaim('Proof', shows).slug, 'proof');
  assert.equal(showForClaim('Proof (1991 production)', shows), null);
  assert.equal(showForClaim('1984', shows).slug, '1984');
});
