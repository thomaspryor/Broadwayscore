// BRO-4398 — Off-West End dated venue readers and the OWE promoter's dated
// listing rule. Real fixtures (tests/fixtures/owe-discovery/, captured live
// 2026-09-30) go through the real chain: parseVenueListingHtml →
// discover-new-shows.js oweCandidatesFromDatedListing → the promoter's
// decideOffWestEndVenuePromotion / evaluateCandidates (CLAUDE.md §15: the
// exported functions, never copies).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  decideOffWestEndVenuePromotion,
  buildOffWestEndVenueShowEntry,
  evaluateCandidates,
  fetchVenueListings,
  isDatedListingCandidate,
  isCuratedLondonVenue,
  listingRunDates,
} = require('../../scripts/promote-owe-venue-candidates.js');
const { oweCandidatesFromDatedListing } = require('../../scripts/discover-new-shows.js');
const { OWE_VENUE_CONFIGS, parseVenueListingHtml } = require('../../scripts/lib/venue-listing-discover.js');
const { candidateHash } = require('../../scripts/lib/owe-venue-staging.js');
const { buildVenueVocabulary } = require('../../scripts/lib/show-title-normalize.js');
const {
  parseDateRangeText,
  parseSpektrixEvents,
  extractDatedJsonLdEvents,
  cleanListingTitle,
  htmlToDocument,
} = require('../../scripts/lib/ob-listing-platforms.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', 'owe-discovery');
const TODAY = '2026-09-30';
const NOW = new Date(`${TODAY}T12:00:00Z`);

function venueRows(name) {
  const cfg = OWE_VENUE_CONFIGS.find(v => v.name === name);
  assert.ok(cfg, `${name} in OWE_VENUE_CONFIGS`);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ext = cfg.strategy === 'spektrix' ? '.json' : '.html';
  const listing = parseVenueListingHtml(cfg, readFileSync(join(FIXTURES, slug + ext), 'utf8'), { todayIso: TODAY });
  return oweCandidatesFromDatedListing(cfg, listing).map(c => ({ ...c, source: c.discoverySource, candidateHash: candidateHash(c) }));
}

function decide(c) {
  return decideOffWestEndVenuePromotion(c, { todayIso: TODAY });
}

// ── readers ────────────────────────────────────────────────────────────────

test('parseDateRangeText dayFirst: UK card formats', () => {
  const cases = [
    ['Fri 16 - Fri 23 Oct 2026', '2026-10-16', '2026-10-23'],
    ['Tue 8 Sep – Sat 31 Oct 2026', '2026-09-08', '2026-10-31'],
    ['29 Sept  - 24 Oct 2026', '2026-09-29', '2026-10-24'],
    ['13 - 24 October 2026', '2026-10-13', '2026-10-24'],
    ['30 - 2 Nov 2026', '2026-10-30', '2026-11-02'],
    ['Dates: 25 Nov 2026 – 23 Jan 2027', '2026-11-25', '2027-01-23'],
    ['30/09/2026 - 10/10/2026', '2026-09-30', '2026-10-10'],
    ['Until 14 Nov', null, '2026-11-14'],
  ];
  for (const [text, first, last] of cases) {
    assert.deepEqual(parseDateRangeText(text, { todayIso: TODAY, dayFirst: true }), { firstDate: first, lastDate: last }, text);
  }
  // Month-first stays the default.
  assert.deepEqual(parseDateRangeText('Oct 3 – Nov 16, 2026', { todayIso: TODAY }), { firstDate: '2026-10-03', lastDate: '2026-11-16' });
});

test('extractDatedJsonLdEvents: venue node `event` list, and a ranged node has an unknown count', () => {
  const html = `<script type="application/ld+json">{"@type":"PerformingArtsTheater","name":"V","event":[
    {"@type":"TheaterEvent","name":"Ranged","startDate":"2026-10-01","endDate":"2026-11-01"},
    {"@type":"TheaterEvent","name":"One Night","startDate":"2026-10-05"}]}</script>`;
  const by = Object.fromEntries(extractDatedJsonLdEvents(htmlToDocument(html)).map(r => [r.title, r]));
  assert.deepEqual([by.Ranged.firstDate, by.Ranged.lastDate, by.Ranged.performanceCount], ['2026-10-01', '2026-11-01', null]);
  assert.equal(by['One Night'].performanceCount, 1);
});

