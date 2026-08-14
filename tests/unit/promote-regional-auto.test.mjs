// Regional auto-promotion (2026-07-08, user rule: a PV Verdict / BWW Review
// Roundup page at a Broadway-feeder venue IS the go-live signal). Tests the
// REAL exported functions per CLAUDE.md §15 — no logic copies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildRegionalShowEntry, decideRegionalPromotion, buildShowEntry, decideOffBroadwayAggregatorPromotion, buildOffBroadwayAggregatorShowEntry } =
  require('../../scripts/promote-ob-venue-candidates.js');
const { feederVenueCity, classifyVenueMarket } =
  require('../../scripts/lib/aggregator-candidate-extract.js');

const ROUNDUP_CANDIDATE = {
  title: 'Testshow: The Fake Musical',
  venue: 'Goodman Theatre',
  slug: 'testshow-the-fake-musical',
  source: 'bww-roundup',
  sourceUrl: 'https://www.broadwayworld.com/article/Review-Roundup-TESTSHOW-20260701',
  articlePublishedAt: '2026-07-01T10:39:17-04:00',
  discoveredAt: '2026-07-03T15:27:32.001Z',
  category: 'regional',
};

test('decideRegionalPromotion: roundup-sourced feeder-venue candidate is confirmed', () => {
  const r = decideRegionalPromotion(ROUNDUP_CANDIDATE);
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'aggregator-roundup');
});

test('decideRegionalPromotion: playbill-verdict source also confirms', () => {
  const r = decideRegionalPromotion({ ...ROUNDUP_CANDIDATE, source: 'playbill-verdict' });
  assert.equal(r.confirmed, true);
});

test('decideRegionalPromotion: non-roundup source (venue listing) does NOT confirm', () => {
  const r = decideRegionalPromotion({ ...ROUNDUP_CANDIDATE, source: 'venue-page:goodman' });
  assert.equal(r.confirmed, false);
});

test('decideRegionalPromotion: non-regional and non-feeder candidates never confirm', () => {
  assert.equal(decideRegionalPromotion({ ...ROUNDUP_CANDIDATE, category: 'off-broadway' }).confirmed, false);
  assert.equal(decideRegionalPromotion({ ...ROUNDUP_CANDIDATE, venue: "St. Luke's Theatre" }).confirmed, false);
  assert.equal(decideRegionalPromotion(null).confirmed, false);
});

test('buildRegionalShowEntry: id/slug carry -regional-<article year>, market fail-closed', () => {
  const e = buildRegionalShowEntry(ROUNDUP_CANDIDATE);
  assert.equal(e.id, 'testshow-the-fake-musical-regional-2026');
  assert.equal(e.slug, e.id, 'slug must contain -regional (useCurrentMarket detection)');
  assert.equal(e.category, 'regional');
  assert.equal(e.market, 'regional', "market must be 'regional' so every .market !== 'broadway' gate excludes it");
  assert.deepEqual(e.tags, ['regional']);
  assert.equal(e.provisional, true);
  assert.equal(e.discoverySource, 'aggregator-roundup:bww-roundup');
});

test('buildRegionalShowEntry: status open + openingDate from the roundup publish date', () => {
  const e = buildRegionalShowEntry(ROUNDUP_CANDIDATE);
  assert.equal(e.status, 'open', 'a roundup only exists after press night');
  assert.equal(e.openingDate, '2026-07-01');
  assert.equal(e.openingDateSource, 'aggregator-roundup');
});

test('buildRegionalShowEntry: venue gets the feeder city suffix; type detected from title', () => {
  const e = buildRegionalShowEntry(ROUNDUP_CANDIDATE);
  assert.equal(e.venue, 'Goodman Theatre, Chicago, IL');
  assert.equal(e.type, 'musical');
  const play = buildRegionalShowEntry({ ...ROUNDUP_CANDIDATE, title: 'A Serious Drama', slug: 'a-serious-drama', venue: 'Arena Stage' });
  assert.equal(play.type, null, 'no musical keyword → type stays null (validate-data allows null)');
  assert.equal(play.venue, 'Arena Stage, Washington, DC');
});

test('buildRegionalShowEntry: unparseable article date falls back to current year, null openingDate', () => {
  const e = buildRegionalShowEntry({ ...ROUNDUP_CANDIDATE, articlePublishedAt: 'not-a-date' });
  assert.equal(e.openingDate, null);
  assert.match(e.id, /-regional-\d{4}$/);
});

