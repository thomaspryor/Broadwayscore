import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseSlug, areSameTitleSiblings } = require('./combined-review-utils.js');
const { buildSiblingIndex } = require('./market-routing.js');

test('baseSlug strips year and market suffixes', () => {
  assert.equal(baseSlug('the-lost-boys'), 'the-lost-boys');
  assert.equal(baseSlug('the-lost-boys-2026'), 'the-lost-boys');
  assert.equal(baseSlug('stranger-things-the-first-shadow-west-end-2023'), 'stranger-things-the-first-shadow');
  assert.equal(baseSlug('evita-off-broadway-2025'), 'evita');
});

// Regional pre-Broadway run + its Broadway transfer, same normalized title —
// the exact pair flag-combined-reviews.js incorrectly re-duplicated across
// both directories on 2026-08-15 (task #1608 CI gate incident), undoing the
// prior audit-sibling-title-misroute.js --fix reroute for this pair because
// baseSlug() doesn't strip the "-at-art-regional" market suffix, so the two
// IDs still counted as "2 different base shows" upstream of this check.
const regional = {
  id: 'two-strangers-carry-a-cake-across-new-york-at-art-regional-2025',
  title: 'Two Strangers (Carry A Cake Across New York)',
  transferredTo: 'two-strangers-bway-2025',
};
const bway = {
  id: 'two-strangers-bway-2025',
  title: 'Two Strangers (Carry a Cake Across New York)',
  transferOf: regional.id,
};
// A genuinely different show sharing a URL (issue #316: NYer joint review of
// Schmigadoon! + Lost Boys) — must NOT be treated as a sibling pair.
const schmigadoon = { id: 'schmigadoon-2026', title: 'Schmigadoon!' };
const lostBoys = { id: 'the-lost-boys-2026', title: 'The Lost Boys' };

test('areSameTitleSiblings is true for a same-title transfer pair', () => {
  const siblingIndex = buildSiblingIndex([regional, bway]);
  assert.equal(areSameTitleSiblings(regional.id, bway.id, siblingIndex), true);
  assert.equal(areSameTitleSiblings(bway.id, regional.id, siblingIndex), true);
});

test('areSameTitleSiblings is false for genuinely different shows', () => {
  const siblingIndex = buildSiblingIndex([schmigadoon, lostBoys]);
  assert.equal(areSameTitleSiblings(schmigadoon.id, lostBoys.id, siblingIndex), false);
});

test('areSameTitleSiblings is false when the show is missing from the index', () => {
  const siblingIndex = buildSiblingIndex([regional, bway]);
  assert.equal(areSameTitleSiblings('unknown-show-id', bway.id, siblingIndex), false);
});