test('parseSpektrixEvents: instance counts, cancelled instances, attribute exclusions', () => {
  const events = [
    { id: 'a', name: 'Run', firstInstanceDateTime: '2026-10-01T19:30:00', lastInstanceDateTime: '2026-10-20T19:30:00' },
    { id: 'b', name: 'Add-on', firstInstanceDateTime: '2026-10-01T19:30:00', lastInstanceDateTime: '2026-10-20T19:30:00', attribute_SupplementaryEvent: 'true' },
    { id: 'c', name: 'All Cancelled', firstInstanceDateTime: '2026-10-01T19:30:00', lastInstanceDateTime: '2026-10-02T19:30:00' },
  ];
  const instances = [
    { event: { id: 'a' }, start: '2026-10-01T19:30:00', cancelled: false }, { event: { id: 'a' }, start: '2026-10-20T19:30:00', cancelled: false }, { event: { id: 'a' }, start: '2026-10-05T19:30:00', cancelled: true },
    { event: { id: 'b' }, start: '2026-10-01T19:30:00', cancelled: false }, { event: { id: 'c' }, start: '2026-10-01T19:30:00', cancelled: true },
  ];
  const rows = parseSpektrixEvents({ events, instances }, { exclude: { attribute_SupplementaryEvent: /^true$/i } });
  assert.deepEqual(rows.map(r => [r.title, r.performanceCount]), [['Run', 2]]);
  // One event holding bookings months apart: the row is the current/next block.
  const split = parseSpektrixEvents({
    events: [{ id: 'g', name: 'God Is A Woman', firstInstanceDateTime: '2026-04-03T19:30:00', lastInstanceDateTime: '2027-01-10T19:30:00' }],
    instances: ['2026-04-03', '2026-04-04', '2026-06-10', '2026-06-11', '2027-01-05', '2027-01-06', '2027-01-07', '2027-01-08', '2027-01-10']
      .map(d => ({ event: { id: 'g' }, start: `${d}T19:30:00`, cancelled: false })),
  }, { todayIso: '2026-09-30' });
  assert.deepEqual(split.map(r => [r.firstDate, r.lastDate, r.performanceCount]), [['2027-01-05', '2027-01-10', 5]]);
  // Events alone: count unknown, nothing dropped for it.
  assert.deepEqual(parseSpektrixEvents(events).map(r => r.performanceCount), [null, null, null]);
});

test('cleanListingTitle strips London season tags', () => {
  assert.equal(cleanListingTitle('Cinderella (2026)'), 'Cinderella');
  assert.equal(cleanListingTitle('2026: The Master Builder'), 'The Master Builder');
  assert.equal(cleanListingTitle('Class of 2026'), 'Class of 2026');
  // BRO-4433: month-and-year tags are stripped per venue, never here (a
  // title can end in a date).
  assert.equal(cleanListingTitle('Halloween Oct 31'), 'Halloween Oct 31');
});

test("stripMonthYearTags (Wilton's only): booking tags go, other venues' titles are untouched", () => {
  const wiltons = OWE_VENUE_CONFIGS.find(v => v.name === "Wilton's Music Hall");
  const ev = (id, name) => ({ id, name, firstInstanceDateTime: '2026-10-15T19:30:00', lastInstanceDateTime: '2026-10-20T19:30:00', attribute_GenresForWebsiteFiltering: 'Theatre' });
  const payload = [ev('a', 'Romeo and Juliet - Oct26'), ev('b', 'The Law of Mayhem Apr27'), ev('c', 'Wolf Country Jan 27'), ev('d', 'Catch-22')];
  assert.deepEqual(parseVenueListingHtml(wiltons, payload, { todayIso: TODAY }).map(c => c.title).sort(), ['Catch-22', 'Romeo and Juliet', 'The Law of Mayhem', 'Wolf Country']);
  const other = { ...wiltons, name: 'Other', stripMonthYearTags: undefined };
  assert.ok(parseVenueListingHtml(other, payload, { todayIso: TODAY }).some(c => c.title === 'Wolf Country Jan 27'));
});

