// West End aggregator-listing auto-promotion (task #1466, the WE analogue of
// promote-regional-auto.test.mjs's OB aggregator-roundup coverage). Tests the
// REAL exported functions per CLAUDE.md §15 — no logic copies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideWestEndAggregatorPromotion, buildWestEndAggregatorShowEntry } =
  require('../../scripts/promote-we-aggregator-candidates.js');
const { findExistingMatch } = require('../../scripts/lib/candidate-dedup.js');
const {
  titleFromWetPostTitle,
  venueFromWetDescription,
  matchWestEndVenueFromSlug,
  slugToTitle,
} = require('../../scripts/lib/we-listing-discover.js');

const WE_CANDIDATE = {
  title: 'A New Play',
  venue: 'Old Vic',
  sourceUrl: 'https://www.londonboxoffice.co.uk/news/post/a-new-play-old-vic-review',
  source: 'lbo-sitemap',
  articlePublishedAt: '2026-08-10T10:00:00+01:00',
  discoveredAt: '2026-08-10T18:00:00.000Z',
  category: 'west-end',
};

test('decideWestEndAggregatorPromotion: canonical-venue candidate with fresh dates is confirmed', () => {
  const r = decideWestEndAggregatorPromotion(WE_CANDIDATE);
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'aggregator-roundup');
});

test('decideWestEndAggregatorPromotion: wet-listing source also confirms', () => {
  const r = decideWestEndAggregatorPromotion({ ...WE_CANDIDATE, source: 'wet-listing' });
  assert.equal(r.confirmed, true);
});

test('decideWestEndAggregatorPromotion: non-west-end categories never confirm', () => {
  assert.equal(decideWestEndAggregatorPromotion({ ...WE_CANDIDATE, category: 'off-west-end' }).confirmed, false);
  assert.equal(decideWestEndAggregatorPromotion({ ...WE_CANDIDATE, category: 'off-broadway' }).confirmed, false);
  assert.equal(decideWestEndAggregatorPromotion(null).confirmed, false);
});

test('decideWestEndAggregatorPromotion: null venue does NOT confirm', () => {
  const r = decideWestEndAggregatorPromotion({ ...WE_CANDIDATE, venue: null });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /null venue/);
});

// The core venue-fail case: no curated Off-West-End directory exists (unlike
// OFF_BROADWAY_VENUES for the OB path), so a non-canonical venue must ALWAYS
// refuse — this is the entire safety property the WE backstop depends on
// (live-tested 2026-08-14: RSC Stratford and National Theatre satellite
// venues both appear in the WET listing's category, and neither is West End).
test('decideWestEndAggregatorPromotion: non-canonical venue does NOT confirm (RSC Stratford, the live-caught case)', () => {
  const r = decideWestEndAggregatorPromotion({ ...WE_CANDIDATE, venue: 'RSC in Stratford-upon-Avon' });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /not a canonical West End venue/);
});

test('decideWestEndAggregatorPromotion: off-West-End venues (Barbican, Regent\'s Park) do NOT confirm', () => {
  assert.equal(decideWestEndAggregatorPromotion({ ...WE_CANDIDATE, venue: 'Barbican Theatre' }).confirmed, false);
  assert.equal(decideWestEndAggregatorPromotion({ ...WE_CANDIDATE, venue: "Regent's Park Open Air Theatre" }).confirmed, false);
});

test('decideWestEndAggregatorPromotion: missing/unparseable dates do NOT confirm', () => {
  assert.equal(decideWestEndAggregatorPromotion({ ...WE_CANDIDATE, articlePublishedAt: null }).confirmed, false);
  assert.equal(decideWestEndAggregatorPromotion({ ...WE_CANDIDATE, articlePublishedAt: 'not-a-date' }).confirmed, false);
  assert.equal(decideWestEndAggregatorPromotion({ ...WE_CANDIDATE, discoveredAt: null }).confirmed, false);
});

