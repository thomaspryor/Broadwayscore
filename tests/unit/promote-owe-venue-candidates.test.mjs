// BRO-4204 S4-T11 — Off-West End venue-page promoter
// (scripts/promote-owe-venue-candidates.js) + the staging primitives it
// prunes through (scripts/lib/owe-venue-staging.js updateStaging) + the
// parse seam it shares with discovery (parseVenueListingPage).
//
// Confirmation = the candidate's venue is one of discover-new-shows.js's
// VENUE_LISTING_PAGES AND that page still lists the title on a live re-fetch
// (through an injected fetchPage here). Dedup through the real
// findExistingMatch (London-pool fallback, S4-T9) and the retired-id
// registry (matchesRetired on the minted id and on title+venue); the S4-T6
// ingest gate refuses non-theatre venues, receiving houses and junk titles.
// Tests the REAL exported functions per CLAUDE.md §15 — no logic copies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  decideOffWestEndVenuePromotion: decideRaw,
  buildOffWestEndVenueShowEntry,
  collectCandidates,
  fetchVenueListing,
  fetchVenueListings,
  findVenueListingPage,
  evaluateCandidates: evaluateRaw,
  main: mainRaw,
  MAX_PROMOTE_PER_RUN,
} = require('../../scripts/promote-owe-venue-candidates.js');
// These tests pin the undated link-page path, using venues that now have
// BRO-4398 dated readers (where that path is refused); run them with no
// dated readers configured. The dated rule is covered in
// promote-owe-dated-listing.test.mjs.
const LINK_ONLY = { datedConfigs: [] };
const decideOffWestEndVenuePromotion = (c, ctx = {}) => decideRaw(c, { ...LINK_ONLY, ...ctx });
const evaluateCandidates = (cs, ctx = {}) => evaluateRaw(cs, { ...LINK_ONLY, ...ctx });
const main = (argv, io = {}) => mainRaw(argv, { ...LINK_ONLY, ...io });
const { VENUE_LISTING_PAGES, parseVenueListingPage } = require('../../scripts/discover-new-shows.js');
const { candidateHash, loadStaging, writeStagingCandidates, updateStaging } = require('../../scripts/lib/owe-venue-staging.js');
const { buildVenueVocabulary } = require('../../scripts/lib/show-title-normalize.js');
const { normalizeTitle } = require('../../scripts/lib/title-match.js');

const NOW = new Date('2026-09-28T18:00:00Z');
const ALMEIDA = VENUE_LISTING_PAGES.find((p) => p.name === 'Almeida Theatre');
const ORANGE_TREE = VENUE_LISTING_PAGES.find((p) => p.name === 'Orange Tree Theatre');
const NEW_DIORAMA = VENUE_LISTING_PAGES.find((p) => p.name === 'New Diorama Theatre');
const FINBOROUGH = VENUE_LISTING_PAGES.find((p) => p.name === 'Finborough Theatre');
const KILN = VENUE_LISTING_PAGES.find((p) => p.name === 'Kiln Theatre');
assert.ok(ALMEIDA && ORANGE_TREE && NEW_DIORAMA && FINBOROUGH && KILN, 'fixture venues must exist in VENUE_LISTING_PAGES');