test('parseTicketsolveShows: local performance days, run blocks, cancelled and excluded categories skipped', () => {
  const { parseTicketsolveShows } = require('../../scripts/lib/ob-listing-platforms.js');
  const ev = (iso, status = 'available') => `<event><name><![CDATA[x]]></name><date_time_iso format="ISO 8601" zone="GMT">${iso}</date_time_iso><status>${status}</status></event>`;
  const show = (name, cat, evs) => `<show id="1"><name><![CDATA[${name}]]></name><event_category><![CDATA[${cat}]]></event_category><url>https://x.ticketsolve.com/shows/1</url><events>${evs.join('')}</events></show>`;
  const xml = `<venues><venue><name><![CDATA[V]]></name><shows>${[
    show('Late Night', 'Drama', [ev('2026-10-01T23:30:00+01:00'), ev('2026-10-02T23:30:00+01:00'), ev('2026-10-03T19:30:00+01:00', 'cancelled')]),
    show('Showcase Night', 'Showcase', [ev('2026-10-01T19:30:00+01:00'), ev('2026-10-02T19:30:00+01:00')]),
  ].join('')}</shows></venue></venues>`;
  const rows = parseTicketsolveShows(xml, { todayIso: TODAY, excludeCategory: /showcase/i });
  assert.deepEqual(rows.map(r => [r.title, r.firstDate, r.lastDate, r.performanceCount]), [['Late Night', '2026-10-01', '2026-10-02', 2]]);
});

// ── the dated-listing promotion rule ───────────────────────────────────────

test('Southwark Playhouse Spektrix fixture: every current run confirms on its own listing', () => {
  const rows = venueRows('Southwark Playhouse');
  assert.ok(rows.length >= 8);
  for (const c of rows) {
    assert.ok(isDatedListingCandidate(c), c.title);
    const d = decide(c);
    assert.equal(d.confirmed, true, `${c.title}: ${d.reason}`);
    assert.equal(d.source, 'venue-listing');
  }
});

test('real fixtures: one-nighters, short bookings and recurring nights are refused and pruned', () => {
  const byTitle = new Map([...venueRows('Theatre Royal Stratford East'), ...venueRows('Park Theatre'), ...venueRows("King's Head Theatre")].map(c => [c.title, c]));
  const refused = {
    'The Ballad of John and Paul': /one-night|only 1 performance/, // Stratford East, 1 performance
    'Drag Tales': /one-night|only \d performance/,                // Park, a monthly drag brunch (one date per block)
    'Thou Shalt Sit The F*** Down': /one-night|only 1 performance/,
  };
  for (const [title, re] of Object.entries(refused)) {
    const c = byTitle.get(title);
    assert.ok(c, `${title} staged`);
    const d = decide(c);
    assert.equal(d.confirmed, false, title);
    assert.equal(d.persistent, true, title);
    assert.match(d.reason, re, title);
  }
  for (const title of ['Bloodsport', 'Robin Hood', 'The Pianist', 'Holy Fool', 'Gang Of Three']) {
    const d = decide(byTitle.get(title));
    assert.equal(d.confirmed, true, `${title}: ${d.reason}`);
  }
});

