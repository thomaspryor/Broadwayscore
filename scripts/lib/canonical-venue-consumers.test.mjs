// BRO-243 — canonicalVenue()'s naive first-word fallback (title-match.js)
// silently collapses two unrelated venues that share a leading word ("The
// Duke on 42nd Street" and "The Public Theater" both reduce to "the").
// aggregator-candidate-extract.js's findKnownObShow already fixed this
// locally (task #1246) with venuesMatch() (aliasCanonical + exact
// normalizeVenueName comparison, no lossy fallback). This suite covers the
// generalization of that fix: venuesMatch() now lives in deduplication.js,
// and every other automated-decision consumer of the old canonicalVenue()
// equality (candidate-dedup.js's findExistingMatch, we-historical-
// corroboration.js's recordsAgree) reuses it instead of the lossy fallback.
//
// Run: node --test scripts/lib/canonical-venue-consumers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { venuesMatch, aliasCanonical } = require('./deduplication.js');
const { canonicalVenue } = require('./title-match.js');
const { findExistingMatch } = require('./candidate-dedup.js');
const { recordsAgree, isCorroborated } = require('./we-historical-corroboration.js');
const westEndVenues = require('../../data/west-end-venues.json');

test('canonicalVenue itself still collapses these to the same first word (documents the bug this suite guards against)', () => {
  assert.equal(canonicalVenue('The Duke on 42nd Street'), canonicalVenue('The Public Theater'));
  assert.equal(canonicalVenue('Prince Edward Theatre'), canonicalVenue('Prince of Wales Theatre'));
});

test('venuesMatch does not collapse unrelated venues sharing a leading word', () => {
  assert.equal(venuesMatch('The Duke on 42nd Street', 'The Public Theater'), false);
  assert.equal(venuesMatch('Prince Edward Theatre', 'Prince of Wales Theatre'), false);
  assert.equal(venuesMatch('Studio Theatre', 'Studio 54'), false);
});

test('venuesMatch still matches real spelling variants of the same venue', () => {
  assert.equal(venuesMatch('Prince Edward Theatre', 'Prince Edward Theatre'), true);
  assert.equal(venuesMatch("St. Luke's Theatre", "St. Luke's Theater"), true);
  assert.equal(venuesMatch('  Prince Edward Theatre  ', 'Prince Edward Theatre'), true);
});

test('venuesMatch still matches curated VENUE_ALIASES pairs (e.g. The New Group / Signature Center)', () => {
  assert.equal(venuesMatch('The New Group', 'Pershing Square Signature Center'), true);
  assert.ok(aliasCanonical('The New Group'));
});

test('candidate-dedup findExistingMatch: a title collision at a DIFFERENT venue sharing a leading word is not a match', () => {
  const candidate = { title: 'Some Fictional Show', venue: 'Prince of Wales Theatre' };
  const existing = [{ id: 'unrelated-show', title: 'Some Fictional Show', venue: 'Prince Edward Theatre' }];
  assert.equal(findExistingMatch(candidate, existing), null);
});

test('candidate-dedup findExistingMatch: still finds a genuine same-venue duplicate', () => {
  const candidate = { title: 'Some Fictional Show', venue: 'Prince Edward Theatre' };
  const existing = [{ id: 'real-dup', title: 'Some Fictional Show', venue: 'Prince Edward Theatre' }];
  const match = findExistingMatch(candidate, existing);
  assert.equal(match?.match.id, 'real-dup');
});

// ── HTML-entity encoding (2026-08-30) ────────────────────────────────────────
// Scraped venue strings arrive entity-encoded: Playbill returns
// "St. Ann&#039;s Warehouse" where shows.json holds "St. Ann's Warehouse".
// Neither aliasCanonical's regexes nor normalizeVenueName's punctuation
// stripping treat "&#039;" as an apostrophe, so the encoded side missed the
// VENUE_ALIASES hit the plain side made and venuesMatch returned false for the
// SAME venue — running Data Validation red on main
// (kramerfauci-st-anns-off-broadway-2026).
test('venuesMatch: an entity-encoded apostrophe matches its decoded form', () => {
  assert.equal(venuesMatch("St. Ann's Warehouse", 'St. Ann&#039;s Warehouse'), true);
  assert.equal(venuesMatch('St. Ann&#039;s Warehouse', "St. Ann's Warehouse"), true);
  assert.equal(venuesMatch('St. Ann&#039;s Warehouse', 'St. Ann&#039;s Warehouse'), true);
});

test('venuesMatch: entity decoding does NOT make genuinely different venues match', () => {
  // The decode must not WIDEN matching — these are the BRO-243 pairs this
  // suite exists to keep false.
  assert.equal(venuesMatch('The Duke on 42nd Street', 'The Public Theater'), false);
  assert.equal(venuesMatch('Prince of Wales Theatre', 'Prince Edward Theatre'), false);
  assert.equal(venuesMatch('St. Ann&#039;s Warehouse', 'The Public Theater'), false);
});

test('we-historical-corroboration recordsAgree: venue collision on a shared leading word does not count as agreement', () => {
  const a = { title: 'Some Fictional Show', venue: 'Prince of Wales Theatre', openingDate: '2024-01-01' };
  const b = { title: 'Some Fictional Show', venue: 'Prince Edward Theatre', openingDate: '2024-01-01' };
  assert.equal(recordsAgree(a, b), false);
});