test('feeder table: classification and city can never disagree', () => {
  for (const venue of ['Goodman Theatre', 'Arena Stage', 'La Jolla Playhouse', 'American Repertory Theater', "St. Luke's Theatre", 'A.R.T./New York Theatres']) {
    const market = classifyVenueMarket(venue);
    const city = feederVenueCity(venue);
    assert.equal(market === 'regional', city !== null, `venue "${venue}" classified ${market} but city=${city}`);
  }
});

test('OB buildShowEntry unchanged: still -off-broadway- id, announced, market broadway', () => {
  const e = buildShowEntry({ title: 'Some OB Show', venue: "St. Luke's Theatre", slug: 'some-ob-show', source: 'bww-roundup', discoveredAt: '2026-07-01' });
  assert.match(e.id, /-off-broadway-\d{4}$/);
  assert.equal(e.status, 'announced');
  assert.equal(e.market, 'broadway');
});

// Off-broadway candidates sourced directly from a PV/BWW roundup page
// (2026-08-13, owner rule: "every single Verdict or Review Roundup article
// should automatically trigger that show to be on the site if it isn't
// already"). Mirrors decideRegionalPromotion's reasoning, extended to
// off-broadway — venue-page-sourced OB candidates are deliberately excluded.
//
// Base fixture for the confirming cases: canonical venue + fresh, compatible
// dates. Ship-check adversarial review (2026-08-14) added the venue +
// staleness checks below after finding neither was gated in the first cut.
const OB_ROUNDUP_CANDIDATE = {
  title: 'A Serious Play', venue: 'Daryl Roth Theatre', slug: 'a-serious-play',
  source: 'bww-roundup',
  articlePublishedAt: '2026-08-01T10:00:00-04:00',
  discoveredAt: '2026-08-01T18:00:00.000Z',
  category: 'off-broadway',
};

test('decideOffBroadwayAggregatorPromotion: roundup-sourced OB candidate at a canonical venue with fresh dates is confirmed', () => {
  const r = decideOffBroadwayAggregatorPromotion(OB_ROUNDUP_CANDIDATE);
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'aggregator-roundup');
});

test('decideOffBroadwayAggregatorPromotion: playbill-verdict source also confirms', () => {
  const r = decideOffBroadwayAggregatorPromotion({ ...OB_ROUNDUP_CANDIDATE, source: 'playbill-verdict' });
  assert.equal(r.confirmed, true);
});

test('decideOffBroadwayAggregatorPromotion: venue-page source does NOT confirm (still needs Playbill-OB/Lortel)', () => {
  const r = decideOffBroadwayAggregatorPromotion({ ...OB_ROUNDUP_CANDIDATE, source: 'venue-page:atlantic-theater' });
  assert.equal(r.confirmed, false);
});

test('decideOffBroadwayAggregatorPromotion: non-off-broadway categories never confirm', () => {
  assert.equal(decideOffBroadwayAggregatorPromotion({ ...OB_ROUNDUP_CANDIDATE, category: 'regional' }).confirmed, false);
  assert.equal(decideOffBroadwayAggregatorPromotion(null).confirmed, false);
});

test('decideOffBroadwayAggregatorPromotion: "The "-prefixed canonical venues confirm even after upstream strips "the " (codebase-aware review)', () => {
  // aggregator-candidate-extract.js's cleanVenue() always strips a leading
  // "the " from extracted venue text, but several canonical Off-Broadway
  // venues are stored WITH it ("the shed", "the new group", ...) — a real
  // roundup for a show at one of these venues arrives here already stripped.
  const r = decideOffBroadwayAggregatorPromotion({ ...OB_ROUNDUP_CANDIDATE, venue: 'Shed' });
  assert.equal(r.confirmed, true);
  assert.match(r.reason, /canonical venue "Shed"/, 'the WRITTEN venue stays the stripped form, only the lookup is "The "-tolerant');
});

test('decideOffBroadwayAggregatorPromotion: a future-dated (bogus) articlePublishedAt does NOT confirm (codebase-aware review)', () => {
  const r = decideOffBroadwayAggregatorPromotion({
    ...OB_ROUNDUP_CANDIDATE,
    articlePublishedAt: '2099-01-01T10:00:00-04:00',
    discoveredAt: '2026-08-01T18:00:00.000Z',
  });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /precedes articlePublishedAt/);
});

test('decideOffBroadwayAggregatorPromotion: unknown/prose-garbled venue does NOT confirm (Codex P0)', () => {
  const r = decideOffBroadwayAggregatorPromotion({ ...OB_ROUNDUP_CANDIDATE, venue: 'Some Random Room Nobody Has Heard Of' });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /not in canonical Off-Broadway venue list/);
});

