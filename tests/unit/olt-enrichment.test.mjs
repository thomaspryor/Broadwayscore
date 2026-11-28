// scripts/lib/olt-enrichment.js — Official London Theatre readers + the
// closingDate / ageRecommendation backfill decision (2026 data audit, S7-T10).
//
// The fixtures mirror the live pages as verified 2026-09-28: the listing's
// TheaterEvent blocks carry `location.name` = the venue's OLT URL and
// `location.title` = the human name, entity-encoded titles, and
// datetime-shaped start/end dates; the show page carries a FAQPage answer
// "… is recommended for ages 8+ | …" and an "Age & Content" block.
// Everything here require()s the real exports (CLAUDE.md §15).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  OLT_SOURCE,
  OLT_LIVENESS,
  MAX_LIMITED_RUN_DAYS,
  extractJsonLdBlocks,
  decodeOltText,
  isoDay,
  oltVenueName,
  parseOltTheaterEvents,
  normalizeAgeGuidance,
  parseOltAgeGuidance,
  venuesAgree,
  isOltEnrichable,
  planOltEnrichment,
} = require('../../scripts/lib/olt-enrichment.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const event = (over = {}) => ({
  '@context': 'https://schema.org',
  '@type': 'TheaterEvent',
  name: 'The Gruffalo',
  url: 'https://officiallondontheatre.com/show/the-gruffalo-111467223/',
  description: 'Tall Stories’ much-loved adaptation.',
  startDate: '2026-07-17T19:37:46+00:00',
  endDate: '2026-09-08T19:37:46+00:00',
  location: { title: 'Lyric Theatre', name: 'https://officiallondontheatre.com/venue/lyric-theatre/' },
  ...over,
});

// ---------------------------------------------------------------------------
// Listing readers
// ---------------------------------------------------------------------------

test('parseOltTheaterEvents — reads every standalone TheaterEvent, venue from location.title, dates raw', () => {
  const html = `<html><head>
    ${ld({ '@type': 'BreadcrumbList' })}
    ${ld(event())}
    ${ld(event({ name: 'Angel&#8217;s Bone', url: null, endDate: 'null', location: { title: 'London Coliseum', name: 'https://officiallondontheatre.com/venue/london-coliseum/' } }))}
    <script type="application/ld+json">{not json</script>
  </head></html>`;
  assert.equal(extractJsonLdBlocks(html).length, 4);
  const events = parseOltTheaterEvents(html);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    title: 'The Gruffalo',
    venue: 'Lyric Theatre',
    url: 'https://officiallondontheatre.com/show/the-gruffalo-111467223/',
    startDate: '2026-07-17T19:37:46+00:00',
    endDate: '2026-09-08T19:37:46+00:00',
    description: 'Tall Stories’ much-loved adaptation.',
  });
  assert.equal(events[1].title, "Angel's Bone", 'entity-encoded title decoded');
  assert.equal(events[1].endDate, null, "'null' endDate normalised to null");
  assert.equal(events[1].url, null);
});

test('parseOltTheaterEvents — skips season containers (subEvent), untitled nodes, and non-TheaterEvent nodes', () => {
  const html = ld(event({ subEvent: [{ '@type': 'TheaterEvent' }] })) + ld(event({ name: '' })) + ld({ '@type': 'Event', name: 'Not theatre' });
  assert.deepEqual(parseOltTheaterEvents(html), []);
});

test('parseOltTheaterEvents — handles a @graph wrapper and an array @type (via scripts/lib/jsonld.js)', () => {
  const html = ld({ '@context': 'https://schema.org', '@graph': [event({ '@type': ['Event', 'TheaterEvent'] })] });
  const events = parseOltTheaterEvents(html);
  assert.equal(events.length, 1);
  assert.equal(events[0].venue, 'Lyric Theatre');
});

test('parseOltTheaterEvents — tolerates non-string input', () => {
  assert.deepEqual(parseOltTheaterEvents(null), []);
  assert.deepEqual(parseOltTheaterEvents(undefined), []);
});

test('oltVenueName — prefers the human title over a URL-shaped name, falls back sanely', () => {
  assert.equal(oltVenueName({ title: 'Lyric Theatre', name: 'https://officiallondontheatre.com/venue/lyric-theatre/' }), 'Lyric Theatre');
  assert.equal(oltVenueName({ name: 'Lyric Theatre' }), 'Lyric Theatre');
  assert.equal(oltVenueName({ name: 'https://officiallondontheatre.com/venue/lyric-theatre/' }), null, 'a URL is never a venue');
  assert.equal(oltVenueName('Noël Coward Theatre'), 'Noël Coward Theatre');
  assert.equal(oltVenueName({ title: 'Haymarket, Theatre Royal &#038; Co', name: null }), 'Haymarket, Theatre Royal & Co');
  assert.equal(oltVenueName(null), null);
  assert.equal(oltVenueName({}), null);
});

