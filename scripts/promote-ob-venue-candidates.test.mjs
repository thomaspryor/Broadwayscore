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

const require = createRequire(import.meta.url);
const { buildShowEntry, resolveCandidateCategory } = require('./promote-ob-venue-candidates.js');

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
