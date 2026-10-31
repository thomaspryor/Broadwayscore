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

test('titleOnlyInVenue: a title that is only the venue name is no match', () => {
  const bridge = { id: 'the-bridge-off-west-end-2026', title: 'The Bridge' };
  const venues = ['bridge theatre', 'national theatre'];
  assert.equal(census.titleOnlyInVenue(bridge, 'Guys and Dolls review, Bridge Theatre guys-and-dolls-review-bridge-theatre', venues), true);
  assert.equal(census.titleOnlyInVenue(bridge, 'The Bridge review, Southwark Playhouse', venues), false);
  assert.equal(census.titleOnlyInVenue({ title: 'Hamlet' }, 'Hamlet review, National Theatre', venues), false);
  assert.equal(census.titleOnlyInVenue({ title: 'National Theatre' }, 'Hamlet at the National Theatre', ['national theatre']), true);
});

test('bulkLastmodDays: a mass re-touch day is not a publish date', () => {
  const items = [];
  for (let i = 0; i < 300; i++) items.push({ url: `u${i}`, lastmod: '2022-02-16T10:00:00Z' });
  for (let i = 0; i < 50; i++) items.push({ url: `v${i}`, lastmod: `2024-0${(i % 9) + 1}-1${i % 9}` });
  assert.deepEqual([...census.bulkLastmodDays(items)], ['2022-02-16']);
  assert.equal(census.bulkLastmodDays(items.slice(300)).size, 0);
  assert.equal(census.bulkLastmodDays([]).size, 0);
});

test('marketSignal: a West End venue hint outvotes a city in the title (BRO-6488)', () => {
  assert.equal(census.marketSignal({ headline: 'Review: An American in Paris (Dominion Theatre)' }, [], 'london'), 'home');
  assert.equal(census.marketSignal({ headline: 'Brighton Rock review – Theatre Royal Haymarket' }, [], 'london'), 'home');
  assert.equal(census.marketSignal({ headline: 'Hamlet review – Bristol Old Vic' }, [], 'london'), 'other-market');
  assert.equal(census.itemMarket({ headline: 'Macbeth review – Lyceum, Sheffield' }).itemMarket, 'regional-uk');
});

test('inRunWindow: announced rows with only an id year keep no ceiling', () => {
  assert.equal(census.inRunWindow({ id: 'x-2024', status: 'announced' }, '2027-03-01'), true);
  assert.equal(census.inRunWindow({ id: 'x-2015', status: 'closed' }, '2022-03-01'), false);
});

// BRO-6488 matcher false positives, real artsdesk / Time Out slug headlines.
const aladdin = { id: 'aladdin-west-end-2016', title: 'Aladdin', market: 'west-end', venue: 'Prince Edward Theatre', openingDate: '2016-06-15', closingDate: '2019-08-31' };
const hamilton = { id: 'hamilton-west-end-2021', title: 'Hamilton', market: 'west-end', venue: 'Victoria Palace Theatre', openingDate: '2017-12-21' };
const stories = { id: 'stories-west-end-2018', title: 'Stories', market: 'west-end', venue: 'Dorfman Theatre', openingDate: '2018-10-17', closingDate: '2018-11-28' };
const beautiful = { id: 'beautiful-the-carole-king-musical-west-end-2015', title: 'Beautiful, the Carole King Musical', market: 'west-end', venue: 'Aldwych Theatre', openingDate: '2015-02-24', closingDate: '2017-08-05' };

test('titleOnlyInTagline: a title only after "review" in a slug headline is the tagline', () => {
  assert.equal(census.titleOnlyInTagline(stories, 'misty bush theatre review powerful meditation how we tell stories'), true);
  assert.equal(census.titleOnlyInTagline(hamilton, 'infamous jermyn street theatre review lady hamilton challenges patriarchy and loses'), true);
  assert.equal(census.titleOnlyInTagline(hamilton, 'hamilton victoria palace review rich radical and ridiculously exciting'), false);
  assert.equal(census.titleOnlyInTagline(hamilton, 'Review: Hamilton at the Victoria Palace'), false);
  assert.equal(census.titleOnlyInTagline(hamilton, 'theatre review hamilton'), false);
});

