// BRO-4396: venue-page OB candidates can now be confirmed by a TheaterMania
// OB listing or by the venue's own dated listing, not only by Playbill/Lortel.
// These tests require the real functions (CLAUDE.md §15) and replay the
// OvationTix fixture captured live for SoHo Playhouse on 2026-09-29, plus the
// junk rows that sat in data/audit/ob-venue-candidates.json that day.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  isCandidateConfirmed,
  decideVenueListingPromotion,
  junkCandidateReason,
  findTheaterManiaCorroboration,
  venuesCompatible,
  discoveryGateReason,
} = require('./ob-cross-validation.js');
const { OB_VENUE_CONFIGS, parseVenueListingHtml } = require('./venue-listing-discover.js');
const {
  parseDateRangeText,
  parseTribeEvents,
  extractDatedJsonLdEvents,
  extractDatedCards,
  htmlToDocument,
  cleanListingTitle,
  isoDay,
} = require('./ob-listing-platforms.js');
const { statusFromDates, applyConfirmationDates, findExistingOB, buildShowEntry } = require('../promote-ob-venue-candidates.js');
const { isNonTheaterContent, isOneNightShow } = require('../discover-new-shows.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOHO_FIXTURE = join(__dirname, '..', '..', 'tests', 'fixtures', 'ob-discovery', 'soho-playhouse.json');
const TODAY = '2026-09-29';
const GATES = { isNonTheaterContent, isOneNightShow };

// ── junk filters ───────────────────────────────────────────────────────────

test('junkCandidateReason: rejects the non-production rows staged on 2026-09-29', () => {
  const junk = [
    'The Judith Champion Mixfest 2026', 'Freshplay Festival 2026', 'Miscast26',
    'Watch Me Walk @ Yale Rep', 'New Portfolio Item', 'The Crucible Boston',
    'Bedlam The Series', 'Solo: A Show About Friendship SPECIAL TAPING',
    'Room Full of Strangers with Chris Turner (Work in Progress)',
    'Max Davidson Does New Material', 'Great Times: Comedy for $15',
    'Spring Gala 2026', 'Annual Benefit Concert', 'Film Series: Noir Nights',
    'New Play Reading Series',
  ];
  for (const title of junk) {
    assert.ok(junkCandidateReason({ title }), `expected "${title}" to be junk`);
  }
});

test('junkCandidateReason: real productions pass, including near-miss words', () => {
  for (const title of [
    'Hamlet', 'Diana: The Untold and Untrue Story', 'Reading Lolita in Tehran',
    'The (Very Gay) Christmas Prince', 'Bigfoot Ripped My Dog In Half I Saw It',
    'Camp Siegfried', 'Othello',
  ]) {
    assert.equal(junkCandidateReason({ title }), null, `"${title}" should not be junk`);
  }
});

test('junkCandidateReason: a dated single night is a one-night event; two same-day shows are not', () => {
  assert.match(junkCandidateReason({ title: 'Tailored Comedy', listingFirstDate: TODAY, listingLastDate: TODAY, listingPerformanceCount: 1 }), /one-night/);
  assert.match(junkCandidateReason({ title: 'Something', listingFirstDate: TODAY, listingLastDate: TODAY }), /one-night/);
  assert.equal(junkCandidateReason({ title: 'Something', listingFirstDate: TODAY, listingLastDate: TODAY, listingPerformanceCount: 2 }), null);
});

test('isCandidateConfirmed: a junk title is never confirmed, even when a source lists it', () => {
  const r = isCandidateConfirmed(
    { title: 'Freshplay Festival 2026', venue: 'MCC Theater' },
    { playbillEntries: [{ title: 'Freshplay Festival 2026' }], lortelEntries: [] },
  );
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /festival/);
});

// ── TheaterMania corroboration ─────────────────────────────────────────────

const TM = [
  { title: 'Bigfoot Ripped My Dog In Half I Saw It', venue: 'SoHo Playhouse', previewsStartDate: '2026-11-20', openingDate: null, closingDate: '2027-01-03' },
  { title: 'Hamlet', venue: 'Classic Stage Company', previewsStartDate: '2026-10-01', openingDate: '2026-10-15', openingDateSource: 'theatermania', closingDate: '2026-12-01' },
  { title: 'Undated Thing', venue: 'SoHo Playhouse', previewsStartDate: null, openingDate: null, closingDate: null },
  { title: 'The Loved Ones Returning', venue: 'Irish Repertory Theatre', previewsStartDate: '2026-10-02', openingDate: '2026-10-12', openingDateSource: 'theatermania', closingDate: '2026-11-30' },
];

