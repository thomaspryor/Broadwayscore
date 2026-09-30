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
    { event: { id: 'a' }, cancelled: false }, { event: { id: 'a' }, cancelled: false }, { event: { id: 'a' }, cancelled: true },
    { event: { id: 'b' }, cancelled: false }, { event: { id: 'c' }, cancelled: true },
  ];
  const rows = parseSpektrixEvents({ events, instances }, { exclude: { attribute_SupplementaryEvent: /^true$/i } });
  assert.deepEqual(rows.map(r => [r.title, r.performanceCount]), [['Run', 2]]);
  // Events alone: count unknown, nothing dropped for it.
  assert.deepEqual(parseSpektrixEvents(events).map(r => r.performanceCount), [null, null, null]);
});

test('cleanListingTitle strips London season tags', () => {
  assert.equal(cleanListingTitle('Cinderella (2026)'), 'Cinderella');
  assert.equal(cleanListingTitle('2026: The Master Builder'), 'The Master Builder');
  assert.equal(cleanListingTitle('Class of 2026'), 'Class of 2026');
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
    'Drag Tales': /only 3 performance/,                           // Park, a monthly drag brunch
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