test('dated-card fixtures (Hampstead, Almeida, Finborough, New Diorama, Menier) confirm without a performance count', () => {
  for (const [venue, title] of [['Hampstead Theatre', 'Kimberly Akimbo'], ['Almeida Theatre', 'Golden Boy'], ['Finborough Theatre', 'What The Animals Say'], ['New Diorama Theatre', 'STUFFED'], ['Menier Chocolate Factory', 'Tru']]) {
    const c = venueRows(venue).find(r => r.title === title);
    assert.ok(c, `${venue}: ${title} staged`);
    const d = decide(c);
    assert.equal(d.confirmed, true, `${venue} ${title}: ${d.reason}`);
  }
});

test('dated rule: ended run and uncurated venue prune; a run more than a year out holds', () => {
  const base = { category: 'off-west-end', source: 'venue-page:bush-theatre', discoverySource: 'venue-page:bush-theatre', venue: 'Bush Theatre', listingPerformanceCount: 30 };
  const ended = decide({ ...base, title: 'Gone', listingFirstDate: '2026-08-01', listingLastDate: '2026-09-01' });
  assert.deepEqual([ended.confirmed, ended.persistent], [false, true]);
  assert.match(ended.reason, /already ended/);
  const far = decide({ ...base, title: 'Later', listingFirstDate: '2027-12-01', listingLastDate: '2028-01-10' });
  assert.deepEqual([far.confirmed, far.persistent], [false, false]);
  const elsewhere = decide({ ...base, title: 'Elsewhere', venue: 'Some Pub Theatre', source: 'venue-page:some-pub-theatre', listingFirstDate: '2026-10-01', listingLastDate: '2026-10-30' });
  assert.deepEqual([elsewhere.confirmed, elsewhere.persistent], [false, true]);
  assert.match(elsewhere.reason, /not in canonical/);
});

test('isCuratedLondonVenue: dated-only venues, link-reader venues, nothing else', () => {
  assert.equal(isCuratedLondonVenue('Bush Theatre'), true);          // dated reader only
  assert.equal(isCuratedLondonVenue('The Other Palace'), true);      // link reader only
  assert.equal(isCuratedLondonVenue('Hampstead Theatre'), true);     // both
  assert.equal(isCuratedLondonVenue('Palace Theatre'), false);
});

test('listingRunDates + entry: first performance → previewsStartDate, last → closingDate; horizon/next flags respected', () => {
  const c = { title: 'Jane Eyre', venue: 'Southwark Playhouse', category: 'off-west-end', source: 'venue-page:southwark-playhouse', listingFirstDate: '2026-08-28', listingLastDate: '2026-10-24', listingPerformanceCount: 65 };
  assert.deepEqual(listingRunDates(c), { previewsStartDate: '2026-08-28', closingDate: '2026-10-24' });
  assert.deepEqual(listingRunDates({ ...c, listingFirstDateIsNext: true, listingLastDateIsHorizon: true }), { previewsStartDate: null, closingDate: null });
  const entry = buildOffWestEndVenueShowEntry(c, buildVenueVocabulary([]), { now: NOW });
  assert.equal(entry.previewsStartDate, '2026-08-28');
  assert.equal(entry.closingDate, '2026-10-24');
  assert.equal(entry.status, 'previews');
  assert.equal(entry.type, 'play');
  assert.equal(entry.provisional, true);
});

test('fetchVenueListings never re-fetches a venue for dated candidates', async () => {
  let fetches = 0;
  const fetchPage = async () => { fetches++; return { content: '' }; };
  const dated = { title: 'Jane Eyre', venue: 'Southwark Playhouse', listingFirstDate: '2026-08-28', listingLastDate: '2026-10-24' };
  const listings = await fetchVenueListings([dated], { fetchPage, log: () => {} });
  assert.equal(listings.size, 0);
  assert.equal(fetches, 0);
});