test('TheaterMania: a truncated slug title at the same venue confirms, renames and carries TM dates', () => {
  const r = isCandidateConfirmed({ title: 'Bigfoot Ripped', venue: 'Soho Playhouse' }, { playbillEntries: [], lortelEntries: [], theatermaniaEntries: TM });
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'theatermania');
  assert.equal(r.matchedTitle, 'Bigfoot Ripped My Dog In Half I Saw It');
  assert.equal(r.matchedDates.previewsStartDate, '2026-11-20');
  assert.equal(r.matchedDates.closingDate, '2027-01-03');
});

test('TheaterMania: the same title at a different venue does not confirm', () => {
  const r = isCandidateConfirmed({ title: 'Hamlet', venue: 'Bedlam' }, { theatermaniaEntries: TM });
  assert.equal(r.confirmed, false);
});

test('TheaterMania: an undated listing does not confirm', () => {
  assert.equal(findTheaterManiaCorroboration({ title: 'Undated Thing', venue: 'Soho Playhouse' }, TM), null);
});

test('TheaterMania: a one-token slug title needs an exact match (no subset rename)', () => {
  // "One" must not match a longer title just because it contains the word.
  const tm = [{ title: 'One Night in Miami', venue: 'SoHo Playhouse', previewsStartDate: '2026-10-01' }];
  assert.equal(findTheaterManiaCorroboration({ title: 'One', venue: 'Soho Playhouse' }, tm), null);
});

test('TheaterMania: a jaccard-only match corroborates but never renames', () => {
  const r = isCandidateConfirmed({ title: 'The Loved Ones Return', venue: 'Irish Rep' }, { theatermaniaEntries: TM });
  if (r.confirmed) {
    assert.equal(r.source, 'theatermania');
    assert.equal(r.matchedTitle, undefined, 'fuzzy match must not hand back a title');
  }
});

test('venuesCompatible: a room of the same house matches; different houses do not', () => {
  assert.equal(venuesCompatible('Soho Playhouse', 'Huron Club at the SoHo Playhouse'), true);
  assert.equal(venuesCompatible('Soho Playhouse', 'Soho Playhouse Main Stage'), true);
  assert.equal(venuesCompatible('Soho Playhouse', 'Soho Rep'), false);
  assert.equal(venuesCompatible('Bedlam', 'Classic Stage Company'), false);
  assert.equal(venuesCompatible('', 'Soho Playhouse'), false);
});

// ── the venue's own dated listing ──────────────────────────────────────────

function sohoCandidates() {
  const venue = OB_VENUE_CONFIGS.find(v => v.name === 'Soho Playhouse');
  return parseVenueListingHtml(venue, readFileSync(SOHO_FIXTURE, 'utf8'), { todayIso: TODAY });
}

test('decideVenueListingPromotion: SoHo Playhouse OvationTix fixture — runs confirm, one-offs and showcases do not', () => {
  const decided = new Map(sohoCandidates().map(c => [c.title, decideVenueListingPromotion(c, { todayIso: TODAY, gates: GATES })]));
  const confirmed = [...decided].filter(([, r]) => r.confirmed).map(([t]) => t).sort();
  // Every run of 3+ performances that is not a showcase/taping/WIP.
  for (const t of [
    'Bigfoot Ripped My Dog In Half I Saw It', 'Diana: The Untold and Untrue Story',
    'The (Very Gay) Christmas Prince', 'LOVE ME', 'KEVIN!!!!!', 'Fly, You Fools!',
    'Catholic Guilt', 'Lost in Del Valle', 'Jersey Boy',
  ]) {
    assert.ok(confirmed.includes(t), `expected "${t}" to confirm; confirmed: ${confirmed.join(' | ')}`);
  }
  for (const [t, why] of [
    ['Bride To Be', /only 2 performance/],
    ['Great Times: Comedy for $15', /showcase|one-night|performance/],
    ['Solo: A Show About Friendship SPECIAL TAPING', /taping/],
    ['Room Full of Strangers with Chris Turner (Work in Progress)', /work-in-progress|non-theatre|one-night/],
    ['Jaboukie Young-White', /one-night/],
    ['Judi Love - Live in New York', /performance|non-theatre/],
  ]) {
    const r = decided.get(t);
    assert.ok(r, `fixture should contain "${t}"`);
    assert.equal(r.confirmed, false, `"${t}" should not confirm`);
    assert.match(r.reason, why, `"${t}": ${r.reason}`);
  }
});

