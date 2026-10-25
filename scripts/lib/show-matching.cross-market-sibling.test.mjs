// Regression lock for validateRoundupPageTitle's cross-market-sibling check.
//
// Background (#1652 / BRO-363): a Show Score page archived for the Broadway
// production of Two Strangers (Carry a Cake Across New York) was cached under
// the REGIONAL sibling's showId. Plain word-matching passed because
// "Two Strangers (Carry a Cake Across New York) (Broadway)" and the regional
// show's title "Two Strangers (Carry A Cake Across New York)" share every
// significant word — the standing CI gate
// (audit-aggregator-archive-integrity.js --strict) never caught it. Fixed by
// checking the page's explicit market qualifier ("(Broadway)" in the <title>,
// or a canonical URL path segment) against the showId's own category when a
// same-title sibling exists in shows.json for that other market.
//
// Self-contained fixture (no data/shows.json dependency) so it runs in the
// no-data unit-tests batch — per CLAUDE.md §15.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateRoundupPageTitle, detectPageMarketQualifier } = require('./show-matching.js');

const TWO_STRANGERS_TITLE = 'Two Strangers (Carry A Cake Across New York)';

const SHOW_SCORE_BROADWAY_HTML = `<html><head>
<title>Show Score | Two Strangers (Carry a Cake Across New York) (Broadway) NYC Reviews and Tickets</title>
<link rel="canonical" href="https://www.show-score.com/broadway-shows/two-strangers-carry-a-cake-across-new-york-broadway">
</head><body></body></html>`;

test('validateRoundupPageTitle flags a Broadway-qualified archive filed under a regional sibling showId', () => {
  const result = validateRoundupPageTitle(
    SHOW_SCORE_BROADWAY_HTML,
    TWO_STRANGERS_TITLE,
    'regional',
    ['broadway'] // sibling categories for this normalized title
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cross-market-sibling');
  assert.equal(result.pageMarketQualifier, 'broadway');
  assert.equal(result.showCategory, 'regional');
});

test('validateRoundupPageTitle is a no-op for non-regional showCategory even with a qualifying sibling (scope is regional-only)', () => {
  // A page that legitimately says "(Broadway)" for an ACTUAL Broadway
  // showId must never be flagged just because a regional sibling exists —
  // the check only ever fires when THIS show's own category is 'regional'.
  const result = validateRoundupPageTitle(
    SHOW_SCORE_BROADWAY_HTML,
    TWO_STRANGERS_TITLE,
    'broadway',
    ['regional']
  );
  assert.equal(result.ok, true);
});

test('validateRoundupPageTitle is unaffected when no same-title sibling exists (existing callers)', () => {
  const result = validateRoundupPageTitle(SHOW_SCORE_BROADWAY_HTML, TWO_STRANGERS_TITLE);
  assert.equal(result.ok, true, 'omitting showCategory/siblingCategories must preserve pre-fix behavior');
});

test('validateRoundupPageTitle does not flag a regional show when the page carries no qualifier at all', () => {
  // DTLI-style title has no market qualifier — nothing to corroborate a
  // mix-up against, even though a Broadway sibling exists.
  const dtliHtml = '<title>Two Strangers (Carry a Cake Across New York) - Did They Like It?</title>';
  const result = validateRoundupPageTitle(
    dtliHtml,
    TWO_STRANGERS_TITLE,
    'regional',
    ['broadway']
  );
  assert.equal(result.ok, true);
});

test('validateRoundupPageTitle does not flag a regional show when the qualifier matches no sibling category', () => {
  // Broadway-qualified page, but this regional show's only siblings are
  // off-west-end — the qualifier names a market with no corroborating sibling.
  const result = validateRoundupPageTitle(
    SHOW_SCORE_BROADWAY_HTML,
    TWO_STRANGERS_TITLE,
    'regional',
    ['off-west-end']
  );
  assert.equal(result.ok, true);
});

test('detectPageMarketQualifier reads off-broadway before broadway (substring overlap)', () => {
  const html = `<title>11 TO MIDNIGHT Off-Broadway Reviews | BroadwayWorld</title>`;
  assert.equal(detectPageMarketQualifier(html, '11 TO MIDNIGHT Off-Broadway Reviews | BroadwayWorld'), 'off-broadway');
});

test('detectPageMarketQualifier reads west-end / off-west-end qualifiers', () => {
  assert.equal(detectPageMarketQualifier('<title>All My Sons (West End)</title>', 'All My Sons (West End)'), 'west-end');
  assert.equal(detectPageMarketQualifier('<title>Show (Off-West End)</title>', 'Show (Off-West End)'), 'off-west-end');
});

test('detectPageMarketQualifier returns null when no qualifier is present', () => {
  const html = `<title>Two Strangers (Carry a Cake Across New York) - Did They Like It?</title>`;
  assert.equal(detectPageMarketQualifier(html, 'Two Strangers (Carry a Cake Across New York) - Did They Like It?'), null);
});