test('evaluateCandidates: a dated fixture candidate promotes with its run dates; a duplicate prunes', async () => {
  const rows = venueRows('Bush Theatre');
  const darkling = rows.find(r => r.title === 'Darkling');
  const hungry = rows.find(r => r.title === 'The Hungry Ghost');
  assert.ok(darkling && hungry);
  const logged = [];
  const { promoted, pruned } = await evaluateCandidates([darkling, hungry], {
    existingCandidates: [{ id: 'the-hungry-ghost-owe-2026', title: 'The Hungry Ghost', venue: 'Bush Theatre', category: 'off-west-end' }],
    existingIds: new Set(['the-hungry-ghost-owe-2026']),
    venueVocabulary: buildVenueVocabulary([]),
    retiredEntries: [],
    logEntry: e => logged.push(e),
    now: () => NOW,
  });
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].entry.title, 'Darkling');
  assert.equal(promoted[0].entry.venue, 'Bush Theatre');
  assert.equal(promoted[0].entry.previewsStartDate, darkling.listingFirstDate);
  assert.equal(promoted[0].entry.closingDate, darkling.listingLastDate);
  assert.match(promoted[0].confirmationReason, /venue's own listing/);
  assert.ok(pruned.some(p => p.kind === 'skip-duplicate' && p.candidate.title === 'The Hungry Ghost'));
});

test('findSameHouseTokenMatch: slug-title catalog rows match the dated full title at the same house only', () => {
  const { findSameHouseTokenMatch } = require('../../scripts/promote-owe-venue-candidates.js');
  const pool = [
    { id: 'twenty-thousand-streets-off-west-end-2026', title: 'Twenty Thousand Streets', venue: 'Southwark Playhouse' },
    { id: 'berlin2027-off-west-end-2026', title: 'Berlin_2027', venue: 'Kiln Theatre' },
    { id: 'king-lear-old', title: 'King Lear', venue: 'Orange Tree Theatre', closingDate: '2019-05-01' },
    { id: 'hamlet-elsewhere', title: 'Hamlet', venue: 'Almeida Theatre' },
  ];
  const hit = (title, venue, extra = {}) => findSameHouseTokenMatch({ title, venue, ...extra }, pool);
  const run = { listingFirstDate: '2026-09-10', listingLastDate: '2026-10-17' };
  assert.equal(hit('Twenty Thousand Streets Under the Sky', 'Southwark Playhouse Elephant', run)?.match.id, 'twenty-thousand-streets-off-west-end-2026');
  assert.equal(hit('Twenty Thousand Streets Under the Sky', 'Southwark Playhouse'), null, 'an undated candidate needs equal words');
  assert.equal(hit('Berlin', 'Kiln Theatre')?.match.id, 'berlin2027-off-west-end-2026');
  assert.equal(hit('King Lear', 'Orange Tree Theatre', { listingFirstDate: '2027-02-15' }), null, 'a production that closed years earlier is not this one');
  assert.equal(hit('Hamlet', 'Kiln Theatre'), null, 'another house');
  assert.equal(hit('Streets', 'Southwark Playhouse'), null, 'one word is not enough to call a subset');
});

test('dedupe: contained titles need an overlapping run; the London-wide title match needs the same house for a dated row', () => {
  const { findSameHouseTokenMatch, findDuplicate } = require('../../scripts/promote-owe-venue-candidates.js');
  const pool = [
    { id: 'private-lives-of-the-royals', title: 'Private Lives of the Royals', venue: 'Park Theatre', previewsStartDate: '2026-06-01', closingDate: '2026-07-01' },
    { id: 'a-dolls-house-almeida', title: "A Doll's House", venue: 'Almeida Theatre', previewsStartDate: '2026-04-01', closingDate: '2026-05-23' },
    { id: 'cinderella-palladium', title: 'Cinderella', venue: 'London Palladium', category: 'west-end', previewsStartDate: '2026-12-05', closingDate: '2027-01-10' },
    { id: 'robin-hood-merry-mandem', title: 'Robin Hood and the Merry Mandem', venue: 'Theatre Royal Stratford East' },
  ];
  const dated = (title, venue, first, last) => ({ title, venue, category: 'off-west-end', source: 'venue-page:x', listingFirstDate: first, listingLastDate: last, listingPerformanceCount: 30 });
  assert.equal(findSameHouseTokenMatch(dated('Private Lives', 'Park Theatre', '2026-10-01', '2026-11-01'), pool), null);
  assert.equal(findSameHouseTokenMatch(dated("A Doll's House Part 2", 'Almeida Theatre', '2027-01-10', '2027-02-20'), pool), null);
  assert.equal(findSameHouseTokenMatch(dated('Robin Hood', 'Theatre Royal Stratford East', '2026-11-21', '2027-01-02'), pool)?.match.id, 'robin-hood-merry-mandem');
  assert.equal(findDuplicate(dated('Cinderella', 'Lyric Hammersmith', '2026-11-14', '2027-01-03'), pool), null, "the Lyric's Cinderella is not the Palladium's");
  assert.equal(findDuplicate(dated("A Doll's House", 'Barbican Theatre', '2027-02-03', '2027-02-06'), pool), null);
});