test('decideVenueListingPromotion: refuses undated, ended, far-future, unknown-venue and non-venue-page candidates', () => {
  const base = { title: 'A Real Play', venue: 'Soho Playhouse', source: 'venue-page:soho-playhouse', listingFirstDate: '2026-10-01', listingLastDate: '2026-10-20', listingPerformanceCount: 12 };
  assert.equal(decideVenueListingPromotion(base, { todayIso: TODAY }).confirmed, true);
  assert.match(decideVenueListingPromotion({ ...base, listingFirstDate: undefined }, { todayIso: TODAY }).reason, /no run dates/);
  assert.match(decideVenueListingPromotion({ ...base, listingFirstDate: '2026-08-01', listingLastDate: '2026-09-01' }, { todayIso: TODAY }).reason, /already ended/);
  assert.match(decideVenueListingPromotion({ ...base, listingFirstDate: '2028-01-01', listingLastDate: '2028-02-01' }, { todayIso: TODAY }).reason, /more than 365d/);
  assert.match(decideVenueListingPromotion({ ...base, venue: 'Somebody\'s Loft' }, { todayIso: TODAY }).reason, /not in canonical/);
  assert.match(decideVenueListingPromotion({ ...base, source: 'theatermania-ob' }, { todayIso: TODAY }).reason, /not a venue listing/);
  assert.match(decideVenueListingPromotion({ ...base, listingLastDate: '2026-09-30', listingFirstDate: '2026-10-05' }, { todayIso: TODAY }).reason, /out of order/);
});

test('decideVenueListingPromotion: a throwing discovery gate fails closed', () => {
  const c = { title: 'A Real Play', venue: 'Soho Playhouse', source: 'venue-page:soho-playhouse', listingFirstDate: '2026-10-01', listingLastDate: '2026-10-20', listingPerformanceCount: 12 };
  const r = decideVenueListingPromotion(c, { todayIso: TODAY, gates: { isNonTheaterContent: () => { throw new Error('boom'); } } });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /refusing/);
});

// ── promotion: dates, status, duplicate check ──────────────────────────────

test('statusFromDates mirrors discovery', () => {
  assert.equal(statusFromDates({ openingDate: null, previewsStartDate: null }, TODAY), 'announced');
  assert.equal(statusFromDates({ openingDate: null, previewsStartDate: '2026-10-01' }, TODAY), 'upcoming');
  assert.equal(statusFromDates({ openingDate: null, previewsStartDate: '2026-09-20' }, TODAY), 'previews');
  assert.equal(statusFromDates({ openingDate: '2026-09-25', previewsStartDate: '2026-09-10' }, TODAY), 'open');
  assert.equal(statusFromDates({ openingDate: '2026-10-25', previewsStartDate: '2026-09-10' }, TODAY), 'previews');
});

test('applyConfirmationDates: listing dates become previews/closing; TM dates win', () => {
  const c = { title: 'X', listingFirstDate: '2026-12-02', listingLastDate: '2026-12-13' };
  applyConfirmationDates(c, { source: 'venue-listing' });
  assert.equal(c.previewsStartDate, '2026-12-02');
  assert.equal(c.closingDate, '2026-12-13');
  assert.equal(c.openingDate, undefined);

  const t = { title: 'Y', listingFirstDate: '2026-10-01', listingLastDate: '2026-10-30' };
  applyConfirmationDates(t, { source: 'theatermania', matchedDates: { previewsStartDate: '2026-10-01', openingDate: '2026-10-10', openingDateSource: 'theatermania', closingDate: null } });
  assert.equal(t.openingDate, '2026-10-10');
  assert.equal(t.openingDateSource, 'theatermania');
  assert.equal(t.closingDate, '2026-10-30', 'falls back to the listing\'s last date');

  const entry = buildShowEntry({ ...c, venue: 'Soho Playhouse', category: 'off-broadway', source: 'venue-page:soho-playhouse', slug: 'x' });
  assert.equal(entry.previewsStartDate, '2026-12-02');
  assert.equal(entry.closingDate, '2026-12-13');
  assert.equal(entry.status, statusFromDates({ openingDate: null, previewsStartDate: '2026-12-02' }));
});