test('decodeOltText / isoDay', () => {
  assert.equal(decodeOltText('Franz &#038; Marie'), 'Franz & Marie');
  assert.equal(decodeOltText('&#8220;Hamlet&#8221; &#8211; a play'), '"Hamlet" – a play');
  assert.equal(decodeOltText('Caf&#233;'), 'Café');
  assert.equal(isoDay('2026-09-08T19:37:46+00:00'), '2026-09-08');
  assert.equal(isoDay('2026-09-08'), '2026-09-08');
  assert.equal(isoDay('null'), null);
  assert.equal(isoDay(null), null);
  assert.equal(isoDay('8 Sep 2026'), null);
});

// ---------------------------------------------------------------------------
// Age guidance
// ---------------------------------------------------------------------------

test('normalizeAgeGuidance — corpus format "Ages N+", "All ages", null otherwise', () => {
  assert.equal(normalizeAgeGuidance('Million Dollar Quartet is recommended for ages 8+ | No under 16’s are admitted'), 'Ages 8+');
  assert.equal(normalizeAgeGuidance('8+'), 'Ages 8+');
  assert.equal(normalizeAgeGuidance('Ages 12+'), 'Ages 12+');
  assert.equal(normalizeAgeGuidance('16 and over'), 'Ages 16+');
  assert.equal(normalizeAgeGuidance('Suitable for all ages'), 'All ages');
  assert.equal(normalizeAgeGuidance('No under 16s admitted'), null, 'an admission rule is not an age recommendation');
  assert.equal(normalizeAgeGuidance('99+'), null, 'out of range');
  assert.equal(normalizeAgeGuidance(''), null);
  assert.equal(normalizeAgeGuidance(null), null);
});

test('parseOltAgeGuidance — FAQPage JSON-LD answer first', () => {
  const html = ld({
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: 'How long is Million Dollar Quartet?', acceptedAnswer: { '@type': 'Answer', text: '2 hours and 5 minutes' } },
      { '@type': 'Question', name: 'What age is Million Dollar Quartet suitable for?', acceptedAnswer: { '@type': 'Answer', text: 'Million Dollar Quartet is recommended for ages 8+ | No under 16’s are admitted without a responsible adult.' } },
    ],
  }) + '<div>Age &amp; Content</div><p>3+</p>';
  assert.equal(parseOltAgeGuidance(html), 'Ages 8+', 'the FAQ answer wins over the HTML block');
});

test('parseOltAgeGuidance — falls back to the "Age & Content" HTML block', () => {
  const html = '<h3 class="x">Age &amp; Content</h3><p class="y">3+</p><p>Children aged 14 and below must be accompanied</p>';
  assert.equal(parseOltAgeGuidance(html), 'Ages 3+');
  assert.equal(parseOltAgeGuidance('<h3>Age & Content</h3><p>All ages</p>'), 'All ages');
});

test('parseOltAgeGuidance — null when the page carries no guidance', () => {
  assert.equal(parseOltAgeGuidance('<html><body>This show has now closed.</body></html>'), null);
  assert.equal(parseOltAgeGuidance(''), null);
  assert.equal(parseOltAgeGuidance(null), null);
});

// ---------------------------------------------------------------------------
// Venue agreement (secondary guard behind the title match)
// ---------------------------------------------------------------------------

test('venuesAgree — tolerant of word order, "Theatre" suffixes, diacritics, entities', () => {
  assert.equal(venuesAgree('Theatre Royal Haymarket', 'Haymarket, Theatre Royal'), true);
  assert.equal(venuesAgree('Marble Arch Theatre', 'The Arts at Marble Arch'), true);
  assert.equal(venuesAgree('Noel Coward Theatre', 'Noël Coward Theatre'), true);
  assert.equal(venuesAgree("Shakespeare's Globe", 'Shakespeare&#8217;s Globe'), true);
  assert.equal(venuesAgree('Coliseum', 'London Coliseum'), true);
});

test('venuesAgree — different houses disagree; a missing or generic-only venue cannot disagree', () => {
  assert.equal(venuesAgree('Harold Pinter Theatre', "Wyndham's Theatre"), false);
  assert.equal(venuesAgree('Riverside Studios', 'Harold Pinter Theatre'), false);
  assert.equal(venuesAgree(null, 'Harold Pinter Theatre'), true);
  assert.equal(venuesAgree('Harold Pinter Theatre', ''), true);
  assert.equal(venuesAgree('The Theatre', 'Harold Pinter Theatre'), true, 'nothing distinctive to compare');
});