test('venueContradicts: a different house named after the title is another production', () => {
  assert.equal(census.venueContradicts(aladdin, 'aladdin hackney empire review clive rowe returns dame'), true);
  assert.equal(census.venueContradicts(aladdin, 'aladdin richmond theatre review great dame weak script'), true);
  assert.equal(census.venueContradicts(hamilton, 'hamilton victoria palace review rich radical and ridiculously exciting'), false);
  assert.equal(census.venueContradicts(hamilton, 'Hamilton review – Victoria Palace Theatre'), false);
  assert.equal(census.venueContradicts({ ...aladdin, venue: null }, 'aladdin hackney empire review'), false);
});

test('bucketItem: tagline, panto and slug-variant false matches no longer land as gaps', () => {
  const list = [aladdin, hamilton, stories, beautiful];
  const ctx = ctxFor([], list);
  const item = (url, headline, publishDate) => ({ outletId: 'artsdesk', sourceSaysReview: true, url, headline, publishDate });
  const panto = census.bucketItem(item('https://theartsdesk.com/theatre/aladdin-hackney-empire-review-clive-rowe-returns-dame', 'aladdin hackney empire review clive rowe returns dame', '2018-12-01'), ctx);
  assert.notEqual(panto.bucket, 'gap');
  assert.deepEqual(panto.venueMismatchIds, ['aladdin-west-end-2016']);
  const misty = census.bucketItem(item('https://theartsdesk.com/theatre/misty-bush-theatre-review-powerful-meditation-how-we-tell-stories', 'misty bush theatre review powerful meditation how we tell stories', '2018-11-01'), ctx);
  assert.notEqual(misty.bucket, 'gap');
  const future = census.bucketItem(item('https://www.timeout.com/london/theatre/this-beautiful-future-review', 'this beautiful future review', '2017-06-20'), ctx);
  assert.notEqual(future.bucket, 'gap');
  const real = census.bucketItem(item('https://theartsdesk.com/theatre/hamilton-victoria-palace-review-rich-radical-and-ridiculously-exciting', 'hamilton victoria palace review rich radical and ridiculously exciting', '2018-01-01'), ctx);
  assert.equal(real.bucket, 'gap');
});

test('venueContradicts: stems and National Theatre houses are the same venue', () => {
  const mousetrap = { id: 'the-mousetrap-west-end-1952', title: 'The Mousetrap', venue: "St Martin's Theatre" };
  const pride = { id: 'pride-west-end-2026', title: 'Pride', venue: 'Olivier Theatre' };
  assert.equal(census.venueContradicts(mousetrap, 'theartsdesk mot mousetrap st martins theatre'), false);
  assert.equal(census.venueContradicts(pride, 'Pride musical at the National Theatre – review'), false);
});

test('venueContradicts: generic venue words and renamed houses are not another venue', () => {
  const hamlet = { id: 'hamlet-west-end-2026', title: 'Hamlet', venue: "Wyndham's Theatre" };
  for (const h of ['Hamlet, Theatre Review', 'hamlet theatre review', 'hamlet west end theatre review', 'hamlet with music hall songs review']) {
    assert.equal(census.venueContradicts(hamlet, h), false, h);
  }
  assert.equal(census.venueContradicts(hamlet, 'hamlet hackney empire review'), true);
  assert.equal(census.venueContradicts({ id: 'r', title: 'Rosmersholm', venue: 'Tom Stoppard Theatre' }, 'rosmersholm duke of yorks theatre review'), false);
  assert.equal(census.venueContradicts({ id: 'c', title: 'Cinderella', venue: 'Gillian Lynne Theatre' }, 'cinderella new london theatre review'), false);
  assert.equal(census.venueContradicts({ id: 'l', title: 'Les Miserables', venue: 'Sondheim Theatre' }, 'les miserables queens theatre review'), false);
  assert.equal(census.venueContradicts({ id: 'a', title: 'As You Like It', venue: 'Soho Place' }, 'as you like it @sohoplace theatre review'), false);
});

