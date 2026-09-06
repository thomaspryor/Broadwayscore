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
const { isCrossMarketPlaybillUrl, stripOwnTitlePrefix, OWN_TITLE_MARKET_RE } = require_('./playbill-url-market.js');

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

// ---------------------------------------------------------------------------
// BRO-2899: the market must be read off the URL MINUS the show's own title.
// Every fixture below carries a TITLE, which the fixtures above deliberately do
// not — that is what keeps the two halves of the file independent.
// ---------------------------------------------------------------------------

test('BRO-2899: a London show whose OWN TITLE contains a NY market word is not flagged on its own vault page', () => {
  // The defect: "Prince of Broadway" + the hyphen before the venue spells
  // "-broadway-", so the whole-url test read the show's own name as a New York
  // market segment and EVICTED a correct cache entry.
  const show = { title: 'Prince of Broadway', category: 'west-end', venue: 'Adelphi Theatre' };
  const url = 'https://playbill.com/production/prince-of-broadway-adelphi-theatre-vault-0000123';
  assert.equal(isCrossMarketPlaybillUrl(url, show), false);
});

test('BRO-2899: the leading "the-" Playbill keeps and normalizeTitle strips does not defeat the strip', () => {
  const show = { title: 'The Prince of Broadway', category: 'west-end', venue: 'Adelphi Theatre' };
  const url = 'https://playbill.com/production/the-prince-of-broadway-adelphi-theatre-vault-0000123';
  assert.equal(isCrossMarketPlaybillUrl(url, show), false);
});

test('BRO-2899: a market word in the VENUE still flags — the strip removes the title only', () => {
  // The real poisoned entry babylon-off-west-end-2026 is caught ONLY because
  // "Broadway Theatre" is a New York house. Narrowing to a market SEGMENT would
  // have dropped it; narrowing to "not the title" keeps it.
  const show = { title: 'Babylon', category: 'off-west-end', venue: 'Arcola Theatre' };
  const url = 'https://playbill.com/production/the-green-pastures-broadway-theatre-vault-0000012335';
  assert.equal(isCrossMarketPlaybillUrl(url, show), true);
});

test('BRO-2899: a real market segment AFTER our own market-word title still flags', () => {
  // Same show and same title word as the first fixture, one genuine segment
  // added. If the strip ate more than the title this would go false.
  const show = { title: 'Prince of Broadway', category: 'west-end', venue: 'Adelphi Theatre' };
  const url = 'https://playbill.com/production/prince-of-broadway-broadway-manhattan-theatre-club-2016';
  assert.equal(isCrossMarketPlaybillUrl(url, show), true);
});

test('BRO-2899: a market-word title does not change the verdict where it never supplied a marker', () => {
  // "1536 West End" is a real corpus title, and the tempting story about it is
  // WRONG: the predicate's London marker is "-london-", never "-west-end-", so
  // this URL never carried two markers and never hit the both-markers bail.
  // Kept as a preservation fixture — the strip must leave both verdicts alone.
  const show = { title: '1536 West End', category: 'off-west-end', venue: 'Vaudeville Theatre' };
  assert.equal(isCrossMarketPlaybillUrl('https://playbill.com/production/1536-west-end-broadway-longacre-theatre-2025', show), true);
  assert.equal(isCrossMarketPlaybillUrl('https://playbill.com/production/1536-west-end-london-vaudeville-theatre-2026', show), false);
});

test('BRO-2899: with the title stripped, a both-markers URL is decided instead of abandoned', () => {
  // THIS is the real both-markers case: the show's own title supplies "-london-"
  // and the URL also carries a genuine "-broadway-" segment, so the old code saw
  // two markers, called the URL evidence of nothing, and left a New York page
  // cached for a London show. With the title removed the only market evidence
  // left is the real segment. This is the one direction the change can newly
  // EVICT, so it is asserted explicitly rather than left to a sweep.
  const show = { title: 'A London Story', category: 'west-end', venue: 'Noel Coward Theatre' };
  const url = 'https://playbill.com/production/a-london-story-broadway-lyceum-theatre-2024';
  assert.equal(isCrossMarketPlaybillUrl(url, show), true);
  // The same URL with no title supplied still bails, so the fixture above is
  // decided by the strip and nothing else.
  assert.equal(isCrossMarketPlaybillUrl(url, { category: 'west-end' }), false);
});

test('BRO-2899: a title with NO market word never triggers a strip', () => {
  // The safety argument for the whole change: 2,925 of the 2,942 corpus titles
  // take this path and cannot be affected at all.
  assert.equal(stripOwnTitlePrefix('hadestown-broadway-walter-kerr-theatre-2019', { title: 'Hadestown' }), null);
  assert.equal(stripOwnTitlePrefix('cabaret-london-playhouse-theatre-2021', { title: 'Cabaret' }), null);
});

test('BRO-2899: the strip keeps the hyphen boundary the substring tests need', () => {
  assert.equal(
    stripOwnTitlePrefix('prince-of-broadway-adelphi-theatre-vault-0000123', { title: 'Prince of Broadway' }),
    '-adelphi-theatre-vault-0000123',
  );
  // A path that is nothing BUT the title leaves an empty remainder, not null:
  // null means "no strip applied" and would send the caller back to the whole URL.
  assert.equal(stripOwnTitlePrefix('prince-of-broadway', { title: 'Prince of Broadway' }), '');
});

test('BRO-2899: a title that only PREFIXES the path without a separator is not stripped', () => {
  // "1536" must not eat the front of "1536-west-end-..." for a show titled
  // "1536" — the remainder would start mid-word and the boundary would be lost.
  assert.equal(stripOwnTitlePrefix('1536-west-end-london-vaudeville-theatre-2026', { title: '1536' }), null);
});

test('BRO-2899: the market-word test on titles is boundary-anchored, including at the seam', () => {
  // The word must straddle the join to matter, so an anchored-at-the-end match
  // has to count; and a word merely CONTAINING a market word must not.
  assert.equal(OWN_TITLE_MARKET_RE.test('prince-of-broadway'), true);
  assert.equal(OWN_TITLE_MARKET_RE.test('1536-west-end'), true);
  assert.equal(OWN_TITLE_MARKET_RE.test('london-road'), true);
  assert.equal(OWN_TITLE_MARKET_RE.test('broadwayland'), false);
  assert.equal(OWN_TITLE_MARKET_RE.test('new-londoner'), false);
  assert.equal(OWN_TITLE_MARKET_RE.test('hadestown'), false);
});