test('an undated row at a venue with a dated reader is dropped, not confirmed by the link page', () => {
  // 2026-09-30: Kiln's cinema screenings ("Sense And Sensibility") and The
  // Other Palace's "Scribbles Concert" reached shows.json this way.
  const kiln = { title: 'Sense And Sensibility', venue: 'Kiln Theatre', category: 'off-west-end', source: 'venue-page:kiln-theatre', discoverySource: 'venue-page:kiln-theatre' };
  const listings = new Map([['Kiln Theatre', { titles: new Set(['sense and sensibility']), rowCount: 20, error: null }]]);
  const d = decideOffWestEndVenuePromotion(kiln, { venueListings: listings, todayIso: TODAY });
  assert.deepEqual([d.confirmed, d.persistent], [false, true]);
  assert.match(d.reason, /has a dated reader/);
});

test('shouldExcludeVenueShow: a title ending in "Concert" is a one-off concert; a play naming one is not', () => {
  const { shouldExcludeVenueShow } = require('../../scripts/discover-new-shows.js');
  assert.equal(shouldExcludeVenueShow('Scribbles Concert'), true);
  assert.equal(shouldExcludeVenueShow('Scribbles Concert! '), true);
  assert.equal(shouldExcludeVenueShow('Concert of the Birds'), false);
});

test('real OWE_VENUE_CONFIGS end to end: an undated row at a dated venue (or one of its rooms) prunes; an evidence-backed one there still confirms', async () => {
  const { isCuratedLondonVenue } = require('../../scripts/promote-owe-venue-candidates.js');
  assert.equal(isCuratedLondonVenue('The Maria Theatre'), true, 'a room of a dated reader counts');
  const undated = (title, venue) => {
    const c = { title, venue, category: 'off-west-end', source: 'venue-page:x', discoverySource: 'venue-page:x', description: '' };
    return { ...c, candidateHash: candidateHash(c) };
  };
  const logged = [];
  const { promoted, pruned } = await evaluateCandidates([undated('Sense And Sensibility', 'Kiln Theatre'), undated('Some Studio Play', 'The Maria Theatre')], {
    existingCandidates: [], existingIds: new Set(), venueVocabulary: buildVenueVocabulary([]), retiredEntries: [],
    venueListings: new Map([['Kiln Theatre', { titles: new Set(['sense and sensibility']), rowCount: 20, error: null }]]),
    logEntry: e => logged.push(e), now: () => NOW,
  });
  assert.equal(promoted.length, 0);
  assert.equal(pruned.filter(p => /has a dated reader/.test(p.reason)).length, 2);

  const withEvidence = { ...undated('Nine Night', 'Kiln Theatre'), evidence: [{ kind: 'review-url', url: 'https://www.theguardian.com/stage/2026/nov/20/nine-night-review' }] };
  const d = decideOffWestEndVenuePromotion(withEvidence, {
    todayIso: TODAY,
    outletRegistry: { outlets: { guardian: { tier: 1 } } },
    evidencePages: new Map([[withEvidence.evidence[0].url, { text: 'Nine Night review: a triumph at the Kiln', error: null }]]),
  });
  assert.equal(d.confirmed, true, d.reason);
});

