import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseSlug, areSameTitleSiblings, computeCombinedWith } = require('./combined-review-utils.js');
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

// buildSiblingIndex() (market-routing.js) drops a show from its counterpart's
// .siblings array when it has neither a -YYYY-suffixed id nor an openingDate
// — so checking only one direction is asymmetric. A newly-tracked/provisional
// show can plausibly lack both signals before enrichment fills them in.
// (code-review finding, 2026-08-15.)
const provisionalRegional = {
  id: 'some-show-not-yet-year-suffixed',
  title: 'Some Show',
  transferredTo: 'some-show-bway-2025',
};
const enrichedBway = {
  id: 'some-show-bway-2025',
  title: 'Some Show',
  transferOf: provisionalRegional.id,
  openingDate: '2025-01-01',
};
test('areSameTitleSiblings is symmetric even when one side lacks a year suffix and openingDate', () => {
  const siblingIndex = buildSiblingIndex([provisionalRegional, enrichedBway]);
  assert.equal(areSameTitleSiblings(provisionalRegional.id, enrichedBway.id, siblingIndex), true);
  assert.equal(areSameTitleSiblings(enrichedBway.id, provisionalRegional.id, siblingIndex), true);
});

// A whole-group skip ("flag nothing if ANY member isn't a mutual sibling of
// member[0]") would let the sibling pair back into each other's combinedWith
// the moment a 3rd, genuinely different show shares the same URL (e.g. a
// roundup article, or — found live in production 2026-08-15 by /ship-check's
// Codex + codebase reviewers — an over-normalized URL that collapses many
// unrelated articles onto one key, such as lightingandsoundamerica.com's
// story.asp?ID=... query string being stripped by normalizeUrl()).
// computeCombinedWith() must filter per-entry so the sibling pair is excluded
// from EACH OTHER's list while still correctly recording genuine co-occurrence
// with the 3rd show.
const roundupShow = { id: 'beaches-2026', title: 'Beaches' };
test('computeCombinedWith excludes only the sibling in a mixed 3-member group', () => {
  const siblingIndex = buildSiblingIndex([regional, bway, roundupShow]);
  const showList = [regional.id, bway.id, roundupShow.id];
  const regionalCombined = computeCombinedWith(regional.id, showList, siblingIndex);
  assert.deepEqual(regionalCombined, [roundupShow.id]);
  const bwayCombined = computeCombinedWith(bway.id, showList, siblingIndex);
  assert.deepEqual(bwayCombined, [roundupShow.id]);
  const roundupCombined = computeCombinedWith(roundupShow.id, showList, siblingIndex);
  assert.deepEqual(roundupCombined.sort(), [bway.id, regional.id].sort());
});

test('computeCombinedWith is empty when every co-occurrence is a title-sibling', () => {
  const siblingIndex = buildSiblingIndex([regional, bway]);
  const showList = [regional.id, bway.id];
  assert.deepEqual(computeCombinedWith(regional.id, showList, siblingIndex), []);
  assert.deepEqual(computeCombinedWith(bway.id, showList, siblingIndex), []);
});
