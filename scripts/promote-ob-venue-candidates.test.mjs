// BRO-160: buildShowEntry() stops hardcoding category/market/date fields.
// Tests the REAL exported functions per CLAUDE.md §15 — no logic copies.
//
// Companion coverage lives in tests/unit/promote-regional-auto.test.mjs
// (buildRegionalShowEntry / buildOffBroadwayAggregatorShowEntry, which are
// deliberately unchanged by this card — they already resolve category/market
// correctly for their own candidate classes). This file is scoped to
// buildShowEntry / resolveCandidateCategory, the generic builder BRO-160
// found hardcoding.
//
// resolveCandidateCategory is deliberately OB-only (never returns
// 'west-end'/'off-west-end'/'broadway') — a first cut that trusted those
// values verbatim was caught by a Codex adversarial review as an
// unvalidated cross-market writer: combined with --admin-promote-all it
// could mint a West End show through a pipeline whose dedup pool and
// staging file are off-broadway/regional-scoped only, bypassing
// scripts/promote-we-aggregator-candidates.js's dedicated validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildShowEntry, resolveCandidateCategory } = require('./promote-ob-venue-candidates.js');
const { main } = require('./promote-ob-venue-candidates.js');
const { createShowsWriteGuard } = require('./lib/shows-write-guard.js');
const { datedBackfillFor } = require('./lib/ob-venue-date-backfill.js');
const { pruneStagedCandidates } = require('./lib/aggregator-candidate-extract.js');
const { OB_VENUE_CONFIGS, parseVenueListingHtml, writeStagingCandidates, loadStaging } = require('./lib/venue-listing-discover.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-09-30';
// The dated venue pages captured for BRO-4396 reproduce BRO-4448 without fetching.
const BACKFILL_CASES = [
  ['New York Theatre Workshop', 'new-york-theatre-workshop', 'Wild Rose', 'wild-rose-off-broadway-2026', '2026-11-24', '2027-01-10'],
  ['A.R.T./New York Theatres', 'a.r.t.-new-york-theatres', 'Aftermath', 'aftermath-art-new-york-off-broadway-2026', '2026-10-19', '2026-11-08'],
  ['Laura Pels Theatre', 'laura-pels-theatre', 'The Grief Eater Near North Bender', 'the-grief-eater-near-north-bender-off-broadway-2026', '2027-01-21', '2027-03-21'],
  ['Lincoln Center Theater', 'lincoln-center-theater', "Pretend it's Pretend", 'pretend-its-pretend-off-broadway-2026', '2027-01-26', null],
].map(([venue, fixture, title, id, first, last]) => ({
  candidate: parseVenueListingHtml(OB_VENUE_CONFIGS.find(c => c.name === venue),
    fs.readFileSync(path.join(ROOT, 'tests/fixtures/ob-discovery', fixture + '.html'), 'utf8'), { todayIso: TODAY }).find(c => c.title === title),
  row: { id, title, venue, slug: id.replace(/-\d{4}$/, ''), category: 'off-broadway', market: 'broadway', status: 'announced', type: 'play', previewsStartDate: null, openingDate: null, closingDate: null },
  patch: { previewsStartDate: first, ...(last ? { closingDate: last } : {}) },
}));

for (const { candidate, row, patch } of BACKFILL_CASES) {
  test(`datedBackfillFor: captured venue listing dates ${row.id}`, () => {
    assert.ok(candidate, 'real venue fixture contains the candidate');
    assert.deepEqual(datedBackfillFor(candidate, row, { todayIso: TODAY }), patch);
  });
}

test('datedBackfillFor: only an undated announced OB row in the stub year or next year qualifies', () => {
  const { candidate, row } = BACKFILL_CASES[0];
  const check = (c, r) => datedBackfillFor(c, r, { todayIso: TODAY });
  for (const status of ['upcoming', 'previews', 'open', 'closed', undefined]) assert.equal(check(candidate, { ...row, status }), null);
  for (const key of ['previewsStartDate', 'openingDate', 'closingDate']) assert.equal(check(candidate, { ...row, [key]: '2026-11-20' }), null, key);
  for (const year of [2024, 2027]) assert.equal(check(candidate, { ...row, id: `wild-rose-off-broadway-${year}` }), null, String(year));
  assert.deepEqual(check(candidate, { ...row, id: 'wild-rose-off-broadway-2025' }), BACKFILL_CASES[0].patch);
  assert.equal(check(candidate, { ...row, category: 'regional' }), null);
  assert.equal(check({ ...candidate, category: 'west-end' }, row), null);
});

test('datedBackfillFor: confirmation, discovery gates, next-ticket dates and booking horizons remain guarded', () => {
  const { candidate, row } = BACKFILL_CASES[0];
  const check = (overrides, options = {}) => datedBackfillFor({ ...candidate, ...overrides }, row, { todayIso: TODAY, ...options });
  for (const overrides of [
    { source: 'bww-roundup' }, { listingFirstDate: '2026-02-30' }, { listingLastDate: 'bad-date' },
    { listingFirstDate: null }, { listingPerformanceCount: 1 }, { listingEvidence: 'needs-corroboration' },
    { listingFirstDate: '2026-09-01', listingLastDate: '2026-09-10' },
  ]) assert.equal(check(overrides), null, JSON.stringify(overrides));
  assert.equal(check({}, { gates: { isNonTheaterContent: () => true } }), null);
  assert.deepEqual(check({ listingFirstDateIsNext: true }), { closingDate: '2027-01-10' });
  assert.deepEqual(check({ listingLastDateIsHorizon: true }), { previewsStartDate: '2026-11-24' });
  assert.equal(check({ listingFirstDateIsNext: true, listingLastDateIsHorizon: true }), null);
  assert.equal(check({ listingFirstDateIsNext: true, listingLastDate: null }), null);
  const { decideVenueListingPromotion } = require('./lib/ob-cross-validation');
  assert.equal(decideVenueListingPromotion(BACKFILL_CASES[3].candidate, { todayIso: TODAY }).confirmed, false, 'first-only listings still cannot mint a new show');
});

test('main: dry-run is read-only; a real guarded save dates all four duplicates and preserves established fields', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.tmp-ob-date-backfill-'));
  try {
    const io = {
      showsPath: path.join(dir, 'shows.json'), stagingPath: path.join(dir, 'staging.json'),
      lastPromotionFile: path.join(dir, 'last-promotions.json'), promotionLog: path.join(dir, 'promotion-log.jsonl'),
      reverseDiscoveryPath: path.join(dir, 'missing-reverse-discovery.json'), todayIso: TODAY,
      fetchTmOffBroadway: async () => ({ rows: [] }),
    };
    const shows = BACKFILL_CASES.map(({ row }) => ({ ...row }));
    // Exercise the house/room dedup and punctuation normalization used by the real rows.
    shows[1].title = 'Aftermath (A.R.T. New York)';
    shows[2].venue = 'The Laura Pels Theatre at the Harold and Miriam Steinberg Center for Theatre';
    shows[3].title = "Pretend It's Pretend";
    shows[3].venue = 'LCT3 at the Claire Tow Theater';
    const protectedRow = { ...shows[0], id: 'wild-rose-protected-off-broadway-2026', title: 'Protected Rose', openingDate: '2026-12-14' };
    shows.push(protectedRow);
    const candidates = BACKFILL_CASES.map(({ candidate }) => candidate).concat({ ...BACKFILL_CASES[0].candidate, title: protectedRow.title });
    createShowsWriteGuard(io.showsPath).saveShows({ _meta: { totalShows: shows.length }, shows });
    const swept = pruneStagedCandidates(candidates, shows, { todayIso: TODAY });
    assert.equal(swept.kept.length, 4, 'the daily extractor must leave all four dated duplicates for the promoter');
    assert.equal(swept.pruned.length, 1, 'the already dated duplicate still leaves staging');
    writeStagingCandidates(swept.kept, io.stagingPath);
    const before = fs.readFileSync(io.showsPath, 'utf8');
    const stagingBefore = fs.readFileSync(io.stagingPath, 'utf8');
    const dry = await main(['--regional-only', '--dry-run'], io);
    assert.equal(dry.backfills.length, 4);
    assert.equal(fs.readFileSync(io.showsPath, 'utf8'), before);
    assert.equal(fs.readFileSync(io.stagingPath, 'utf8'), stagingBefore);
    assert.equal(fs.existsSync(io.lastPromotionFile), false);
    assert.equal(fs.existsSync(io.promotionLog), false);
    const result = await main(['--regional-only'], io);
    assert.equal(result.promoted.length, 0, 'existing rows never mint new entries');
    assert.equal(result.backfills.length, 4);
    const after = JSON.parse(fs.readFileSync(io.showsPath, 'utf8')).shows;
    assert.equal(after.length, shows.length);
    for (const { row, patch } of BACKFILL_CASES) {
      const original = shows.find(s => s.id === row.id);
      assert.deepEqual(after.find(s => s.id === row.id), { ...original, ...patch }, 'only null dates change');
    }
    assert.equal(after[0].previewsStartDate, '2026-11-24', 'Wild Rose persisted after a real promotion run');
    assert.deepEqual(after.find(s => s.id === protectedRow.id), protectedRow);
    assert.deepEqual(loadStaging(io.stagingPath), []);
    const events = fs.readFileSync(io.promotionLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(e => e.kind === 'backfill-dates').length, 4);
    assert.deepEqual(JSON.parse(fs.readFileSync(io.lastPromotionFile, 'utf8')).promoted, []);
    // A repeated run is idempotent even if discovery restages the listings.
    writeStagingCandidates(candidates, io.stagingPath);
    const saved = fs.readFileSync(io.showsPath, 'utf8');
    assert.equal((await main(['--regional-only'], io)).backfills.length, 0);
    assert.equal(fs.readFileSync(io.showsPath, 'utf8'), saved);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const BASE = {
  title: 'Some OB Show',
  venue: "St. Luke's Theatre", // canonical off-broadway venue
  slug: 'some-ob-show',
  source: 'bww-roundup',
  discoveredAt: '2026-07-01',
};

test('resolveCandidateCategory: trusts an explicit off-broadway category', () => {
  assert.equal(resolveCandidateCategory({ ...BASE, category: 'off-broadway' }), 'off-broadway');
});

test('resolveCandidateCategory: falls back to off-broadway when category is missing/invalid, for an OB or unrecognized venue', () => {
  assert.equal(resolveCandidateCategory({ title: 'x', venue: "St. Luke's Theatre" }), 'off-broadway');
  assert.equal(resolveCandidateCategory({ ...BASE, category: 'regional' }), 'off-broadway', 'regional is routed upstream instead — never trusted here');
  assert.equal(resolveCandidateCategory({ ...BASE, category: 'bogus-value' }), 'off-broadway');
  assert.equal(resolveCandidateCategory({ title: 'x', venue: 'Some Brand New Theater Nobody Has Catalogued' }), 'off-broadway');
});

test('resolveCandidateCategory: never trusts a west-end/off-west-end/broadway candidate.category — always off-broadway or null', () => {
  assert.equal(resolveCandidateCategory({ ...BASE, category: 'west-end' }), 'off-broadway', 'a canonical OB venue wins even if category claims west-end');
  assert.equal(resolveCandidateCategory({ ...BASE, category: 'broadway' }), 'off-broadway');
});

test('resolveCandidateCategory: a West End venue is a misroute (null), never promoted as off-broadway', () => {
  assert.equal(resolveCandidateCategory({ title: 'x', venue: 'Sondheim Theatre' }), null, 'canonical West End venue → reject, not off-broadway');
  assert.equal(resolveCandidateCategory({ title: 'x', venue: 'Sondheim Theatre', category: 'off-broadway' }), null, 'West End venue rejects even if the candidate mislabels itself off-broadway');
});

test('buildShowEntry: off-broadway candidate (unchanged) — id/market/status', () => {
  const e = buildShowEntry(BASE);
  assert.match(e.id, /-off-broadway-\d{4}$/);
  assert.equal(e.status, 'announced');
  assert.equal(e.category, 'off-broadway');
  assert.equal(e.market, 'broadway');
});

test('buildShowEntry: a West End venue produces a null-venue entry the caller must refuse to promote', () => {
  const e = buildShowEntry({ ...BASE, venue: 'Sondheim Theatre' });
  assert.equal(e.venue, null, 'misroute — main() must skip on null venue, same as a placeholder-venue rejection');
});

test('buildShowEntry: preserves well-formed candidate-supplied dates instead of nulling them', () => {
  const e = buildShowEntry({ ...BASE, openingDate: '2026-09-01', previewsStartDate: '2026-08-15', closingDate: '2026-10-01' });
  assert.equal(e.openingDate, '2026-09-01');
  assert.equal(e.previewsStartDate, '2026-08-15');
  assert.equal(e.closingDate, '2026-10-01');
});

test('buildShowEntry: still defaults dates to null when the candidate carries none (V-T9 — orchestrator must skip null-openingDate)', () => {
  const e = buildShowEntry(BASE);
  assert.equal(e.openingDate, null);
  assert.equal(e.previewsStartDate, null);
  assert.equal(e.closingDate, null);
});

test('buildShowEntry: a malformed date string fails closed to null rather than writing through', () => {
  const e = buildShowEntry({ ...BASE, openingDate: 'not-a-date', previewsStartDate: '2026/08/15' });
  assert.equal(e.openingDate, null);
  assert.equal(e.previewsStartDate, null);
});

test('buildShowEntry: routes the venue through sanitizeVenueForWrite — a real venue passes through unchanged', () => {
  const e = buildShowEntry(BASE);
  assert.equal(e.venue, "St. Luke's Theatre");
});

test('buildShowEntry: a placeholder/neighbourhood-blob venue is refused (venue: null), not silently promoted', () => {
  const e = buildShowEntry({ ...BASE, venue: 'Midtown E' });
  assert.equal(e.venue, null, 'card #994 write-time guard — the promotion loop in main() must skip a null-venue entry');
});

// BRO-2026: id year comes from the production's own date, never the run year.
test('buildShowEntry: id year is the opening/previews year, not the current year', () => {
  const e = buildShowEntry({ ...BASE, previewsStartDate: '2031-01-10', openingDate: '2031-01-25' });
  assert.equal(e.id, 'some-ob-show-off-broadway-2031');
  assert.equal(e.idYearProvisional, undefined);
  // previews in Dec, opening in Jan: the opening year wins (discover-new-shows precedence)
  assert.equal(buildShowEntry({ ...BASE, previewsStartDate: '2031-12-20', openingDate: '2032-01-12' }).id, 'some-ob-show-off-broadway-2032');
});

test('buildShowEntry: dateless stub falls back to the run year and is flagged provisional', () => {
  const e = buildShowEntry({ ...BASE });
  assert.equal(e.id, `some-ob-show-off-broadway-${new Date().getFullYear()}`);
  assert.equal(e.idYearProvisional, true);
});

test('buildOffBroadwayAggregatorShowEntry: id year follows the publish date year', () => {
  const { buildOffBroadwayAggregatorShowEntry: b } = require('./promote-ob-venue-candidates.js');
  const e = b({ ...BASE, articlePublishedAt: '2031-03-02T10:00:00Z' });
  assert.equal(e.id, 'some-ob-show-off-broadway-2031');
  assert.equal(e.idYearProvisional, undefined);
  assert.equal(b({ ...BASE }).idYearProvisional, true);
});

// BRO-2026: promote-ob-historical's id year follows the production's dates.
const { buildShowEntry: buildHistoricalShowEntry } = require('./promote-ob-historical.js');
const row = (parsed) => ({ title: 'Some Show', venue: "St. Luke's Theatre", parsed, playbillUrl: 'x' });

test('dates decide the id year over the title-parsed year', () => {
  const e = buildHistoricalShowEntry(row({ dates: { openingDate: '2019-03-04' }, titleParse: { year: 2020 } }), new Set());
  assert.match(e.id, /-2019$/);
  assert.equal(e.idYearProvisional, undefined);
});
test('title-parsed year used when no dates', () => {
  const e = buildHistoricalShowEntry(row({ dates: {}, titleParse: { year: 2018 } }), new Set());
  assert.match(e.id, /-2018$/);
  assert.equal(e.idYearProvisional, undefined);
});
test('nothing dated: run year, flagged provisional', () => {
  const e = buildHistoricalShowEntry(row({ dates: {}, titleParse: {} }), new Set());
  assert.ok(e.id.endsWith(`-${new Date().getFullYear()}`));
  assert.equal(e.idYearProvisional, true);
});
test('closing date alone: closing year, still flagged provisional', () => {
  const e = buildHistoricalShowEntry(row({ dates: { closingDate: '1998-06-01' }, titleParse: {} }), new Set());
  assert.match(e.id, /-1998$/);
  assert.equal(e.idYearProvisional, true);
});