test('BRO-4433 main: a confirmed dated duplicate dates its undated row (null fields only), fixes a slug-truncated title, and a dry run only lists it', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { main, datedBackfillFor } = require('../../scripts/promote-owe-venue-candidates.js');
  const { writeStagingCandidates } = require('../../scripts/lib/owe-venue-staging.js');
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'owe-backfill-'));
  const paths = {
    showsPath: join(dir, 'shows.json'),
    stagingPath: join(dir, 'owe-venue-candidates.json'),
    lastPromotionFile: join(dir, 'owe-last-promotion-ids.json'),
  };
  const row = (id, title, extra = {}) => ({ id, title, slug: id.replace(/-\d{4}$/, ''), venue: 'Southwark Playhouse', status: 'announced', type: 'play', category: 'off-west-end', market: 'west-end', openingDate: null, previewsStartDate: null, closingDate: null, ...extra });
  const shows = [
    row('twenty-thousand-streets-off-west-end-2026', 'Twenty Thousand Streets'),
    row('private-jones-off-west-end-2026', 'Private Jones'),
    // Already dated by another source: never touched, not even its null closingDate.
    row('jane-eyre-off-west-end-2026', 'Jane Eyre', { previewsStartDate: '2026-08-20' }),
  ];
  fs.writeFileSync(paths.showsPath, JSON.stringify({ _meta: { totalShows: shows.length }, shows }, null, 2) + '\n');
  const titles = new Set(['Twenty Thousand Streets Under the Sky', 'Private Jones', 'Jane Eyre']);
  writeStagingCandidates(venueRows('Southwark Playhouse').filter(c => titles.has(c.title)), paths.stagingPath);
  const entries = [];
  const io = { ...paths, retiredEntries: [], log: () => {}, logEntry: e => entries.push(e), now: () => NOW, fetchPage: async () => { throw new Error('no network in tests'); } };

  const before = fs.readFileSync(paths.showsPath, 'utf8');
  const dry = await main(['--dry-run'], io);
  assert.deepEqual(dry.backfills.map(b => b.id).sort(), ['private-jones-off-west-end-2026', 'twenty-thousand-streets-off-west-end-2026']);
  assert.equal(fs.readFileSync(paths.showsPath, 'utf8'), before, 'dry run writes nothing');

  const res = await main([], io);
  assert.equal(res.promoted.length, 0);
  const after = Object.fromEntries(JSON.parse(fs.readFileSync(paths.showsPath, 'utf8')).shows.map(s => [s.id, s]));
  const tts = after['twenty-thousand-streets-off-west-end-2026'];
  assert.deepEqual([tts.previewsStartDate, tts.closingDate, tts.title, tts.slug, tts.status], ['2026-09-10', '2026-10-17', 'Twenty Thousand Streets Under the Sky', 'twenty-thousand-streets-off-west-end', 'announced']);
  const pj = after['private-jones-off-west-end-2026'];
  assert.deepEqual([pj.previewsStartDate, pj.closingDate, pj.title], ['2026-12-14', '2027-01-30', 'Private Jones']);
  assert.deepEqual([after['jane-eyre-off-west-end-2026'].previewsStartDate, after['jane-eyre-off-west-end-2026'].closingDate], ['2026-08-20', null]);
  assert.equal(entries.filter(e => e.kind === 'backfill-dates').length, 2);
  assert.equal(entries.find(e => e.id === 'twenty-thousand-streets-off-west-end-2026' && e.kind === 'backfill-dates').oldTitle, 'Twenty Thousand Streets');
  assert.deepEqual(require('../../scripts/lib/owe-venue-staging.js').loadStaging(paths.stagingPath), [], 'duplicates leave staging');

  // A subtitle/venue tag is not a title upgrade; an undated candidate gives nothing.
  const murder = { title: 'Murder in the Cathedral: OT in the Church', venue: 'Southwark Playhouse', source: 'venue-listing:x', discoverySource: 'venue-listing:x', listingFirstDate: '2026-10-12', listingLastDate: '2026-11-07' };
  const patch = datedBackfillFor(murder, { title: 'Murder Cathedral' });
  assert.deepEqual(patch, { previewsStartDate: '2026-10-12', closingDate: '2026-11-07' });
  assert.equal(datedBackfillFor({ title: 'Private Jones', venue: 'Southwark Playhouse' }, { title: 'Private Jones' }), null);
  // A stub minted two years before the listed run is an earlier production;
  // a non-announced row is left to its own pipeline; a spaced-dash variant is no title upgrade.
  const pjc = { title: 'Private Jones', venue: 'Southwark Playhouse', source: 'venue-listing:x', discoverySource: 'venue-listing:x', listingFirstDate: '2026-12-14', listingLastDate: '2027-01-30' };
  assert.equal(datedBackfillFor(pjc, { id: 'private-jones-off-west-end-2024', title: 'Private Jones', status: 'announced' }), null);
  assert.ok(datedBackfillFor(pjc, { id: 'private-jones-off-west-end-2026', title: 'Private Jones', status: 'announced' }));
  assert.equal(datedBackfillFor(pjc, { id: 'private-jones-off-west-end-2026', title: 'Private Jones', status: 'closed' }), null);
  const md = datedBackfillFor({ ...pjc, title: 'Private Jones - Relaxed Performance' }, { id: 'private-jones-off-west-end-2026', title: 'Private Jones', status: 'announced' });
  assert.equal(md.title, undefined);
});

