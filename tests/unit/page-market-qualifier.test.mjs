// BRO-2551: which page market qualifiers contradict the show a cached
// aggregator page is filed under. Hermetic fixtures (page titles copied from
// the real cached corpus); requires the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectPageMarketSignal,
  detectPageMarketQualifier,
  decideCrossMarketConflict,
} = require('../../scripts/lib/page-market-qualifier.js');
const showMatching = require('../../scripts/lib/show-matching.js');

const page = (title, canonical) =>
  `<html><head><title>${title}</title>${canonical ? `<link rel="canonical" href="${canonical}">` : ''}</head></html>`;
const verdict = (html, showTitle, category, siblings = []) =>
  showMatching.validateRoundupPageTitle(html, showTitle, category, siblings);

const BWW_OFF = page('A STREETCAR NAMED DESIRE Off-Broadway Reviews | Broadway World',
  'https://www.broadwayworld.com/reviews/A-Streetcar-Named-Desire');
const BWW_BOILER = page('HERCULES Broadway Reviews | BroadwayWorld', 'https://www.broadwayworld.com/reviews/Hercules');
const SS_BROADWAY = page('Show Score | Cabaret (Broadway) NYC Reviews and Tickets', 'https://www.show-score.com/broadway-shows/cabaret');
const SS_PATH_ONLY = page('Show Score | Sweat NYC Reviews and Tickets', 'https://www.show-score.com/broadway-shows/sweat');
const SS_LONDON = page('Show Score | Orlando (West End) London Reviews and Tickets',
  'https://www.show-score.com/uk/london/off-west-end-shows/orlando');

test('signal strength: explicit title wording, canonical path, boilerplate', () => {
  assert.deepEqual(detectPageMarketSignal(BWW_OFF, 'A STREETCAR NAMED DESIRE Off-Broadway Reviews | Broadway World'),
    { category: 'off-broadway', strength: 'explicit' });
  assert.deepEqual(detectPageMarketSignal(SS_BROADWAY, 'Show Score | Cabaret (Broadway) NYC Reviews and Tickets'),
    { category: 'broadway', strength: 'explicit' });
  assert.deepEqual(detectPageMarketSignal(SS_PATH_ONLY, 'Show Score | Sweat NYC Reviews and Tickets'),
    { category: 'broadway', strength: 'canonical-path' });
  assert.deepEqual(detectPageMarketSignal(BWW_BOILER, 'HERCULES Broadway Reviews | BroadwayWorld'),
    { category: 'broadway', strength: 'boilerplate' });
  assert.equal(detectPageMarketSignal(page('Hamilton - Did They Like It?'), 'Hamilton - Did They Like It?'), null);
});

test('detectPageMarketQualifier keeps its category-only answer and show-matching re-exports it', () => {
  assert.equal(showMatching.detectPageMarketQualifier, detectPageMarketQualifier);
  assert.equal(detectPageMarketQualifier(BWW_OFF, 'X Off-Broadway Reviews'), 'off-broadway');
  assert.equal(detectPageMarketQualifier(BWW_BOILER, 'HERCULES Broadway Reviews | BroadwayWorld'), 'broadway');
});

// The card's case: a Broadway show resolving to a same-title Off-Broadway page.
// Failed (ok: true) before BRO-2551, when only regional shows were checked.
test('a Broadway show holding a BWW "Off-Broadway Reviews" page is rejected, sibling or not', () => {
  for (const siblings of [[], ['off-broadway']]) {
    const v = verdict(BWW_OFF, 'A Streetcar Named Desire', 'broadway', siblings);
    assert.equal(v.ok, false, JSON.stringify(v));
    assert.equal(v.reason, 'cross-market-sibling');
    assert.equal(v.pageMarketQualifier, 'off-broadway');
  }
  assert.equal(verdict(BWW_OFF, 'A Streetcar Named Desire', 'off-broadway').ok, true);
});

test('NYC pages on London / tour shows are rejected on explicit wording or Show Score URL', () => {
  assert.equal(verdict(SS_BROADWAY, 'Cabaret', 'west-end').reason, 'cross-market-sibling');
  assert.equal(verdict(SS_PATH_ONLY, 'Sweat', 'off-west-end').reason, 'cross-market-sibling');
  assert.equal(verdict(SS_BROADWAY, 'Cabaret', 'tour').reason, 'cross-market-sibling');
  assert.equal(verdict(page('Review Roundup: PUNCH Opens on Broadway'), 'Punch', 'west-end').reason, 'cross-market-sibling');
  assert.equal(verdict(BWW_OFF, 'A Streetcar Named Desire', 'west-end').reason, 'cross-market-sibling');
});