test('findExistingOB: a room suffix or a performer prefix still finds the catalogued show', () => {
  const pool = [
    { id: 'jest-to-impress-off-broadway-2026', title: 'Jest to Impress', venue: 'Soho Playhouse Main Stage' },
    { id: 'diana-the-untold-and-untrue-story-off-broadway-2026', title: 'Diana: The Untold and Untrue Story', venue: 'SoHo Playhouse' },
    { id: 'hamlet-csc', title: 'Hamlet', venue: 'Classic Stage Company' },
  ];
  assert.equal(findExistingOB({ title: 'Mark Simmons: Jest to Impress', venue: 'Soho Playhouse' }, pool)?.match.id, 'jest-to-impress-off-broadway-2026');
  assert.equal(findExistingOB({ title: 'Diana: The Untold and Untrue Story', venue: 'Soho Playhouse' }, pool)?.match.id, 'diana-the-untold-and-untrue-story-off-broadway-2026');
  assert.equal(findExistingOB({ title: 'Hamlet', venue: 'Bedlam' }, pool), null, 'different house is a different production');
});

// ── dated platform parsers ─────────────────────────────────────────────────

test('parseDateRangeText: common listing formats', () => {
  const cases = [
    ['Oct 3 – Nov 16, 2026', '2026-10-03', '2026-11-16'],
    ['October 3, 2026 - January 4, 2027', '2026-10-03', '2027-01-04'],
    ['Sep 30 - Oct 5', '2026-09-30', '2026-10-05'],
    ['Nov 20–23', '2026-11-20', '2026-11-23'],
    ['Dec 28 - Jan 4', '2026-12-28', '2027-01-04'],
    ['10/3/26 - 11/16/26', '2026-10-03', '2026-11-16'],
    ['Through Nov 16', null, '2026-11-16'],
    ['Now playing', null, null],
  ];
  for (const [text, first, last] of cases) {
    assert.deepEqual(parseDateRangeText(text, { todayIso: TODAY }), { firstDate: first, lastDate: last }, text);
  }
});

test('parseTribeEvents merges performances of one title', () => {
  const rows = parseTribeEvents({ events: [
    { title: 'Play &#8211; One', start_date: '2026-10-01 19:00:00', end_date: '2026-10-01 21:00:00', url: 'u1' },
    { title: 'Play &#8211; One', start_date: '2026-10-05 19:00:00', end_date: '2026-10-05 21:00:00', url: 'u2' },
    { title: 'Other', start_date: '2026-11-01 19:00:00', end_date: '2026-11-01 21:00:00' },
  ] });
  assert.equal(rows.length, 2);
  const one = rows.find(r => r.title.startsWith('Play'));
  assert.equal(one.firstDate, '2026-10-01');
  assert.equal(one.lastDate, '2026-10-05');
  assert.equal(one.performanceCount, 2);
});

