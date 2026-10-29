// BRO-6488: London outlet census. require()s the real functions (CLAUDE.md §15).
// Headlines are real Guardian / WhatsOnStage items from the 2026-10-29 runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const census = require('./outlet-census.js');
const { LONDON_SOURCES, sourceFromJson } = require('./outlet-census-sources.js');
const script = require('../outlet-census.js');

const hamlet = { id: 'hamlet-west-end-2025', title: 'Hamlet', market: 'west-end', category: 'west-end', venue: "Duke of York's Theatre", openingDate: '2025-06-01', closingDate: '2025-09-01' };
const calendar = { id: 'calendar-girls-the-musical-west-end-2017', title: 'Calendar Girls the Musical', market: 'west-end', venue: 'Phoenix Theatre', openingDate: '2017-02-28', closingDate: '2017-07-15' };
const girls = { id: 'girls-off-west-end-2026', title: 'Girls', market: 'west-end', category: 'off-west-end', venue: 'Young Vic', openingDate: '2026-10-01', closingDate: '2026-11-20' };
const bway = { id: 'hamlet-2026', title: 'Hamlet', market: 'broadway', openingDate: '2026-03-01' };
const shows = [hamlet, calendar, girls];

function ctxFor(rows, list = shows) {
  return { market: 'london', shows: list, nycIds: new Set(list.map((s) => s.id)), corpus: census.buildCorpusIndex(rows), outletShowUrls: census.buildOutletShowIndex(rows), nycVenues: census.nycVenuePhrases(list, 'london') };
}
const g = (over) => ({ outletId: 'guardian', sourceSaysReview: true, ...over });

test('isMarketShow: london is the west-end market (West End and Off-West End rows), nyc unchanged', () => {
  assert.equal(census.isMarketShow(girls, 'london'), true);
  assert.equal(census.isMarketShow(bway, 'london'), false);
  assert.equal(census.isMarketShow(bway), true);
});

test('seasonOf splits September to August', () => {
  assert.equal(census.seasonOf('2013-10-02'), '2013-14');
  assert.equal(census.seasonOf('2014-08-31'), '2013-14');
  assert.equal(census.seasonOf('2014-09-01'), '2014-15');
});

test('venueHint and itemMarket place an unmatched review by its venue', () => {
  assert.equal(census.venueHint('Girls review – Young Vic, London'), 'Young Vic, London');
  assert.equal(census.itemMarket({ headline: 'Girls review – Young Vic, London' }).itemMarket, 'off-west-end');
  assert.equal(census.itemMarket({ headline: 'The Hollow review – Marlowe theatre, Canterbury' }).itemMarket, 'regional-uk');
  assert.equal(census.itemMarket({ headline: 'Hamlet review – Gielgud theatre, London' }).itemMarket, 'west-end');
  assert.equal(census.itemMarket({ headline: 'Fleabag review – Edinburgh fringe' }).itemMarket, 'edinburgh');
  assert.equal(census.itemMarket({ headline: 'Legally Blonde with Amber Davies on tour – review' }).itemMarket, 'touring');
});

test("marketSignal: a London venue is home; Duke of York's is not York; a regional house is other-market", () => {
  assert.equal(census.marketSignal({ headline: "Hamlet review – Duke of York's theatre, London" }, [], 'london'), 'home');
  assert.equal(census.marketSignal({ headline: 'Hamlet review – Theatre Royal, York' }, [], 'london'), 'other-market');
  assert.equal(census.marketSignal({ headline: 'Calendar Girls the Musical at New Wolsey Theatre – review' }, [], 'london'), 'other-market');
});

test('a London review of a held show is held; a missing one is a gap', () => {
  const u = 'https://www.theguardian.com/stage/2025/jun/05/hamlet-review-duke-of-yorks';
  const item = g({ url: u, headline: "Hamlet review – Duke of York's theatre, London", publishDate: '2025-06-05' });
  assert.equal(census.bucketItem(item, ctxFor([{ showId: hamlet.id, outletId: 'guardian', url: u }])).bucket, 'held');
  assert.equal(census.bucketItem(item, ctxFor([])).bucket, 'gap');
});

test('a regional production of a West End title is an other-market review with its market, not out-of-window', () => {
  const r = census.bucketItem(g({ url: 'https://www.whatsonstage.com/news/calendar-girls-the-musical-at-new-wolsey-theatre-review_1700000/', headline: 'Calendar Girls the Musical at New Wolsey Theatre – review', publishDate: '2026-09-14' }), ctxFor([]));
  assert.equal(r.bucket, 'other-market-review');
  assert.equal(r.itemMarket, 'regional-uk');
});

test('an unmatched London review is a catalog gap carrying its market and venue', () => {
  const r = census.bucketItem(g({ url: 'https://www.theguardian.com/stage/2014/feb/01/x', headline: 'The Events review – Young Vic, London', publishDate: '2014-02-01' }), ctxFor([]));
  assert.equal(r.bucket, 'catalog-gap');
  assert.equal(r.itemMarket, 'off-west-end');
  assert.equal(r.venueHint, 'Young Vic, London');
});

test('aliasKey: a WhatsOnStage review held under its pre-migration URL is held', () => {
  const old = 'https://www.whatsonstage.com/london-theatre/reviews/hamlet-duke-of-yorks_43290.html';
  const r = census.bucketItem({ outletId: 'whatsonstage', url: 'https://www.whatsonstage.com/news/hamlet-duke-of-yorks_43290/', aliasKey: census.urlKey(old), headline: "Hamlet (Duke of York's Theatre)", publishDate: '2025-06-05' },
    ctxFor([{ showId: hamlet.id, outletId: 'whatsonstage', url: old }]));
  assert.equal(r.bucket, 'held');
  const re = new RegExp(LONDON_SOURCES.whatsonstage.urlId);
  assert.equal(re.exec(old)[1], re.exec('https://www.whatsonstage.com/news/hamlet-duke-of-yorks_43290/')[1]);
});