// ---------------------------------------------------------------------------
// Row admission
// ---------------------------------------------------------------------------

test('isOltEnrichable — WE/OWE rows that are live, announced, or closed within 90 days', () => {
  const today = '2026-09-28';
  assert.deepEqual(OLT_LIVENESS, { liveStatuses: ['open', 'previews', 'upcoming', 'announced'], allowClosed: true, withinDays: 90 });
  assert.equal(isOltEnrichable({ category: 'west-end', status: 'open' }, { today }), true);
  assert.equal(isOltEnrichable({ category: 'off-west-end', status: 'announced' }, { today }), true);
  assert.equal(isOltEnrichable({ category: 'west-end', status: 'closed', closingDate: '2026-09-08' }, { today }), true, 'Gruffalo: closed 20 days ago');
  assert.equal(isOltEnrichable({ category: 'west-end', status: 'closed', closingDate: '2026-05-01' }, { today }), false, 'closed 150 days ago');
  assert.equal(isOltEnrichable({ category: 'west-end', status: 'closed' }, { today }), false, 'closed, no closingDate');
  assert.equal(isOltEnrichable({ category: 'broadway', status: 'open' }, { today }), false, 'not a London row');
  assert.equal(isOltEnrichable({ category: 'west-end', status: 'cancelled' }, { today }), false);
  assert.equal(isOltEnrichable(null), false);
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const gruffaloRow = (over = {}) => ({
  id: 'the-gruffalo-west-end-2026',
  title: 'The Gruffalo',
  category: 'west-end',
  status: 'open',
  previewsStartDate: '2026-07-17',
  openingDate: '2026-07-19',
  closingDate: null,
  ageRecommendation: null,
  ...over,
});
const gruffaloEntry = (over = {}) => ({
  title: 'The Gruffalo',
  venue: 'Lyric Theatre',
  url: 'https://officiallondontheatre.com/show/the-gruffalo-111467223/',
  startDate: '2026-07-17T19:37:46+00:00',
  endDate: '2026-09-08T19:37:46+00:00',
  description: '',
  ageRecommendation: 'Ages 3+',
  ...over,
});

test('planOltEnrichment — null closingDate → fill from OLT endDate, source olt', () => {
  const { changes, skips } = planOltEnrichment(gruffaloRow(), gruffaloEntry({ ageRecommendation: null }));
  assert.deepEqual(changes, [{ field: 'closingDate', old: null, new: '2026-09-08', source: OLT_SOURCE }]);
  assert.deepEqual(skips, [{ field: 'ageRecommendation', reason: 'no-olt-age' }]);
});

test('planOltEnrichment — humanCorrectedClosingDate: true → closingDate never touched, even when null', () => {
  const { changes, skips } = planOltEnrichment(gruffaloRow({ humanCorrectedClosingDate: true }), gruffaloEntry({ ageRecommendation: null }));
  assert.deepEqual(changes, []);
  assert.ok(skips.some(s => s.field === 'closingDate' && s.reason === 'human-corrected'), JSON.stringify(skips));
});

test('planOltEnrichment — existing closingDate → skip (never overwritten, even when OLT disagrees)', () => {
  const { changes, skips } = planOltEnrichment(gruffaloRow({ closingDate: '2026-09-06' }), gruffaloEntry({ ageRecommendation: null }));
  assert.deepEqual(changes, []);
  assert.ok(skips.some(s => s.field === 'closingDate' && s.reason === 'already-set'), JSON.stringify(skips));
});

test('planOltEnrichment — OLT endDate before the row\'s own start → skip (bad data)', () => {
  const { changes, skips } = planOltEnrichment(gruffaloRow(), gruffaloEntry({ endDate: '2026-07-01T00:00:00+00:00', ageRecommendation: null }));
  assert.deepEqual(changes, []);
  assert.ok(skips.some(s => s.field === 'closingDate' && /end-before-start/.test(s.reason)), JSON.stringify(skips));
});

test('planOltEnrichment — an open-ended run (OLT run span > MAX_LIMITED_RUN_DAYS) → closingDate skipped: the endDate is a booking tranche', () => {
  assert.equal(MAX_LIMITED_RUN_DAYS, 270);
  // Hamilton as the live listing showed it 2026-09-28: opened 2017, booking to 2027-10-02.
  const hamilton = gruffaloRow({ id: 'hamilton-west-end', title: 'Hamilton', previewsStartDate: '2017-12-06', openingDate: '2017-12-21' });
  const entry = gruffaloEntry({ title: 'Hamilton', startDate: '2017-12-06T00:00:00+00:00', endDate: '2027-10-02T00:00:00+00:00', ageRecommendation: null });
  const { changes, skips } = planOltEnrichment(hamilton, entry);
  assert.deepEqual(changes, []);
  assert.ok(skips.some(s => s.field === 'closingDate' && /open-ended-run/.test(s.reason)), JSON.stringify(skips));
  // A run start missing on the entry falls back to the row's own start.
  const noStart = planOltEnrichment(hamilton, gruffaloEntry({ startDate: null, endDate: '2027-10-02T00:00:00+00:00', ageRecommendation: null }));
  assert.ok(noStart.skips.some(s => /open-ended-run/.test(s.reason)));
  // Exactly the threshold is still a limited run; one day over is not.
  const at = planOltEnrichment(gruffaloRow({ previewsStartDate: '2026-01-01', openingDate: '2026-01-03' }), gruffaloEntry({ startDate: '2026-01-01', endDate: '2026-09-28', ageRecommendation: null }));
  assert.equal(at.changes.length, 1, '270 days');
  const over = planOltEnrichment(gruffaloRow({ previewsStartDate: '2026-01-01', openingDate: '2026-01-03' }), gruffaloEntry({ startDate: '2026-01-01', endDate: '2026-09-29', ageRecommendation: null }));
  assert.equal(over.changes.length, 0, '271 days');
  // A limited run with no start anywhere cannot be measured: filled (status quo behaviour).
  const unmeasurable = planOltEnrichment(gruffaloRow({ id: 'x', previewsStartDate: null, openingDate: null }), gruffaloEntry({ startDate: null, ageRecommendation: null }));
  assert.equal(unmeasurable.changes.length, 1);
});

test('planOltEnrichment — entry without an endDate → closingDate skipped, age still considered', () => {
  const { changes, skips } = planOltEnrichment(gruffaloRow(), gruffaloEntry({ endDate: null }));
  assert.deepEqual(changes, [{ field: 'ageRecommendation', old: null, new: 'Ages 3+', source: OLT_SOURCE }]);
  assert.ok(skips.some(s => s.field === 'closingDate' && s.reason === 'no-olt-end-date'));
});

test('planOltEnrichment — null / empty ageRecommendation → fill; existing → skip', () => {
  assert.deepEqual(planOltEnrichment(gruffaloRow({ closingDate: '2026-09-08' }), gruffaloEntry()).changes,
    [{ field: 'ageRecommendation', old: null, new: 'Ages 3+', source: OLT_SOURCE }]);
  assert.deepEqual(planOltEnrichment(gruffaloRow({ closingDate: '2026-09-08', ageRecommendation: '' }), gruffaloEntry()).changes,
    [{ field: 'ageRecommendation', old: '', new: 'Ages 3+', source: OLT_SOURCE }]);
  const kept = planOltEnrichment(gruffaloRow({ closingDate: '2026-09-08', ageRecommendation: 'Ages 5+' }), gruffaloEntry());
  assert.deepEqual(kept.changes, []);
  assert.ok(kept.skips.some(s => s.field === 'ageRecommendation' && s.reason === 'already-set'));
  // Raw guidance on the entry is normalised on the way in; "All ages" survives.
  assert.equal(planOltEnrichment(gruffaloRow({ closingDate: 'x' }), gruffaloEntry({ ageRecommendation: 'recommended for ages 12+' })).changes[0].new, 'Ages 12+');
  assert.equal(planOltEnrichment(gruffaloRow({ closingDate: 'x' }), gruffaloEntry({ ageRecommendation: 'All ages' })).changes[0].new, 'All ages');
});

test('planOltEnrichment — both fields fill together on a row missing both', () => {
  const { changes } = planOltEnrichment(gruffaloRow(), gruffaloEntry());
  assert.deepEqual(changes.map(c => c.field), ['closingDate', 'ageRecommendation']);
});

test('planOltEnrichment — an OLT run starting >1 year from the row\'s own year is another production: nothing is filled', () => {
  const oldRow = gruffaloRow({ id: 'the-gruffalo-west-end-2023', previewsStartDate: '2023-07-17', openingDate: '2023-07-19', status: 'open' });
  const { changes, skips } = planOltEnrichment(oldRow, gruffaloEntry());
  assert.deepEqual(changes, []);
  assert.equal(skips.length, 1);
  assert.match(skips[0].reason, /production-year-mismatch/);
  // ±1 year is tolerated (December opening carrying next year's id, etc.).
  const adjacent = gruffaloRow({ id: 'the-gruffalo-west-end-2025', previewsStartDate: '2025-12-20', openingDate: '2025-12-22' });
  assert.equal(planOltEnrichment(adjacent, gruffaloEntry()).changes.length, 2);
  // A row with no year at all (no dates, no id year) is not blocked by the guard.
  const yearless = gruffaloRow({ id: 'the-gruffalo', previewsStartDate: null, openingDate: null });
  assert.equal(planOltEnrichment(yearless, gruffaloEntry()).changes.length, 2);
  // An entry with no startDate carries no production year: the endDate (a
  // booking tranche on a long-runner) must never stand in for it.
  const hamilton = gruffaloRow({ id: 'hamilton-west-end', openingDate: '2017-12-21', previewsStartDate: '2017-12-06', closingDate: '2027-10-02' });
  const noStart = planOltEnrichment(hamilton, gruffaloEntry({ startDate: null, endDate: '2027-10-02T00:00:00+00:00' }));
  assert.ok(!noStart.skips.some(s => /production-year-mismatch/.test(s.reason)), JSON.stringify(noStart.skips));
  assert.equal(noStart.changes.length, 1, 'age still fills');
});

test('planOltEnrichment — the matched row playing at a different house is another production: nothing is filled', () => {
  // Two 2026 Cherry Orchards: the title match picked the Riverside Studios row
  // for the Harold Pinter listing.
  const riverside = gruffaloRow({ id: 'the-cherry-orchard-riverside-studios-off-west-end-2026', title: 'The Cherry Orchard', venue: 'Riverside Studios', category: 'off-west-end' });
  const entry = gruffaloEntry({ title: 'The Cherry Orchard', venue: 'Harold Pinter Theatre', startDate: '2026-10-03T00:00:00+00:00', endDate: '2027-01-09T00:00:00+00:00' });
  const { changes, skips } = planOltEnrichment(riverside, entry);
  assert.deepEqual(changes, []);
  assert.equal(skips.length, 1);
  assert.match(skips[0].reason, /venue-mismatch/);
  // The right row fills.
  const pinter = gruffaloRow({ ...riverside, id: 'the-cherry-orchard-west-end-2026', venue: 'Harold Pinter Theatre', category: 'west-end' });
  assert.equal(planOltEnrichment(pinter, entry).changes.length, 2);
  // A row with no venue recorded is not blocked.
  assert.equal(planOltEnrichment(gruffaloRow({ venue: null }), gruffaloEntry()).changes.length, 2);
});

test('planOltEnrichment — missing inputs never throw', () => {
  assert.deepEqual(planOltEnrichment(null, gruffaloEntry()).changes, []);
  assert.deepEqual(planOltEnrichment(gruffaloRow(), null).changes, []);
});

// ---------------------------------------------------------------------------
// Wiring: the script and discovery use the shared module, and closingDate
// writes go through the guard.
// ---------------------------------------------------------------------------

test('enrich-west-end-dates.js plans via olt-enrichment and writes closingDate through closing-date-guard + shows-write-guard', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/enrich-west-end-dates.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/olt-enrichment['"]\)/);
  assert.match(src, /\bplanOltEnrichment\(/);
  assert.match(src, /\bisOltEnrichable\(/);
  assert.match(src, /require\(['"]\.\/lib\/closing-date-guard['"]\)/);
  assert.match(src, /\bwriteClosingDate\(showRecord, ch\.new/);
  assert.match(src, /require\(['"]\.\/lib\/shows-write-guard['"]\)/);
  assert.doesNotMatch(src, /showRecord\.closingDate\s*=/, 'closingDate must never be assigned directly');
});

test('discover-new-shows.js reads the OLT listing through the shared parser (no inline location.name reader)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/discover-new-shows.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/olt-enrichment['"]\)/);
  const start = src.indexOf('async function fetchShowsFromOfficialLondonTheatre');
  assert.ok(start !== -1, 'fetchShowsFromOfficialLondonTheatre not found');
  const nextFn = src.indexOf('\nasync function ', start + 1);
  // Code only: the intake's comments legitimately describe the old reader.
  const body = src.slice(start, nextFn === -1 ? undefined : nextFn)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  assert.match(body, /\bparseOltTheaterEvents\(html\)/);
  assert.doesNotMatch(body, /data\.location/, 'the URL-as-venue reader is gone from the OLT intake');
  assert.doesNotMatch(body, /new JSDOM\(/, 'the OLT intake no longer hand-parses JSON-LD');
});