function candidate(title, venue, extra = {}) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const source = `venue-page:${venue.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const c = { title, venue, slug, openingDate: null, closingDate: null, category: 'off-west-end', description: '', provisional: true, discoverySource: source, source, discoveredAt: NOW.toISOString(), ...extra };
  c.candidateHash = candidateHash(c);
  return c;
}
// venueListings as fetchVenueListings() returns them: page name → titles Set.
function listings(byVenue) {
  const m = new Map();
  for (const [name, titles] of Object.entries(byVenue)) {
    const page = VENUE_LISTING_PAGES.find((p) => p.name === name);
    m.set(name, Array.isArray(titles)
      ? { page, titles: new Set(titles.map(normalizeTitle)), rowCount: titles.length, error: null }
      : { page, ...titles });
  }
  return m;
}
const LONDON_POOL = [
  { id: 'golden-boy-off-west-end-2026', title: 'Golden Boy', venue: 'Almeida Theatre', category: 'off-west-end' },
  { id: 'operation-mincemeat-west-end-2024', title: 'Operation Mincemeat', venue: 'Fortune Theatre', category: 'west-end' },
  { id: 'dracula-west-end-2025', title: 'Dracula', venue: 'Noël Coward Theatre', category: 'west-end' },
];
function ctxFor(overrides = {}) {
  return {
    existingCandidates: LONDON_POOL.map((r) => ({ ...r })),
    existingIds: new Set(LONDON_POOL.map((r) => r.id)),
    venueVocabulary: buildVenueVocabulary(LONDON_POOL),
    venueListings: new Map(),
    retiredEntries: [],
    log: () => {},
    logEntry: () => {},
    now: () => NOW,
    ...overrides,
  };
}
// A venue page body long enough for parseVenueListingPage's soft-404 floor.
function almeidaHtml(slugs) {
  const links = slugs.map((s) => `<a href="/whats-on/${s}">${s}</a>`).join('');
  return `<html><body><p>${'x'.repeat(1200)}</p>${links}<a href="/whats-on/past-shows">past</a><a href="/about">about</a></body></html>`;
}

// --- findVenueListingPage / decideOffWestEndVenuePromotion ---

test('findVenueListingPage: matches VENUE_LISTING_PAGES by normalized venue name, never by substring', () => {
  assert.equal(findVenueListingPage('Almeida Theatre').name, 'Almeida Theatre');
  assert.equal(findVenueListingPage('The Other Palace').name, 'The Other Palace');
  assert.equal(findVenueListingPage('Other Palace').name, 'The Other Palace');
  assert.equal(findVenueListingPage('almeida').name, 'Almeida Theatre');
  assert.equal(findVenueListingPage('Bush Theatre'), null);
  // normalizeVenueName strips a trailing "Theatre", so "Park" IS Park Theatre —
  // but "Park Lane Theatre" ("park lane") is a different venue, never a prefix hit.
  assert.equal(findVenueListingPage('Park').name, 'Park Theatre');
  assert.equal(findVenueListingPage('Park Lane Theatre'), null);
  assert.equal(findVenueListingPage('Hampstead Theatre Downstairs'), null);
  assert.equal(findVenueListingPage(null), null);
});

test('decideOffWestEndVenuePromotion: a VENUE_LISTING_PAGES venue whose page still lists the title is confirmed', () => {
  const r = decideOffWestEndVenuePromotion(candidate('Triumph', 'Almeida Theatre'), { venueListings: listings({ 'Almeida Theatre': ['Triumph', 'Golden Boy'] }) });
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'venue-page');
  assert.equal(r.page.url, ALMEIDA.url);
  assert.match(r.reason, /lists "Triumph" on re-fetch/);
  // Title comparison is normalized (case, diacritics, leading article).
  const r2 = decideOffWestEndVenuePromotion(candidate('The Vortex', 'Orange Tree Theatre'), { venueListings: listings({ 'Orange Tree Theatre': ['VORTEX'] }) });
  assert.equal(r2.confirmed, true);
});

test('decideOffWestEndVenuePromotion: a venue outside VENUE_LISTING_PAGES can never be confirmed (persistent)', () => {
  const r = decideOffWestEndVenuePromotion(candidate('A New Play', 'Bush Theatre'), { venueListings: listings({ 'Almeida Theatre': ['A New Play'] }) });
  assert.equal(r.confirmed, false);
  assert.equal(r.persistent, true);
  assert.match(r.reason, /not one of the curated VENUE_LISTING_PAGES/);
});

test('decideOffWestEndVenuePromotion: fetch-dependent refusals HOLD (persistent:false); "no longer listed" PRUNES', () => {
  const c = candidate('Bluebirds', 'Finborough Theatre');
  const notFetched = decideOffWestEndVenuePromotion(c, { venueListings: new Map() });
  assert.equal(notFetched.confirmed, false);
  assert.equal(notFetched.persistent, false);
  assert.match(notFetched.reason, /not fetched this run/);

  const failed = decideOffWestEndVenuePromotion(c, { venueListings: listings({ 'Finborough Theatre': { titles: null, error: 'HTTP 403' } }) });
  assert.equal(failed.persistent, false);
  assert.match(failed.reason, /fetch failed .*HTTP 403/);

  // A venue's own what's-on page parsing to ZERO productions is a parser/
  // fetch failure, never proof the show is gone — one markup change must
  // not prune a whole venue out of staging.
  const empty = decideOffWestEndVenuePromotion(c, { venueListings: listings({ 'Finborough Theatre': [] }) });
  assert.equal(empty.persistent, false);
  assert.match(empty.reason, /parsed to 0 listings/);

  const gone = decideOffWestEndVenuePromotion(c, { venueListings: listings({ 'Finborough Theatre': ['The Moth', 'It Comes In Waves'] }) });
  assert.equal(gone.confirmed, false);
  assert.equal(gone.persistent, true);
  assert.match(gone.reason, /no longer lists "Bluebirds"/);
});

test('decideOffWestEndVenuePromotion: the S4-T6 ingest gate refuses non-theatre venues, receiving houses and junk titles before any fetch is consulted', () => {
  const lists = listings({ 'New Diorama Theatre': ['Migrant Qa Panel', 'Acting Lab'], 'Orange Tree Theatre': ['Acting Lab'] });
  const cases = [
    [candidate('Sylvia', 'Royal Albert Hall'), /NON_THEATRE_VENUE_RE/],
    [candidate('The Karate Kid', 'New Wimbledon Theatre'), /receiving house/],
    [candidate('Migrant Qa Panel', 'New Diorama Theatre'), /London ingest gate/],
    [candidate('Acting Lab', 'Orange Tree Theatre'), /venue-page exclusion phrase/],
    [candidate('?tab=dates', 'Hampstead Theatre'), /URL fragment/],
    [{ ...candidate('Dracula', 'Noël Coward Theatre'), category: 'west-end' }, /not an off-west-end candidate/],
    [candidate('', 'Almeida Theatre'), /missing title or venue/],
  ];
  for (const [c, re] of cases) {
    const r = decideOffWestEndVenuePromotion(c, { venueListings: lists });
    assert.equal(r.confirmed, false, c.title);
    assert.equal(r.persistent, true, `${c.title}: a refusal that is a property of the candidate must prune, not hold`);
    assert.match(r.reason, re, c.title);
  }
  assert.equal(decideOffWestEndVenuePromotion(null).confirmed, false);
});

// --- buildOffWestEndVenueShowEntry ---

test('buildOffWestEndVenueShowEntry: dateless venue-page candidate → announced, type null, provisional, off-west-end id/slug/market', () => {
  const vocab = buildVenueVocabulary(LONDON_POOL);
  const e = buildOffWestEndVenueShowEntry(candidate('Bluebirds', 'Finborough Theatre'), vocab, { now: NOW });
  assert.equal(e.id, 'bluebirds-off-west-end-2026');
  assert.equal(e.slug, 'bluebirds-off-west-end');
  assert.equal(e.title, 'Bluebirds');
  assert.equal(e.venue, 'Finborough Theatre');
  assert.equal(e.status, 'announced');
  assert.equal(e.type, null);
  assert.equal(e.category, 'off-west-end');
  assert.equal(e.market, 'west-end');
  assert.equal(e.openingDate, null);
  assert.equal(e.openingDateSource, null);
  assert.equal(e.provisional, true);
  assert.equal(e.discoverySource, 'venue-page:finborough-theatre');
  assert.equal(e.discoveredAt, NOW.toISOString());
});

test('buildOffWestEndVenueShowEntry: real dates drive status + id year, and a non-announced row always gets a type', () => {
  const vocab = buildVenueVocabulary(LONDON_POOL);
  const open = buildOffWestEndVenueShowEntry(candidate('Cranford', 'Orange Tree Theatre', { openingDate: '2026-09-10' }), vocab, { now: NOW });
  assert.equal(open.status, 'open');
  assert.equal(open.type, 'play');
  assert.equal(open.openingDateSource, 'venue-page');
  const upcoming = buildOffWestEndVenueShowEntry(candidate('Cranford: A New Musical', 'Orange Tree Theatre', { openingDate: '2027-02-10' }), vocab, { now: NOW });
  assert.equal(upcoming.status, 'upcoming');
  assert.equal(upcoming.type, 'musical');
  assert.equal(upcoming.id, 'cranford-a-new-musical-off-west-end-2027', 'id year comes from the date (mintCandidateId), not the clock');
  const previews = buildOffWestEndVenueShowEntry(candidate('Sapling', 'Orange Tree Theatre', { previewsStartDate: '2026-09-20' }), vocab, { now: NOW });
  assert.equal(previews.status, 'previews');
  const closed = buildOffWestEndVenueShowEntry(candidate('Sapling', 'Orange Tree Theatre', { openingDate: '2026-05-01', closingDate: '2026-06-01' }), vocab, { now: NOW });
  assert.equal(closed.status, 'closed');
  // Malformed dates are dropped, never written through.
  const bad = buildOffWestEndVenueShowEntry(candidate('Sapling', 'Orange Tree Theatre', { openingDate: 'TBD', closingDate: 'null' }), vocab, { now: NOW });
  assert.equal(bad.openingDate, null);
  assert.equal(bad.closingDate, null);
  assert.equal(bad.status, 'announced');
});

test('buildOffWestEndVenueShowEntry: a placeholder venue is refused (venue: null) and a venue-suffixed title is normalised', () => {
  const vocab = buildVenueVocabulary(LONDON_POOL);
  assert.equal(buildOffWestEndVenueShowEntry(candidate('Sapling', 'West End'), vocab, { now: NOW }).venue, null);
  assert.equal(buildOffWestEndVenueShowEntry(candidate('Sapling', 'TBA'), vocab, { now: NOW }).venue, null);
  const e = buildOffWestEndVenueShowEntry(candidate('Sapling (Orange Tree Theatre)', 'Orange Tree Theatre'), vocab, { now: NOW });
  assert.equal(e.title, 'Sapling');
  assert.equal(e.id, 'sapling-off-west-end-2026');
});

// --- collectCandidates / fetchVenueListing(s) ---

test('collectCandidates: reads the staging shape, backfills source/category/candidateHash on legacy rows, drops non-objects', () => {
  const rows = collectCandidates({ staged: [
    { title: 'Golden Boy', venue: 'Almeida Theatre', discoverySource: 'venue-page:almeida-theatre' },
    null,
    'junk',
    candidate('Triumph', 'Almeida Theatre'),
  ] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'venue-page:almeida-theatre');
  assert.equal(rows[0].category, 'off-west-end');
  assert.equal(rows[0].candidateHash, candidateHash({ title: 'Golden Boy', venue: 'Almeida Theatre' }));
  assert.equal(rows[1].candidateHash, candidate('Triumph', 'Almeida Theatre').candidateHash);
});

test('fetchVenueListing: parses the live page with discovery\'s parseVenueListingPage; a throw or empty body is reported, never thrown', async () => {
  const html = almeidaHtml(['golden-boy', 'triumph']);
  const ok = await fetchVenueListing(ALMEIDA, { fetchPage: async (url, opts) => { assert.equal(url, ALMEIDA.url); assert.equal(opts.renderJs, false); return { content: html }; }, log: () => {} });
  assert.equal(ok.error, null);
  assert.deepEqual([...ok.titles].sort(), ['golden boy', 'triumph']);
  assert.equal(ok.rowCount, parseVenueListingPage(ALMEIDA, html).length, 'same parser as discovery');

  const threw = await fetchVenueListing(ALMEIDA, { fetchPage: async () => { throw new Error('All scraping methods failed'); }, log: () => {} });
  assert.equal(threw.titles, null);
  assert.match(threw.error, /All scraping methods failed/);
  const empty = await fetchVenueListing(ALMEIDA, { fetchPage: async () => ({ content: '' }), log: () => {} });
  assert.equal(empty.titles, null);
  assert.equal(empty.error, 'empty response');
});

test('fetchVenueListings: one fetch per distinct listed venue, none for unknown venues, bounded by --limit', async () => {
  const fetched = [];
  const fetchPage = async (url) => { fetched.push(url); return { content: almeidaHtml(['x']) }; };
  const cands = [
    candidate('A', 'Almeida Theatre'), candidate('B', 'Almeida Theatre'),
    candidate('C', 'Bush Theatre'),
    candidate('D', 'Kiln Theatre'), candidate('E', 'Finborough Theatre'),
  ];
  const all = await fetchVenueListings(cands, { fetchPage, log: () => {} });
  assert.deepEqual(fetched, [ALMEIDA.url, KILN.url, FINBOROUGH.url]);
  assert.deepEqual([...all.keys()], ['Almeida Theatre', 'Kiln Theatre', 'Finborough Theatre']);
  fetched.length = 0;
  const capped = await fetchVenueListings(cands, { fetchPage, limit: 2, log: () => {} });
  assert.equal(fetched.length, 2);
  assert.equal(capped.size, 2);
  assert.ok(!capped.has('Finborough Theatre'), 'the third venue is left unfetched → its candidates are held, not pruned');
});

// --- evaluateCandidates ---

test('evaluateCandidates: dedup (venue match + London-pool fallback), retired registry, gate, confirmation, cap — end to end', async () => {
  const lists = listings({
    'Almeida Theatre': ['Golden Boy', 'Triumph'],
    'New Diorama Theatre': ['Operation Mincemeat', 'Stuffed'],
    'Finborough Theatre': ['Bluebirds', 'The Moth'],
    'Orange Tree Theatre': ['Acting Lab', 'Cranford'],
  });
  const cands = [
    candidate('Golden Boy', 'Almeida Theatre'),              // venue-gated duplicate
    candidate('Operation Mincemeat', 'New Diorama Theatre'), // London-pool title fallback (row is at the Fortune)
    candidate('?tab=dates', 'Hampstead Theatre'),            // retired by title+venue (different id-year) — Hampstead is NOT fetched, must still prune
    candidate('Bluebirds', 'Finborough Theatre'),            // retired by minted id
    candidate('Acting Lab', 'Orange Tree Theatre'),          // exclusion phrase (S4-T6 / VENUE_PAGE_EXCLUDE_PATTERNS)
    candidate('The Moth', 'Finborough Theatre'),             // confirmed → promoted
    candidate('Triumph', 'Almeida Theatre'),                 // confirmed → held by the cap
    candidate('Cranford', 'Orange Tree Theatre'),            // confirmed → held by the cap
    candidate('Stuffed', 'Kiln Theatre'),                    // Kiln not fetched → held
  ];
  const entries = [];
  const ctx = ctxFor({
    venueListings: lists,
    retiredEntries: [
      // A blockTitleVenue retirement from a PRIOR id-year: the 2026 mint
      // ("tabdates-off-west-end-2026") differs from the retired id, so only
      // the title+venue pair can catch it.
      { id: 'tabdates-off-west-end-2025', title: '?tab=dates', venue: 'Hampstead Theatre' },
      { id: 'bluebirds-off-west-end-2026', title: null, venue: null },
    ],
    maxPromote: 1,
    logEntry: (e) => entries.push(e),
  });
  const { promoted, held, pruned } = await evaluateCandidates(cands, ctx);

  assert.deepEqual(promoted.map((p) => p.entry.id), ['the-moth-off-west-end-2026']);
  assert.equal(promoted[0].entry.status, 'announced');
  assert.equal(promoted[0].sourceUrl, FINBOROUGH.url);
  assert.ok(ctx.existingIds.has('the-moth-off-west-end-2026'), 'promotion visible to later dedup in the same run');
  assert.equal(ctx.existingCandidates.at(-1).category, 'off-west-end');

  const kinds = Object.fromEntries(pruned.map((p) => [p.candidate.title, p.kind]));
  assert.equal(kinds['Golden Boy'], 'skip-duplicate');
  assert.equal(kinds['Operation Mincemeat'], 'skip-duplicate');
  assert.match(pruned.find((p) => p.candidate.title === 'Operation Mincemeat').reason, /operation-mincemeat-west-end-2024 \(london-pool-title-equal/);
  assert.equal(kinds['?tab=dates'], 'skip-retired');
  assert.match(pruned.find((p) => p.candidate.title === '?tab=dates').reason, /tabdates-off-west-end-2025 by title\+venue/);
  assert.equal(kinds['Bluebirds'], 'skip-retired');
  assert.match(pruned.find((p) => p.candidate.title === 'Bluebirds').reason, /by id/);
  assert.equal(kinds['Acting Lab'], 'skip-unconfirmed');
  assert.equal(kinds['The Moth'], 'promote');
  assert.equal(pruned.length, 6);

  const heldKinds = Object.fromEntries(held.map((h) => [h.candidate.title, h.kind]));
  assert.deepEqual(heldKinds, { Triumph: 'skip-cap-deferred', Cranford: 'skip-cap-deferred', Stuffed: 'skip-unconfirmed' });
  assert.match(held.find((h) => h.candidate.title === 'Stuffed').reason, /not fetched this run/);
  // The `promote` audit line is deferred to main() (after the shows.json write landed).
  assert.ok(!entries.some((e) => e.kind === 'promote'));
  assert.ok(entries.some((e) => e.kind === 'skip-retired' && e.retiredId === 'tabdates-off-west-end-2025' && e.matchedBy === 'title+venue'));
});

test('evaluateCandidates: a candidate that throws is held as candidate-error and the batch continues', async () => {
  class Booby extends Map { get(k) { if (k === 'Kiln Theatre') throw new Error('kaboom'); return super.get(k); } }
  const lists = new Booby(listings({ 'Almeida Theatre': ['Triumph'] }));
  const { promoted, held } = await evaluateCandidates([candidate('Boom', 'Kiln Theatre'), candidate('Triumph', 'Almeida Theatre')], ctxFor({ venueListings: lists }));
  assert.deepEqual(promoted.map((p) => p.entry.id), ['triumph-off-west-end-2026']);
  assert.equal(held.length, 1);
  assert.equal(held[0].kind, 'candidate-error');
  assert.match(held[0].reason, /kaboom/);
});

test('evaluateCandidates: default cap is MAX_PROMOTE_PER_RUN and the overflow is held, not aborted', async () => {
  // Distinct two-word titles: "Show Number 1" / "Show Number 2" would be a
  // real typo-distance duplicate under findExistingMatch (levenshtein 1).
  const A = ['Amber', 'Birch', 'Cedar', 'Dune', 'Ember', 'Fable', 'Glade', 'Harbour', 'Iris', 'Jade', 'Kestrel', 'Lantern', 'Meadow', 'Nimbus', 'Orchid', 'Pebble', 'Quill', 'Raven', 'Saffron', 'Thistle', 'Umber', 'Velvet', 'Willow', 'Xenon', 'Yarrow', 'Zephyr', 'Cobalt', 'Marigold'];
  const B = ['Tide', 'Crown', 'Engine', 'Garden', 'Mirror', 'Ladder', 'Compass', 'Signal', 'Anchor', 'Furnace', 'Harvest', 'Lattice', 'Monsoon', 'Orbit', 'Parlour', 'Quarry', 'Ribbon', 'Summit', 'Tunnel', 'Vessel', 'Window', 'Beacon', 'Canyon', 'Dagger', 'Fjord', 'Glacier', 'Hollow', 'Island'];
  const titles = Array.from({ length: MAX_PROMOTE_PER_RUN + 3 }, (_, i) => `${A[i]} ${B[i]}`);
  const cands = titles.map((t) => candidate(t, 'Almeida Theatre'));
  const { promoted, held, pruned } = await evaluateCandidates(cands, ctxFor({ venueListings: listings({ 'Almeida Theatre': titles }) }));
  assert.equal(promoted.length, MAX_PROMOTE_PER_RUN);
  assert.equal(held.length, 3);
  assert.ok(held.every((h) => h.kind === 'skip-cap-deferred'));
  assert.equal(pruned.filter((p) => p.kind === 'promote').length, MAX_PROMOTE_PER_RUN);
});

// --- main(): --dry-run writes nothing; a real run writes only through the guard and prunes staging under the lock ---

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owe-promote-'));
  const showsPath = path.join(dir, 'shows.json');
  const stagingPath = path.join(dir, 'owe-venue-candidates.json');
  const lastPromotionFile = path.join(dir, 'owe-last-promotion-ids.json');
  const shows = { _meta: { totalShows: LONDON_POOL.length }, shows: LONDON_POOL.map((r) => ({ ...r, slug: r.id.replace(/-\d{4}$/, ''), status: 'open', market: 'west-end', venue: r.venue })) };
  fs.writeFileSync(showsPath, JSON.stringify(shows, null, 2) + '\n');
  writeStagingCandidates([
    candidate('Golden Boy', 'Almeida Theatre'),   // duplicate → pruned
    candidate('Triumph', 'Almeida Theatre'),      // confirmed → promoted
    candidate('Stuffed', 'Kiln Theatre'),         // Kiln fetch fails → held
  ], stagingPath);
  return { dir, showsPath, stagingPath, lastPromotionFile };
}
const scratchIo = (paths, extra = {}) => ({
  ...paths,
  retiredEntries: [],
  log: () => {},
  logEntry: () => {},
  now: () => NOW,
  fetchPage: async (url) => {
    if (url === ALMEIDA.url) return { content: almeidaHtml(['golden-boy', 'triumph']) };
    throw new Error('HTTP 403');
  },
  ...extra,
});

test('main --dry-run: evaluates against real files but writes NOTHING (shows.json, staging, state file all untouched)', async () => {
  const paths = scratchRepo();
  const before = { shows: fs.readFileSync(paths.showsPath, 'utf8'), staging: fs.readFileSync(paths.stagingPath, 'utf8') };
  const res = await main(['--dry-run'], scratchIo(paths));
  assert.equal(res.dryRun, true);
  assert.deepEqual(res.promoted.map((p) => p.entry.id), ['triumph-off-west-end-2026']);
  assert.equal(res.held.length, 1);
  assert.equal(res.pruned.filter((p) => p.kind === 'skip-duplicate').length, 1);
  assert.equal(fs.readFileSync(paths.showsPath, 'utf8'), before.shows);
  assert.equal(fs.readFileSync(paths.stagingPath, 'utf8'), before.staging);
  assert.ok(!fs.existsSync(paths.lastPromotionFile), 'no state file in a dry run');
  assert.deepEqual(res.suppressedWrites, [], 'the dry-run returns before the guard is even asked to write');
});

test('main (real run): the row lands via the write guard with a reason, staging keeps only the held candidate, the state file names the promotion', async () => {
  const paths = scratchRepo();
  const entries = [];
  const res = await main([], scratchIo(paths, { logEntry: (e) => entries.push(e) }));
  const shows = JSON.parse(fs.readFileSync(paths.showsPath, 'utf8'));
  const row = shows.shows.find((s) => s.id === 'triumph-off-west-end-2026');
  assert.ok(row, 'promoted row written');
  assert.equal(row.status, 'announced');
  assert.equal(row.provisional, true);
  assert.equal(row.discoverySource, 'venue-page:almeida-theatre');
  assert.equal(shows._meta.totalShows, LONDON_POOL.length + 1, 'written through shows-write-guard (stamps _meta.totalShows)');
  assert.equal(shows.shows.length, LONDON_POOL.length + 1);

  const staged = loadStaging(paths.stagingPath);
  assert.deepEqual(staged.map((c) => c.title), ['Stuffed'], 'promoted + duplicate leave staging; the held candidate stays');
  assert.ok(!fs.existsSync(`${paths.stagingPath}.lock`), 'staging lock released');

  const state = JSON.parse(fs.readFileSync(paths.lastPromotionFile, 'utf8'));
  assert.deepEqual(state.promoted.map((p) => p.id), ['triumph-off-west-end-2026']);
  assert.equal(state.promoted[0].sourceUrl, ALMEIDA.url);
  assert.deepEqual(state.rejected.map((r) => [r.title, r.kind]), [['Golden Boy', 'skip-duplicate']]);
  assert.ok(entries.some((e) => e.kind === 'promote' && e.id === 'triumph-off-west-end-2026'), 'promote audit line written after the shows.json write');
  assert.equal(res.pruned.length, 2);
});

test('main (real run, nothing to promote): duplicates still leave staging and the state file is reset', async () => {
  const paths = scratchRepo();
  updateStaging((cur) => cur.filter((c) => c.title !== 'Triumph'), paths.stagingPath);
  const before = fs.readFileSync(paths.showsPath, 'utf8');
  const res = await main([], scratchIo(paths));
  assert.equal(res.promoted.length, 0);
  assert.equal(fs.readFileSync(paths.showsPath, 'utf8'), before, 'shows.json untouched');
  assert.deepEqual(loadStaging(paths.stagingPath).map((c) => c.title), ['Stuffed']);
  const state = JSON.parse(fs.readFileSync(paths.lastPromotionFile, 'utf8'));
  assert.deepEqual(state.promoted, []);
  assert.equal(state.rejected.length, 1);
});

// --- lib/owe-venue-staging.js: updateStaging ---

test('updateStaging: locked read-modify-write on a scratch path; a non-array mutateFn result throws and leaves the file untouched', () => {
  const stagingPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owe-staging-')), 'owe-venue-candidates.json');
  writeStagingCandidates([candidate('A', 'Almeida Theatre'), candidate('B', 'Kiln Theatre')], stagingPath);
  assert.equal(loadStaging(stagingPath).length, 2);
  const removed = candidateHash({ title: 'A', venue: 'Almeida Theatre' });
  const next = updateStaging((cur) => cur.filter((c) => c.candidateHash !== removed), stagingPath);
  assert.deepEqual(next.map((c) => c.title), ['B']);
  assert.deepEqual(loadStaging(stagingPath).map((c) => c.title), ['B']);
  assert.throws(() => updateStaging(() => null, stagingPath), /must return an array/);
  assert.deepEqual(loadStaging(stagingPath).map((c) => c.title), ['B']);
  assert.ok(!fs.existsSync(`${stagingPath}.lock`));
  // The upsert still goes through the same lock: a concurrent-style re-add is an upsert by hash, not a duplicate.
  writeStagingCandidates([{ ...candidate('B', 'Kiln Theatre'), slug: 'b-refreshed' }], stagingPath);
  const after = loadStaging(stagingPath);
  assert.equal(after.length, 1);
  assert.equal(after[0].slug, 'b-refreshed');
});