test('decideOffBroadwayAggregatorPromotion: null venue does NOT confirm', () => {
  assert.equal(decideOffBroadwayAggregatorPromotion({ ...OB_ROUNDUP_CANDIDATE, venue: null }).confirmed, false);
});

test('decideOffBroadwayAggregatorPromotion: venue directory unavailable refuses rather than guessing', () => {
  const r = decideOffBroadwayAggregatorPromotion(OB_ROUNDUP_CANDIDATE, { venueDirectoryAvailable: () => false });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /directory unavailable/);
});

test('decideOffBroadwayAggregatorPromotion: missing/unparseable dates do NOT confirm', () => {
  assert.equal(decideOffBroadwayAggregatorPromotion({ ...OB_ROUNDUP_CANDIDATE, articlePublishedAt: null }).confirmed, false);
  assert.equal(decideOffBroadwayAggregatorPromotion({ ...OB_ROUNDUP_CANDIDATE, articlePublishedAt: 'not-a-date' }).confirmed, false);
  assert.equal(decideOffBroadwayAggregatorPromotion({ ...OB_ROUNDUP_CANDIDATE, discoveredAt: null }).confirmed, false);
});

test('decideOffBroadwayAggregatorPromotion: a resurfaced 400+ day-old article does NOT auto-promote as open (Codex P0)', () => {
  const r = decideOffBroadwayAggregatorPromotion({
    ...OB_ROUNDUP_CANDIDATE,
    articlePublishedAt: '2024-01-01T10:00:00-04:00',
    discoveredAt: '2026-08-01T18:00:00.000Z',
  });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /stale relative to discoveredAt/);
});

// buildOffBroadwayAggregatorShowEntry (2026-08-13, second-opinion review
// finding): buildShowEntry's status:'announced'/openingDate:null defaults
// permanently hide reviews (engine.ts hideReviews) with no automated path
// forward for this class, since it deliberately skips the Playbill-OB/Lortel
// enrichment that would otherwise supply a date. This builder fixes that.
test('buildOffBroadwayAggregatorShowEntry: status open + real openingDate, unlike buildShowEntry', () => {
  const candidate = {
    title: "Rosie O'Donnell's COMMON KNOWLEDGE",
    venue: 'Daryl Roth Theatre',
    slug: 'rosie-odonnells-common-knowledge',
    source: 'bww-roundup',
    articlePublishedAt: '2026-07-31T09:29:29-04:00',
    discoveredAt: '2026-08-01T14:59:40.620Z',
    category: 'off-broadway',
  };
  const e = buildOffBroadwayAggregatorShowEntry(candidate);
  assert.equal(e.status, 'open', 'must NOT be announced — that permanently hides reviews (engine.ts)');
  assert.equal(e.openingDate, '2026-07-31');
  assert.equal(e.openingDateSource, 'aggregator-roundup');
  assert.equal(e.category, 'off-broadway');
  assert.equal(e.market, 'broadway', "unlike regional, OB stays market:'broadway'");
  assert.match(e.id, /-off-broadway-\d{4}$/);
  assert.equal(e.provisional, true);
  assert.equal(e.discoverySource, 'aggregator-roundup:bww-roundup');
});

test('buildOffBroadwayAggregatorShowEntry: unparseable date still stays visible (status open, no closed-guess)', () => {
  const e = buildOffBroadwayAggregatorShowEntry({
    title: 'A Serious Play', venue: 'MCC Theater', slug: 'a-serious-play', source: 'playbill-verdict',
    articlePublishedAt: 'not-a-date', discoveredAt: '2026-08-01',
  });
  assert.equal(e.openingDate, null);
  assert.equal(e.status, 'open', 'no staleness-based closed guess for OB — run lengths are not known like regional tryouts');
  assert.equal(e.openingDateSource, null);
});

test('stale-roundup guard: a roundup older than 90 days promotes as closed, fresh as open (2026-07-09)', () => {
  const old = buildRegionalShowEntry({ ...ROUNDUP_CANDIDATE, articlePublishedAt: '2025-05-30T10:00:00-04:00', slug: 'millions' });
  assert.equal(old.status, 'closed', 'year-old roundup = run is over');
  assert.equal(old.id, 'millions-regional-2025');
  assert.equal(old.openingDate, '2025-05-30');
  const freshDate = new Date(Date.now() - 5 * 86400000).toISOString();
  const fresh = buildRegionalShowEntry({ ...ROUNDUP_CANDIDATE, articlePublishedAt: freshDate });
  assert.equal(fresh.status, 'open', 'recent roundup = currently running');
});