// This is the exact bug live-tested 2026-08-14: LBO's news-sitemap.xml
// <lastmod> reads "fresh" even for a page published over a year ago
// (verified live against a real 2025-07-11 review). If a caller ever passed
// that untrusted value straight through as articlePublishedAt, staleness
// would never trip. The date-mismatch and staleness gates below are what
// catch it — this test locks in that a stale real publish date is rejected.
test('decideWestEndAggregatorPromotion: a stale (400+ day-old) articlePublishedAt does NOT auto-promote as open', () => {
  const r = decideWestEndAggregatorPromotion({
    ...WE_CANDIDATE,
    articlePublishedAt: '2025-01-01T10:00:00+00:00',
    discoveredAt: '2026-08-10T18:00:00.000Z',
  });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /stale/);
});

test('decideWestEndAggregatorPromotion: a future-dated (bogus) articlePublishedAt does NOT confirm', () => {
  const r = decideWestEndAggregatorPromotion({
    ...WE_CANDIDATE,
    articlePublishedAt: '2099-01-01T10:00:00+00:00',
    discoveredAt: '2026-08-10T18:00:00.000Z',
  });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /precedes articlePublishedAt/);
});

test('buildWestEndAggregatorShowEntry: status open + real openingDate, category/market west-end', () => {
  const e = buildWestEndAggregatorShowEntry(WE_CANDIDATE);
  assert.equal(e.status, 'open');
  assert.equal(e.openingDate, '2026-08-10');
  assert.equal(e.openingDateSource, 'aggregator-roundup');
  assert.equal(e.category, 'west-end');
  assert.equal(e.market, 'west-end');
  assert.match(e.id, /-west-end-2026$/);
  assert.match(e.slug, /-west-end$/);
  assert.equal(e.provisional, true);
});

test('buildWestEndAggregatorShowEntry: unparseable date falls back to current year, null openingDate', () => {
  const e = buildWestEndAggregatorShowEntry({ ...WE_CANDIDATE, articlePublishedAt: 'garbage' });
  assert.equal(e.openingDate, null);
  assert.equal(e.status, 'open', 'still stays visible, unlike buildShowEntry\'s announced default');
});

// West End rep-house runs are frequently limited engagements — a roundup
// from >120 days ago is very likely a closed run, same reasoning
// buildRegionalShowEntry already applies to regional tryouts. Live-tested
// 2026-08-14: an unfiltered LBO listing crawl surfaces plenty of these.
test('buildWestEndAggregatorShowEntry: an old (>120d) roundup promotes as closed, a fresh one as open', () => {
  const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  const freshDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const old = buildWestEndAggregatorShowEntry({ ...WE_CANDIDATE, articlePublishedAt: oldDate });
  const fresh = buildWestEndAggregatorShowEntry({ ...WE_CANDIDATE, articlePublishedAt: freshDate });
  assert.equal(old.status, 'closed');
  assert.equal(fresh.status, 'open');
});

// --- lib/candidate-dedup.js: shared dedup reused directly, not re-derived ---

test('findExistingMatch: reused dedup catches an existing West End show by title+venue', () => {
  const existing = [{ id: 'hadestown-west-end-2024', title: 'Hadestown', venue: 'Lyric Theatre' }];
  const m = findExistingMatch({ title: 'Hadestown', venue: 'Lyric Theatre' }, existing);
  assert.ok(m);
  assert.equal(m.match.id, 'hadestown-west-end-2024');
});

// --- lib/we-listing-discover.js: title/venue extraction from live formats ---

test('titleFromWetPostTitle: extracts show title from the "<Title> Review(s): <subhead>" convention', () => {
  assert.equal(titleFromWetPostTitle('Death Note Reviews: an ambitious and entertaining spectacle'), 'Death Note');
  assert.equal(
    titleFromWetPostTitle('Game of Thrones: The Mad King reviews: an epic spectacle'),
    'Game of Thrones: The Mad King',
    'a colon inside the title itself must not truncate extraction'
  );
  assert.equal(titleFromWetPostTitle('Not a roundup title at all'), null);
});

test('venueFromWetDescription: extracts venue from the NewsArticle "...at <venue>, ..." convention', () => {
  assert.equal(
    venueFromWetDescription("A review round up of Alan Ayckbourn's How the Other Half Loves at the Old Vic, with critics agreeing..."),
    'Old Vic'
  );
  assert.equal(venueFromWetDescription(null), null);
  assert.equal(venueFromWetDescription('no venue preposition here'), null);
});