test('we-historical-corroboration isCorroborated: two venue-colliding-but-unrelated sources do not falsely corroborate', () => {
  const candidate = { title: 'Some Fictional Show', venue: 'Prince of Wales Theatre', openingDate: '2024-01-01' };
  const sources = [
    { source: 'wikipedia', title: 'Some Fictional Show', venue: 'Prince Edward Theatre', openingDate: '2024-01-01' },
    { source: 'olivier-eligibility', title: 'Some Fictional Show', venue: 'Prince Edward Theatre', openingDate: '2024-01-01' },
  ];
  const result = isCorroborated(candidate, sources);
  assert.equal(result.corroborated, false);
  assert.deepEqual(result.agreeingSources, []);
});

// BRO-2544 near-miss (caught by ship-check adversarial review before merge):
// scripts/lib/venue-classification.js's normalizeVenueName() now strips a
// leading "The " too, so data/west-end-venues.json's separate "the old vic"
// entry LOOKS redundant with the plain "old vic" entry already present
// (build-ob-venues.js-generated files store pre-normalized names) — deleting
// it as "cleanup" is the natural-looking edit. It is NOT safe to delete:
// the live Next.js app does not import this Node normalizer. It goes through
// src/lib/stats/venue-match.ts's normalizeVenueKey (explicitly FROZEN,
// documented as not stripping a leading article) via
// src/lib/venue-classification.ts's exact Set.has() lookup. shows.json has
// several entries with venue:"The Old Vic" verbatim — deleting the prefixed
// entry would silently reclassify them from West End to Off-West-End on the
// live site. Keep BOTH forms in this file; only scripts/lib's own
// normalizeVenueName may safely lose the leading-"The" distinction.
test('data/west-end-venues.json keeps "the old vic" alongside "old vic" (frontend normalizer does not strip a leading "The")', () => {
  assert.ok(westEndVenues.includes('old vic'));
  assert.ok(westEndVenues.includes('the old vic'));
});

// BRO-2592 — two scripts had re-implemented their own LOCAL venuesMatch()
// using plain substring matching (na.includes(nb) || nb.includes(na)) after
// stripping "the"/"theatre"->"theater" — looser than even the old
// canonicalVenue() first-word fallback this suite guards against ("Studio"
// substring-matched "Studio 54", "Public Theater" substring-matched "The
// Public Theater Anspacher"). Both were missed by the sweep that moved every
// other automated-decision consumer onto the shared guard. Fixed by deleting
// both local copies and importing venuesMatch from deduplication.js — this
// test polices against either script re-introducing a local copy.
test('discover-show-score-urls-from-listings.js and audit-show-score-urls.js do not define a local venuesMatch (must import the shared guard)', () => {
  const require2 = createRequire(import.meta.url);
  const discoverSrc = require2('fs').readFileSync(
    require2.resolve('../discover-show-score-urls-from-listings.js'), 'utf8'
  );
  const auditSrc = require2('fs').readFileSync(
    require2.resolve('../audit-show-score-urls.js'), 'utf8'
  );
  assert.doesNotMatch(discoverSrc, /function\s+venuesMatch\s*\(/);
  assert.doesNotMatch(auditSrc, /function\s+venuesMatch\s*\(/);
  assert.match(discoverSrc, /require\(['"]\.\/lib\/deduplication['"]\)/);
  assert.match(auditSrc, /require\(['"]\.\/lib\/deduplication['"]\)/);
});

// BRO-2592 parity check on live Show Score listing data found 8 lost
// listing-venue -> show-venue matches after the swap; 7 were real gaps now
// covered by these two new VENUE_ALIASES entries (Met Opera, spit&vigor).
// Anchored full-string (Met Opera) / start-anchored (spit&vigor) per
// ship-check adversarial review, so they don't also swallow an unrelated
// venue that merely contains the same words.
test('venuesMatch: new BRO-2592 aliases match the real Show Score listing forms', () => {
  assert.equal(venuesMatch('The Metropolitan Opera', 'Metropolitan Opera House'), true);
  assert.equal(venuesMatch('Metropolitan Opera', 'Metropolitan Opera House'), true);
  assert.equal(venuesMatch("spit&vigor", "spit&vigor's Tiny Baby Blackbox Theatre"), true);
});

test('venuesMatch: new BRO-2592 aliases do not widen to swallow a distinct room sharing the same words', () => {
  assert.equal(venuesMatch('Metropolitan Opera', 'Metropolitan Opera Guild Auditorium'), false);
  assert.equal(venuesMatch('Metropolitan Opera House', 'Metropolitan Opera Guild Auditorium'), false);
});

test('venuesMatch: bare "BAM" stays unaliased — three distinct BAM stages must not collapse', () => {
  assert.equal(venuesMatch('BAM', 'BAM Harvey Theater'), false);
  assert.equal(venuesMatch('BAM', 'BAM Fisher (Fishman Space)'), false);
  assert.equal(venuesMatch('BAM Harvey Theater', 'BAM Fisher (Fishman Space)'), false);
});