test("type comes from the venue's genre label when it names one, else the title", () => {
  const { showTypeFor } = require('../../scripts/lib/title-says-musical.js');
  assert.equal(showTypeFor('Jimmy', 'Drama'), 'play');
  assert.equal(showTypeFor('Some Show', 'Musicals'), 'musical');                 // Park Theatre's genre
  assert.equal(showTypeFor('Some Show', 'Musical - star casting'), 'musical');   // Young Vic's genre
  assert.equal(showTypeFor('Father Christmas', "Christmas Shows; Children's Show"), 'play');
  assert.equal(showTypeFor('Death Note The Musical', null), 'musical');
  const entry = buildOffWestEndVenueShowEntry({ title: 'Some Show', venue: 'Park Theatre', category: 'off-west-end', source: 'venue-page:park-theatre', listingFirstDate: '2026-11-01', listingLastDate: '2026-12-01', listingGenre: 'Musicals' }, buildVenueVocabulary([]), { now: NOW });
  assert.equal(entry.type, 'musical');
});

test('parseSpektrixEvents carries the account genre labels', () => {
  const rows = parseSpektrixEvents([{ id: 'a', name: 'A', firstInstanceDateTime: '2026-10-01T19:30:00', lastInstanceDateTime: '2026-10-20T19:30:00', attribute_Genre: 'Musicals', attribute_Season: 'Autumn' }]);
  assert.equal(rows[0].genre, 'Musicals');
});

test('datedBackfillFor carries a type only when the venue genre label says what the show is', () => {
  const { datedBackfillFor } = require('../../scripts/promote-owe-venue-candidates.js');
  const base = { title: 'Cranford', venue: 'Orange Tree Theatre', category: 'off-west-end', source: 'venue-page:orange-tree-theatre', listingFirstDate: '2026-11-03', listingLastDate: '2027-01-16', listingPerformanceCount: 78 };
  const row = { id: 'cranford-off-west-end-2026', title: 'Cranford', status: 'announced' };
  assert.equal(datedBackfillFor({ ...base, listingGenre: 'Classical Play' }, row).type, 'play');
  assert.equal(datedBackfillFor({ ...base, listingGenre: 'Musicals' }, row).type, 'musical');
  assert.equal(datedBackfillFor(base, row).type, undefined, 'no label: no type');
  assert.equal(datedBackfillFor({ ...base, listingGenre: 'Classical Play' }, { ...row, type: 'musical' }).type, undefined, 'never overwrites');
});