test('an undated West End row (id year only) does not swallow a review ten years later', () => {
  const old = { id: 'hamlet-west-end-2013', title: 'Hamlet', market: 'west-end' };
  assert.equal(census.inRunWindow(old, '2013-05-01'), true);
  assert.equal(census.inRunWindow(old, '2023-05-01'), false);
});

test('groupCatalogGaps counts reviews by market, venue and year', () => {
  const groups = census.groupCatalogGaps([
    { itemMarket: 'off-west-end', venueHint: 'Young Vic, London', publishDate: '2014-02-01', outletId: 'guardian' },
    { itemMarket: 'off-west-end', venueHint: 'Young Vic', publishDate: '2015-03-01', outletId: 'telegraph' },
    { itemMarket: 'regional-uk', venueHint: 'Crucible, Sheffield', publishDate: '2015-03-01', outletId: 'guardian' },
  ]);
  assert.equal(groups['off-west-end'].reviews, 2);
  assert.deepEqual(groups['off-west-end'].places['young vic'].years, { 2014: 1, 2015: 1 });
  assert.match(census.catalogGapMarkdown(groups), /\| off-west-end \| young vic \| 2 \|/);
});

test('sourceFromJson turns string filters into case-insensitive regexes', () => {
  const s = sourceFromJson({ kind: 'sitemap', url: 'https://x/s.xml', urlFilter: '/theatre/.*-review', childFilter: 'Reviews' });
  assert.ok(s.urlFilter.test('https://x/THEATRE/hamlet-review'));
  assert.ok(s.childFilter instanceof RegExp);
  assert.equal(s.url, 'https://x/s.xml');
});

test('every London source has a kind and a tier, and T1 outlets are all listed', () => {
  for (const [id, s] of Object.entries(LONDON_SOURCES)) {
    assert.ok(s.kind, id);
    assert.ok([1, 2, 3].includes(s.tier), `${id} tier`);
  }
  for (const id of ['guardian', 'telegraph', 'standard', 'times-uk', 'thestage', 'timeout-london', 'financialtimes', 'independent', 'daily-mail', 'i-paper']) assert.ok(LONDON_SOURCES[id], id);
});

test('datedSitemapUrls steps months and years from the since date', () => {
  assert.deepEqual(script.datedSitemapUrls('https://x/{yyyy}-{mm}.xml', 'month', '2012-11-15', '2013-01-10'), ['https://x/2012-11.xml', 'https://x/2012-12.xml', 'https://x/2013-01.xml']);
  assert.deepEqual(script.datedSitemapUrls('https://x/{yyyy}.xml', 'year', '2012-09-01', '2014-02-01'), ['https://x/2012.xml', 'https://x/2013.xml', 'https://x/2014.xml']);
});

test('emitted CENSUS-ITEMS lines round-trip through a saved log, chunks and all', () => {
  const payload = { items: Array.from({ length: 4000 }, (_, i) => ({ url: `https://x/${i}-${Math.random()}`, headline: `Review ${i}` })), notes: ['n'] };
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try { script.emitItems('guardian', payload); } finally { console.log = orig; }
  assert.ok(lines.length > 1, 'chunked');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'census-')), 'log.txt');
  fs.writeFileSync(f, ['2026-10-29T03:00:00Z noise', ...lines.map((l) => `2026-10-29T03:00:01.123Z ${l}`)].join('\n'));
  const got = script.readEmittedItems(f);
  assert.deepEqual(got.guardian, payload);
});

test('parseArgs: london defaults to 2012-09 and the London sources; --tier filters', () => {
  const o = script.parseArgs(['--market=london', '--all', '--tier=1']);
  assert.equal(o.since, '2012-09-01');
  assert.equal(o.sources, LONDON_SOURCES);
  assert.deepEqual(o.tiers, [1]);
  assert.equal(script.parseArgs(['--outlet=x']).since, '2021-06-01');
});

test('cdxItems: canonical https URL, earliest capture, Stage URL shapes kept', () => {
  const { cdxItems } = require('../outlet-census.js');
  const src = LONDON_SOURCES.thestage;
  const rows = [
    ['http://www.thestage.co.uk:80/reviews/review.php/37443/jesus-christ-superstar', '20130105120000'],
    ['http://thestage.co.uk/reviews/review.php/37443/jesus-christ-superstar', '20120901000000'],
    ['https://www.thestage.co.uk/reviews/2017/42nd-street-review-at-theatre-royal-drury-lane/', '20170405000000'],
    ['https://www.thestage.co.uk/long-reviews/after-life', '20200610000000'],
    ['https://www.thestage.co.uk/reviews/?page=2', '20190101000000'],
    ['https://www.thestage.co.uk/news/some-news', '20190101000000'],
  ];
  const items = cdxItems(rows, { ...src, ...src.parts[1] });
  const byUrl = Object.fromEntries(items.map((i) => [i.url, i.periodDate]));
  assert.equal(byUrl['https://www.thestage.co.uk/reviews/review.php/37443/jesus-christ-superstar'], '2012-09-01');
  assert.ok(byUrl['https://www.thestage.co.uk/reviews/2017/42nd-street-review-at-theatre-royal-drury-lane']);
  assert.ok(byUrl['https://www.thestage.co.uk/long-reviews/after-life']);
  assert.equal(items.length, 3);
});