test('titleOnlyInTagline: a label before "review:" is not a lead', () => {
  const hamlet = { id: 'hamlet-west-end-2026', title: 'Hamlet', venue: "Wyndham's Theatre" };
  for (const h of ['Five-star review: Hamlet', 'Fringe review: Hamlet', 'BWW Review: HAMLET at Wyndhams', 'VAULT Festival review: Hamlet']) {
    assert.equal(census.titleOnlyInTagline(hamlet, h), false, h);
  }
});

test('variantMatches: the lowercase-slug rule is London only', () => {
  const beautiful = { id: 'beautiful-the-carole-king-musical-2014', title: 'Beautiful: The Carole King Musical', openingDate: '2014-01-12', closingDate: '2019-10-27' };
  const item = { headline: 'this beautiful future review', publishDate: '2017-06-01' };
  assert.deepEqual(census.variantMatches(item, [beautiful], { london: true }), []);
});

test('venueContradicts: a one-word house name still counts as a venue', () => {
  const avenueQ = { id: 'avenue-q-west-end-2026', title: 'Avenue Q', venue: 'Shaftesbury Theatre' };
  assert.equal(census.venueContradicts(avenueQ, 'avenue q the playhouse 7196'), true);
  assert.equal(census.venueContradicts({ ...avenueQ, venue: 'Playhouse Theatre' }, 'avenue q the playhouse 7196'), false);
});

test('venueContradicts: a cut-off city fragment after the house still counts', () => {
  const rIII = { id: 'richard-iii-west-end-2016', title: 'Richard III', venue: 'Almeida Theatre' };
  assert.equal(census.venueContradicts(rIII, 'richard iii swan theatre s 7453'), true);
  assert.equal(census.venueContradicts({ ...rIII, venue: 'Swan Theatre' }, 'richard iii swan theatre s 7453'), false);
});

test('venueContradicts: an opera house is a named venue', () => {
  const pan = { id: 'peter-pan-west-end-2015', title: 'Peter Pan', venue: 'Open Air Theatre' };
  assert.equal(census.venueContradicts(pan, 'peter pan opera house ma 8379'), true);
});

test('venueContradicts: a touring Empire is a named venue', () => {
  const show = { id: 'wicked-west-end-2006', title: 'Wicked', venue: 'Apollo Victoria Theatre' };
  assert.equal(census.venueContradicts(show, 'wicked empire sunderla'), true);
  const hold = { id: 'x', title: 'Wicked', venue: 'Empire Theatre' };
  assert.equal(census.venueContradicts(hold, 'wicked empire sunderla'), false);
});

test('archivalYear: a year inside the show run is no archive mark (London Theatre long runs)', () => {
  const lesmis = { id: 'les-miserables-west-end-1985', title: 'Les Miserables', openingDate: '1985-10-08' };
  const henry = { id: 'henry-v-west-end-2013', title: 'Henry V', openingDate: '2013-11-23' };
  assert.equal(census.archivalYear({ url: 'https://www.londontheatre.co.uk/reviews/les-miserables-1996' }, [lesmis]), null);
  assert.equal(census.archivalYear({ url: 'https://www.londontheatre.co.uk/reviews/henry-v-noel-coward-theatre-2013' }, [henry]), null);
  assert.equal(census.archivalYear({ url: 'https://www.londontheatre.co.uk/reviews/henry-v-2012' }, [henry]), '2012');
});

test('isIncompleteEnumeration: a composite part note ("sitemap: child ...") still counts', () => {
  assert.equal(census.isIncompleteEnumeration(['sitemap: child https://www.thestage.co.uk/x.xml: HTTP 500']), true);
  assert.equal(census.isIncompleteEnumeration(['serp: no SERP provider for "q"']), true);
  assert.equal(census.isIncompleteEnumeration(['cdx: wayback cdx: 10 captures, 9 URLs']), false);
});