test('extractDatedJsonLdEvents: @graph, ItemList and subEvent shapes', () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"TheaterEvent","name":"Graph Show","startDate":"2026-10-01T19:00","endDate":"2026-10-20"}]}</script>
    <script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"Event","name":"Listed Show","startDate":"2026-11-01"}}]}</script>
    <script type="application/ld+json">{"@type":"TheaterEvent","name":"Run Show","subEvent":[{"startDate":"2026-12-01"},{"startDate":"2026-12-09"}]}</script>
    <script type="application/ld+json">{not json</script>
  </head><body></body></html>`;
  const rows = extractDatedJsonLdEvents(htmlToDocument(html));
  const by = Object.fromEntries(rows.map(r => [r.title, r]));
  assert.deepEqual([by['Graph Show'].firstDate, by['Graph Show'].lastDate], ['2026-10-01', '2026-10-20']);
  assert.equal(by['Listed Show'].firstDate, '2026-11-01');
  assert.deepEqual([by['Run Show'].firstDate, by['Run Show'].lastDate, by['Run Show'].performanceCount], ['2026-12-01', '2026-12-09', 2]);
});

test('extractDatedCards reads title + date text per card', () => {
  const html = `<div class="show"><h3>First Play</h3><p class="d">Oct 3 – Nov 16, 2026</p><a href="/shows/first">x</a></div>
                <div class="show"><h3>THE SECOND PLAY</h3><p class="d">Dec 1–14</p></div>`;
  const rows = extractDatedCards(htmlToDocument(html), { name: 'T', itemSelector: '.show', titleSelector: 'h3', dateSelector: '.d' }, { todayIso: TODAY });
  assert.deepEqual(rows.map(r => [r.title, r.firstDate, r.lastDate]), [
    ['First Play', '2026-10-03', '2026-11-16'],
    ['The Second Play', '2026-12-01', '2026-12-14'],
  ]);
  assert.equal(rows[0].url, '/shows/first');
});

test('cleanListingTitle: entities, curly quotes, shouting (3+ words; shorter titles are exempt like validate-data)', () => {
  assert.equal(cleanListingTitle('  SOMETHING VERY SPOOKY '), 'Something Very Spooky');
  assert.equal(cleanListingTitle('LOVE ME'), 'LOVE ME');
  assert.equal(cleanListingTitle('Rosie O&#8217;Donnell'), "Rosie O'Donnell");
});

// ── ship-check findings (2026-09-29) ───────────────────────────────────────

test('weekend bookings are not runs: SoHo 4-show improv and kids weekends stay out', () => {
  const decided = new Map(sohoCandidates().map(c => [c.title, decideVenueListingPromotion(c, { todayIso: TODAY, gates: GATES })]));
  for (const t of ['TJ & Dave', 'Doktor Kaboom: Man of Science!']) {
    assert.equal(decided.get(t).confirmed, false, t);
    assert.match(decided.get(t).reason, /short booking/);
  }
  // Uncounted listings need a 3-day span.
  const base = { title: 'Visiting Play', venue: 'Soho Playhouse', source: 'venue-page:soho-playhouse' };
  assert.equal(decideVenueListingPromotion({ ...base, listingFirstDate: '2026-10-08', listingLastDate: '2026-10-09' }, { todayIso: TODAY }).confirmed, false);
  assert.equal(decideVenueListingPromotion({ ...base, listingFirstDate: '2026-10-08', listingLastDate: '2026-10-10' }, { todayIso: TODAY }).confirmed, true);
});

test('OvationTix first date is the next on-sale performance: a mid-run show is running, not upcoming', () => {
  const soho = sohoCandidates();
  assert.ok(soho.every(c => c.listingFirstDateIsNext === true), 'OvationTix rows are flagged');
  const c = { title: 'Mid Run', listingFirstDate: '2026-09-30', listingLastDate: '2026-10-18', listingFirstDateIsNext: true };
  applyConfirmationDates(c, { source: 'venue-listing' }, TODAY);
  assert.equal(c.previewsStartDate, null);
  assert.equal(c.runningNow, true);
  assert.equal(statusFromDates({ openingDate: null, previewsStartDate: null, runningNow: true }, TODAY), 'previews');
  const later = { title: 'Later', listingFirstDate: '2026-12-02', listingLastDate: '2026-12-13', listingFirstDateIsNext: true };
  applyConfirmationDates(later, { source: 'venue-listing' }, TODAY);
  assert.equal(later.previewsStartDate, '2026-12-02', 'a first date well ahead is kept');
});

test('buildShowEntry: id year follows the run, not the calendar', () => {
  const e = buildShowEntry({ title: 'Winter Thing', slug: 'winter-thing', venue: 'Soho Playhouse', category: 'off-broadway', source: 'venue-page:soho-playhouse', previewsStartDate: '2027-01-16' });
  assert.equal(e.id, 'winter-thing-off-broadway-2027');
});

test('venuesCompatible matches whole words only', () => {
  assert.equal(venuesCompatible('Art House', 'Martin Art House Stage'), true);
  assert.equal(venuesCompatible('Art House', 'Smart Housekeeping Hall'), false);
});

test('parseDateRangeText: times, month-year and year-less numeric dates', () => {
  assert.deepEqual(parseDateRangeText('Oct 3 – 7:30pm', { todayIso: TODAY }), { firstDate: '2026-10-03', lastDate: '2026-10-03' });
  assert.deepEqual(parseDateRangeText('March 2027', { todayIso: TODAY }), { firstDate: null, lastDate: null });
  assert.deepEqual(parseDateRangeText('10/3 - 11/16', { todayIso: TODAY }), { firstDate: '2026-10-03', lastDate: '2026-11-16' });
  assert.deepEqual(parseDateRangeText('Starts Sep 9, 2026', { todayIso: TODAY }), { firstDate: '2026-09-09', lastDate: null });
});

test('isoDay converts zoned timestamps to the New York date', () => {
  assert.equal(isoDay('2026-10-08T00:30:00Z'), '2026-10-07');
  assert.equal(isoDay('2026-10-15T19:30:00'), '2026-10-15');
  assert.equal(isoDay('2026-10-15 19:30'), '2026-10-15');
});

test('discoveryGateReason applies discovery gates (used on the TheaterMania route too)', () => {
  assert.match(discoveryGateReason({ title: 'Big Screening Night', venue: 'Soho Playhouse' }, GATES) || '', /non-theatre/);
  assert.equal(discoveryGateReason({ title: 'Hamlet', venue: 'Soho Playhouse', previewsStartDate: '2026-10-01', closingDate: '2026-11-01' }, GATES), null);
});

test('settledWithConcurrency: order kept, limit respected, rejections captured', async () => {
  const { settledWithConcurrency } = require('./venue-listing-discover.js');
  let inFlight = 0; let peak = 0;
  const res = await settledWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5 * (7 - n)));
    inFlight--;
    if (n === 4) throw new Error('boom');
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(res.map(r => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.deepEqual(res.filter(r => r.value).map(r => r.value), [10, 20, 30, 50, 60]);
});

test('settledWithConcurrency: a lane runs its items one at a time', async () => {
  const { settledWithConcurrency } = require('./venue-listing-discover.js');
  let laneInFlight = 0; let lanePeak = 0;
  const items = ['ovt', 'x', 'ovt', 'y', 'ovt'];
  const res = await settledWithConcurrency(items, 4, async (k) => {
    if (k === 'ovt') { laneInFlight++; lanePeak = Math.max(lanePeak, laneInFlight); }
    await new Promise(r => setTimeout(r, 5));
    if (k === 'ovt') laneInFlight--;
    return k;
  }, { laneOf: k => (k === 'ovt' ? 'ovt' : null) });
  assert.equal(lanePeak, 1);
  assert.deepEqual(res.map(r => r.value), items);
});

test('cleanListingTitle drops a trailing season year, keeps year titles', () => {
  assert.equal(cleanListingTitle('A Christmas Carol the Musical 2026'), 'A Christmas Carol the Musical');
  assert.equal(cleanListingTitle('1776'), '1776');
  assert.equal(cleanListingTitle('2:22 - A Ghost Story'), '2:22 - A Ghost Story');
});

test('findExistingOB: same-title fallbacks never swallow transfers, revivals or undated rows', () => {
  const pool = [
    { id: 'kramer-fauci-skirball', title: 'Kramer/Fauci', venue: 'NYU Skirball', category: 'off-broadway', date: '2026-03-01' },
    { id: 'charlie-brown-cc', title: "You're a Good Man, Charlie Brown", venue: 'New York City Center', category: 'off-broadway', date: null },
    { id: 'grief-eater', title: 'The Grief Eater Near North Bender', venue: 'The Laura Pels Theatre at the Harold and Miriam Steinberg Center for Theatre', category: 'off-broadway', date: '2027-01-21' },
    { id: 'violets', title: "Violet's Magic Glasses", venue: '92NY Buttenwieser Hall', category: 'off-broadway', date: '2026-11-01' },
    { id: 'pita', title: 'Other Show Entirely', venue: 'DR2 Theatre', category: 'off-broadway', date: '2026-01-01' },
  ];
  const vp = { category: 'off-broadway', source: 'venue-page:x' };
  assert.equal(findExistingOB({ ...vp, title: 'Kramer Fauci', venue: "St. Ann's Warehouse", listingFirstDate: '2026-10-01' }, pool), null, 'transfer months later is a new row');
  assert.equal(findExistingOB({ ...vp, title: "You're a Good Man, Charlie Brown", venue: 'Somewhere Else', listingFirstDate: '2031-02-01' }, pool), null, 'undated catalog row never blocks');
  assert.equal(findExistingOB({ ...vp, title: 'The Grief Eater Near North Bender', venue: 'New York Theatre Workshop', listingFirstDate: '2027-01-21' }, pool)?.match.id, 'grief-eater', 'co-production listed by two venues');
  assert.equal(findExistingOB({ ...vp, title: "Violet's Magic Glasses", venue: '92NY', listingFirstDate: '2026-11-01' }, pool)?.match.id, 'violets', 'house vs room');
  assert.equal(findExistingOB({ ...vp, title: 'Other Show', venue: 'Daryl Roth Theatre', listingFirstDate: '2026-11-01' }, pool), null, 'no fuzzy match across rooms');
  assert.equal(findExistingOB({ category: 'regional', source: 'bww-roundup', title: 'The Grief Eater Near North Bender', venue: 'Huntington', listingFirstDate: '2027-01-21' }, pool), null, 'regional candidates skip the fallback');
});

test('cleanListingTitle keeps a year that is part of the name', () => {
  assert.equal(cleanListingTitle('Class of 2026'), 'Class of 2026');
});
