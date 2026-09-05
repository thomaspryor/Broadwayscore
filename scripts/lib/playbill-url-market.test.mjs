/**
 * Structural guard for isCrossMarketPlaybillUrl (BRO-2821 cache self-heal).
 *
 * Every fixture below is chosen so exactly ONE signal decides the outcome. The
 * lesson that earned that rule twice this session: a fixture that carries a
 * second corroborating signal passes unchanged when the line it names is
 * deleted, and reads as a guard while guarding nothing.
 *
 * Per CLAUDE.md rule 15 this require()s the real exported predicate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { isCrossMarketPlaybillUrl } = require_('./playbill-url-market.js');

// The six real poisoned entries, verbatim from data/playbill-urls.json on
// 2026-09-05. All six are London shows cached to New York productions.
const REAL_POISONED = [
  ['ish-off-west-end-2026', 'off-west-end', 'https://playbill.com/production/circle-jerk-off-broadway-connelly-theatre-2022'],
  ['kings-2-off-west-end-2026', 'off-west-end', 'https://playbill.com/production/richard-ii-henry-iv-off-broadway-theatre-for-a-new-audience-polonsky-shakespeare-center-2023'],
  ['keith-off-west-end-2026', 'off-west-end', 'https://playbill.com/production/lewberger-the-wizard-of-friendship-off-broadway-theatre-row-theatre-2023'],
  ['amplify-off-west-end-2026', 'off-west-end', 'https://playbill.com/production/paranormal-activity-broadway-august-wilson-theatre-2026'],
  ['meet-me-here-off-west-end-2026', 'off-west-end', 'https://playbill.com/production/two-strangers-carry-a-cake-across-new-york-broadway-longacre-theatre-2025'],
  ['babylon-off-west-end-2026', 'off-west-end', 'https://playbill.com/production/the-green-pastures-broadway-theatre-vault-0000012335'],
];

test('flags all six real poisoned cache entries', () => {
  for (const [id, category, url] of REAL_POISONED) {
    assert.equal(isCrossMarketPlaybillUrl(url, { category }), true, `${id} must be flagged`);
  }
});

test('a west-end show on a london URL is NOT flagged', () => {
  const url = 'https://playbill.com/production/cabaret-london-playhouse-theatre-2021';
  assert.equal(isCrossMarketPlaybillUrl(url, { category: 'west-end' }), false);
  assert.equal(isCrossMarketPlaybillUrl(url, { category: 'off-west-end' }), false);
});

test('a broadway show on a broadway URL is NOT flagged', () => {
  const url = 'https://playbill.com/production/hadestown-broadway-walter-kerr-theatre-2019';
  assert.equal(isCrossMarketPlaybillUrl(url, { category: 'broadway' }), false);
  assert.equal(isCrossMarketPlaybillUrl(url, { category: 'off-broadway' }), false);
});

test('a NEW YORK show cached to a LONDON URL is flagged — the mirror direction', () => {
  // Defends the second branch. Deleting `if (!isLondonShow && isLondonUrl)`
  // leaves every other test passing, because they all exercise the first.
  const url = 'https://playbill.com/production/cabaret-london-playhouse-theatre-2021';
  assert.equal(isCrossMarketPlaybillUrl(url, { category: 'broadway' }), true);
  assert.equal(isCrossMarketPlaybillUrl(url, { category: 'off-broadway' }), true);
});

test('off-west-end counts as a London market, not just west-end', () => {
  // All six real cases are off-west-end, so dropping 'off-west-end' from
  // LONDON_CATEGORIES would silently un-flag every real defect.
  const url = 'https://playbill.com/production/circle-jerk-off-broadway-connelly-theatre-2022';
  assert.equal(isCrossMarketPlaybillUrl(url, { category: 'off-west-end' }), true);
});

test('a URL carrying BOTH market markers is never flagged either way', () => {
  // "-broadway-" can appear inside a TITLE segment, so a URL with both markers
  // is evidence of nothing. Without the both-markers bail this would be called
  // cross-market for one of the two categories.
  const both = 'https://playbill.com/production/a-london-story-broadway-lyceum-theatre-2024';
  assert.equal(isCrossMarketPlaybillUrl(both, { category: 'broadway' }), false);
  assert.equal(isCrossMarketPlaybillUrl(both, { category: 'west-end' }), false);
});

test('a URL with NO market segment is never flagged', () => {
  // The 10 legacy vault URLs must stay cached — evicting them would spend SERP
  // calls to re-resolve entries that are already correct.
  const vault = 'https://playbill.com/production/the-book-of-mormon-eugene-oneill-theatre-vault-0000013715';
  for (const category of ['broadway', 'off-broadway', 'west-end', 'off-west-end']) {
    assert.equal(isCrossMarketPlaybillUrl(vault, { category }), false);
  }
});

test('a correct URL whose TITLE merely mismatches is never flagged', () => {
  // The 5 title-shape mismatches ("Doubt: A Parable" vs slug "doubt") are
  // correct URLs. This predicate must not care about titles at all.
  const url = 'https://playbill.com/production/doubt-broadway-todd-haimes-theatre-2024';
  assert.equal(isCrossMarketPlaybillUrl(url, { category: 'broadway' }), false);
});

test('missing url, missing show, or missing category never throws or flags', () => {
  assert.equal(isCrossMarketPlaybillUrl(null, { category: 'broadway' }), false);
  assert.equal(isCrossMarketPlaybillUrl('', { category: 'broadway' }), false);
  assert.equal(isCrossMarketPlaybillUrl('https://playbill.com/production/x-broadway-y-2024', null), false);
  assert.equal(isCrossMarketPlaybillUrl('https://playbill.com/production/x-broadway-y-2024', {}), false);
  assert.equal(isCrossMarketPlaybillUrl('https://playbill.com/production/x-london-y-2024', {}), true);
});

test('market detection is case-insensitive', () => {
  const upper = 'https://PLAYBILL.com/production/Circle-Jerk-OFF-BROADWAY-Connelly-Theatre-2022';
  assert.equal(isCrossMarketPlaybillUrl(upper, { category: 'off-west-end' }), true);
});
