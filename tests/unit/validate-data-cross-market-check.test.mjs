// TESTS-VS-DERIVED-DATA-EXEMPT: reads real reviews.json/shows.json/outlet-registry.json
// as fixture input for a pure classifier; no factual pins on review counts/scores.
/**
 * Regression test for BRO-45 (Notion 363637c5-416f-81bb-b3f6-ca7ccf03f524):
 * validate-data.js's reverse cross-market check (validateCrossMarketContamination
 * in scripts/validate-data.js, classifier in scripts/lib/cross-market-guard.js)
 * was reported to exit 1 on main because tristan-und-isolde-off-broadway-2026 (a
 * Met opera tagged category:'off-broadway') carries a review from London Tier 3
 * outlet "The Arts Desk" — which should be a non-blocking advisory/warning, never
 * a hard error. A hard error here writes the /tmp/.skip-push-core-data sentinel
 * and blocks push-core-data, and (separately) reddens the Data Validation job the
 * "Test Suite" workflow reports on.
 *
 * scripts/lib/cross-market-guard.test.mjs already covers classifyReverseCrossMarket's
 * general level matrix with synthetic inputs (including the Tier-3-London-on-Broadway
 * ADVISORY case). This file only adds the piece that matrix can't catch: whether the
 * REAL reviews.json/shows.json/outlet-registry.json entries for this specific show
 * still resolve to 'warning' — i.e. a registry edit that retiers "artsdesk" or flips
 * it isDualMarket, or a shows.json edit that reclassifies Tristan's category, would
 * silently reintroduce the CI-red regression without this test catching it. It walks
 * the SAME path validateCrossMarketContamination() does (find the review in
 * reviews.json, derive its outlet id, classify) rather than assuming the outlet id —
 * so a moved/renamed/deleted review fails the test loudly instead of vacuously passing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { classifyReverseCrossMarket } = require('../../scripts/lib/cross-market-guard.js');
const { buildOutletMaps } = require('../../scripts/lib/outlet-region-map.js');
const { isBroadwayCategory } = require('../../scripts/lib/venue-classification.js');

const ROOT = join(import.meta.dirname, '..', '..');
const SHOWS_FILE = join(ROOT, 'data/shows.json');
const REVIEWS_FILE = join(ROOT, 'data/reviews.json');
const REGISTRY_FILE = join(ROOT, 'data/outlet-registry.json');
const SHOW_ID = 'tristan-und-isolde-off-broadway-2026';
const OUTLET_DISPLAY_NAME = 'The Arts Desk';

test('BRO-45: live-data regression — Tristan/Arts Desk review classifies as WARNING, not error or skip', (t) => {
  for (const f of [SHOWS_FILE, REVIEWS_FILE, REGISTRY_FILE]) {
    if (!existsSync(f)) {
      t.skip(`${f} not present in this context (no core-data checkout) — cannot exercise the live-data path`);
      return;
    }
  }

  const showsData = JSON.parse(readFileSync(SHOWS_FILE, 'utf8'));
  const shows = showsData.shows || showsData;
  const show = shows.find((s) => s.id === SHOW_ID);
  assert.ok(show, `${SHOW_ID} not found in data/shows.json — the canary show for this regression is missing`);

  const reviewsData = JSON.parse(readFileSync(REVIEWS_FILE, 'utf8'));
  const reviews = reviewsData.reviews || reviewsData;
  const review = reviews.find((r) => r.showId === SHOW_ID && (r.outlet || '').toLowerCase() === OUTLET_DISPLAY_NAME.toLowerCase());
  assert.ok(review, `No "${OUTLET_DISPLAY_NAME}" review found for ${SHOW_ID} in data/reviews.json — the canary review for this regression is missing`);

  // Same derivation validateCrossMarketContamination() uses: outletId||outlet, lowercased.
  const oid = (review.outletId || review.outlet || '').toLowerCase();
  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
  const { outletRegionMap, dualMarket, tier12Outlets } = buildOutletMaps(reg);

  const isBroadway = isBroadwayCategory(show);
  const v = classifyReverseCrossMarket({
    region: outletRegionMap[oid],
    isDualMarket: dualMarket.has(oid),
    isTier12: tier12Outlets.has(oid),
    isBroadway,
  });

  assert.equal(v.level, 'warning',
    `${SHOW_ID} (category=${JSON.stringify(show.category)}) vs outlet "${oid}" now classifies as '${v.level}', not 'warning' `
    + `(${v.reason}) — this is the BRO-45 regression: check outlet-registry.json tier/region/isDualMarket for `
    + `"${oid}" and shows.json category for "${SHOW_ID}"`);
});