test('Off-Broadway show: only title-level "(Broadway)"/"on Broadway" counts, not the Show Score URL bucket', () => {
  assert.equal(verdict(page('Show Score | Oslo (Broadway) NYC Reviews and Tickets'), 'Oslo', 'off-broadway').ok, false);
  assert.equal(verdict(page('Review Roundup: ILLINOISE Arrives on Broadway | BroadwayWorld'), 'Illinoise', 'off-broadway').ok, false);
  // the-gin-game-2026 (2026-08-16): Off-Broadway show legitimately under /broadway-shows/.
  assert.equal(verdict(SS_PATH_ONLY, 'Sweat', 'off-broadway', ['broadway']).ok, true);
});

test('measured false-positive shapes stay accepted', () => {
  // BWW/Playbill "Broadway Reviews" is page-type boilerplate for every market.
  assert.equal(verdict(BWW_BOILER, 'Hercules', 'west-end', ['broadway']).ok, true);
  assert.equal(verdict(BWW_BOILER, 'Hercules', 'off-broadway', ['broadway']).ok, true);
  assert.equal(verdict(page('Read the Broadway Reviews for Death Becomes Her | Playbill'), 'Death Becomes Her', 'tour', ['broadway']).ok, true);
  // Show Score labels every London show "(West End)".
  assert.equal(verdict(SS_LONDON, 'Orlando', 'off-west-end', ['west-end']).ok, true);
  // No measured poisoned example: not added.
  assert.equal(verdict(SS_LONDON, 'Orlando', 'broadway', ['west-end']).ok, true);
});

test('regional keeps the original rule: any qualifier, only with a same-title sibling there', () => {
  assert.deepEqual(decideCrossMarketConflict({ showCategory: 'regional', siblingCategories: ['broadway'],
    signal: { category: 'broadway', strength: 'boilerplate' } }), { rule: 'regional-sibling' });
  assert.equal(decideCrossMarketConflict({ showCategory: 'regional', siblingCategories: [],
    signal: { category: 'broadway', strength: 'explicit' } }), null);
  assert.equal(decideCrossMarketConflict({ showCategory: 'regional', siblingCategories: [],
    signal: { category: 'off-broadway', strength: 'explicit' } }), null);
});

test('no category or no signal: no conflict (single-show callers unchanged)', () => {
  assert.equal(decideCrossMarketConflict({ signal: { category: 'off-broadway', strength: 'explicit' } }), null);
  assert.equal(decideCrossMarketConflict({ showCategory: 'broadway', signal: null }), null);
  assert.equal(verdict(BWW_OFF, 'A Streetcar Named Desire').ok, true);
});

test('BWW TheaterEvent Broadway locations reject wrong productions', () => {
  for (const [title, venue, category] of [
    ['A View from the Bridge', 'Lyceum Theatre (Broadway)', 'off-broadway'],
    ['August: Osage County', 'Music Box Theatre (Broadway)', 'west-end'],
    ['Example', 'Example Theatre (Broadway)', 'off-west-end'],
    ['Example', 'Example Theatre (Broadway)', 'tour'],
  ]) {
    const html = page(`${title} Broadway Reviews | BroadwayWorld`) +
      `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'TheaterEvent', location: { name: venue } }] })}</script>`;
    const signal = detectPageMarketSignal(html, `${title} Broadway Reviews | BroadwayWorld`);
    assert.deepEqual(signal, { category: 'broadway', strength: 'jsonld-location' });
    assert.deepEqual(decideCrossMarketConflict({ showCategory: category, signal }), { rule: 'measured-pair' });
    assert.equal(verdict(html, title, category).reason, 'cross-market-sibling');
  }
});

test('unrelated or invalid structured data does not establish a Broadway location', () => {
  const title = 'Example Broadway Reviews | BroadwayWorld';
  for (const json of [
    '{bad json',
    JSON.stringify({ '@type': 'Review', location: { name: 'Lyceum Theatre (Broadway)' } }),
    JSON.stringify({ '@type': 'TheaterEvent', location: { name: 'New York Theatre Workshop' }, description: 'Lyceum Theatre (Broadway)' }),
  ]) {
    assert.equal(detectPageMarketSignal(page(title) + `<script type="application/ld+json">${json}</script>`, title).strength, 'boilerplate');
  }
});