test('matchWestEndVenueFromSlug: extracts canonical venue + remainder from an LBO slug', () => {
  const m = matchWestEndVenueFromSlug('how-the-other-half-loves-the-old-vic');
  assert.ok(m);
  assert.equal(m.venue, 'the old vic', 'the longer "the old vic" form wins over bare "old vic"');
  assert.equal(m.remainder, 'how-the-other-half-loves');
});

test('matchWestEndVenueFromSlug: strips a redundant trailing "theatre" token from the remainder', () => {
  const m = matchWestEndVenueFromSlug('tao-of-glass-soho-place-theatre');
  assert.ok(m);
  assert.equal(m.venue, 'soho place');
  assert.equal(m.remainder, 'tao-of-glass');
});

// The two false positives caught live-testing 2026-08-14 — "arts" (a
// WEST_END_VENUES entry AND an ordinary English word) and "palace" matching
// inside "The Other Palace" / "Alexandra Palace" (real, non-West-End venues
// that happen to end in a canonical venue's name). Both MUST return null,
// not a wrong venue — a wrong match here silently mis-promotes a
// non-West-End show as West End.
test('matchWestEndVenueFromSlug: known false-positive collisions return null, not a wrong venue', () => {
  assert.equal(matchWestEndVenueFromSlug('review-heathers-the-musical-arts-at-marble-arch'), null, '"arts" (4 chars) is excluded — too generic a word to trust as a venue matcher');
  assert.equal(matchWestEndVenueFromSlug('review-space-dogs-the-other-palace'), null, '"The Other Palace" is not West End despite ending in "palace"');
  assert.equal(matchWestEndVenueFromSlug('a-christmas-carol-a-ghost-story-alexandra-palace-review'), null, '"Alexandra Palace" is not West End despite ending in "palace"');
});

// Adversarial ship-check review (2026-08-14) found a third collision class:
// "playhouse" and "cambridge" are real WEST_END_VENUES entries but are ALSO
// the names of real, non-West-End regional venues (Nottingham/Liverpool/
// Leeds Playhouse; Cambridge Arts Theatre) — excluded from slug matching
// entirely, same treatment as "arts". "national" stays matchable (National
// Theatre South Bank is a real, already-catalogued West End venue) but the
// specific non-South-Bank "National" companies are excluded.
test('matchWestEndVenueFromSlug: playhouse/cambridge are excluded (real regional venues share the name)', () => {
  assert.equal(matchWestEndVenueFromSlug('a-christmas-carol-nottingham-playhouse-review'), null);
  assert.equal(matchWestEndVenueFromSlug('review-a-play-liverpool-playhouse'), null);
  assert.equal(matchWestEndVenueFromSlug('review-a-play-cambridge-arts-theatre'), null);
});

test('matchWestEndVenueFromSlug: National Theatre South Bank still matches, but Wales/Scotland Nationals do not', () => {
  const m = matchWestEndVenueFromSlug('pride-national-theatre-dorfman');
  assert.ok(m);
  assert.equal(m.venue, 'national');
  assert.equal(matchWestEndVenueFromSlug('review-a-play-national-theatre-wales'), null);
  assert.equal(matchWestEndVenueFromSlug('review-a-play-national-theatre-scotland'), null);
});

test('matchWestEndVenueFromSlug: no canonical venue in the slug returns null', () => {
  assert.equal(matchWestEndVenueFromSlug('some-unrelated-news-article'), null);
  assert.equal(matchWestEndVenueFromSlug(''), null);
  assert.equal(matchWestEndVenueFromSlug(null), null);
});

test('slugToTitle: standard title-case, lowercase connectors except as the first word', () => {
  assert.equal(slugToTitle('how-the-other-half-loves'), 'How the Other Half Loves');
  assert.equal(slugToTitle('tao-of-glass'), 'Tao of Glass');
  assert.equal(slugToTitle('the-truth'), 'The Truth');
});
