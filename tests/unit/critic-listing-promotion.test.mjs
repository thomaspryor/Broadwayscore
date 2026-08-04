// decideCriticListingPromotion — sibling gate for critic-listing-sourced OB
// candidates (task #995, Sprint 2 of card 3b1637c5/#987). Playbill/Lortel can
// never corroborate this source class (Lortel is dead, Playbill's OB schedule
// carries none of these shows) — see scripts/lib/ob-cross-validation.js header.
// This gate must stay self-sufficient (title + canonical venue + compatible
// dates + persisted source URL), so tests here inject the venue-directory
// dependency rather than hitting the real data/off-broadway-venues.json file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideCriticListingPromotion, isCandidateConfirmed } = require('../../scripts/lib/ob-cross-validation.js');

const BASE = {
  title: 'Brooklyn’s Bridge',
  venue: 'Irondale',
  source: 'nyt-theater',
  sourceUrl: 'https://www.newyorktheater.me/2026/08/01/august-2026-new-york-theater-openings/',
  articlePublishedAt: '2026-08-01T09:00:00.000Z',
  discoveredAt: '2026-08-01T10:15:00.000Z',
  category: 'off-broadway',
};

const knownVenue = (v) => v === 'Irondale';

test('decideCriticListingPromotion: happy path confirms via title + canonical venue + dates + sourceUrl', () => {
  const r = decideCriticListingPromotion(BASE, { isKnownVenue: knownVenue });
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'critic-listing');
});

test('decideCriticListingPromotion: null venue is rejected, not confirmed', () => {
  const r = decideCriticListingPromotion({ ...BASE, venue: null }, { isKnownVenue: knownVenue });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /null venue/);
});

test('decideCriticListingPromotion: venue absent from the canonical list is rejected', () => {
  const r = decideCriticListingPromotion({ ...BASE, venue: 'Some Random Blob' }, { isKnownVenue: knownVenue });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /not in canonical Off-Broadway venue list/);
});

test('decideCriticListingPromotion: date mismatch (discoveredAt precedes articlePublishedAt) is rejected', () => {
  const r = decideCriticListingPromotion(
    { ...BASE, articlePublishedAt: '2026-08-05T09:00:00.000Z', discoveredAt: '2026-08-01T10:15:00.000Z' },
    { isKnownVenue: knownVenue }
  );
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /date mismatch/);
});

test('decideCriticListingPromotion: date mismatch (stale archive article) is rejected', () => {
  const r = decideCriticListingPromotion(
    { ...BASE, articlePublishedAt: '2024-01-01T09:00:00.000Z', discoveredAt: '2026-08-01T10:15:00.000Z' },
    { isKnownVenue: knownVenue }
  );
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /date mismatch/);
});

test('decideCriticListingPromotion: missing sourceUrl is rejected (nothing to audit against)', () => {
  const r = decideCriticListingPromotion({ ...BASE, sourceUrl: null }, { isKnownVenue: knownVenue });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /persisted source URL/);
});

test('decideCriticListingPromotion: missing title is rejected', () => {
  const r = decideCriticListingPromotion({ ...BASE, title: '' }, { isKnownVenue: knownVenue });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /missing title/);
});

test('decideCriticListingPromotion: source-unavailable REFUSES to confirm (distinct from a venue rejection)', () => {
  const r = decideCriticListingPromotion(BASE, {
    isKnownVenue: knownVenue,
    venueDirectoryAvailable: () => false,
  });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /unavailable — refusing to confirm/);
});

test('decideCriticListingPromotion: null candidate is rejected', () => {
  assert.equal(decideCriticListingPromotion(null).confirmed, false);
});

test('decideCriticListingPromotion: does not touch isCandidateConfirmed behavior (still exported, unchanged shape)', () => {
  const r = isCandidateConfirmed({ title: 'Spring Gala 2026', venue: 'Atlantic Theater' }, { playbillEntries: [], lortelEntries: [] });
  assert.equal(r.confirmed, false);
});
