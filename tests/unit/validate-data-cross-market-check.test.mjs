// TESTS-VS-DERIVED-DATA-EXEMPT: reads real outlet-registry.json/shows.json as
// fixture input for a pure classifier; no factual pins on review counts/scores.
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
 * general level matrix with synthetic inputs (including the exact "Tier 3 London
 * outlet on Broadway is ADVISORY" case). This file adds the piece that matrix can't
 * catch: whether the REAL outlet-registry.json + shows.json entries for this specific
 * show/outlet pair still resolve to the non-error levels the classifier promises —
 * i.e. a registry edit that retiers "artsdesk" to Tier 1/2, or a shows.json edit that
 * reclassifies Tristan's category to 'broadway'/null, would silently reintroduce the
 * CI-red regression without this test catching it.
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
const REGISTRY_FILE = join(ROOT, 'data/outlet-registry.json');
const SHOW_ID = 'tristan-und-isolde-off-broadway-2026';
const OUTLET_ID = 'artsdesk';

test('BRO-45: pure classifier — Tier 3 London outlet on an off-Broadway opera is a WARNING, never an error', () => {
  // Same shape validateCrossMarketContamination() feeds the classifier for a
  // London-Tier-3, non-dual-market outlet on a category:'off-broadway' show.
  const v = classifyReverseCrossMarket({
    region: 'london',
    isDualMarket: false,
    isTier12: false,
    isBroadway: false,
  });
  assert.equal(v.level, 'warning', `expected non-blocking warning, got '${v.level}': ${v.reason}`);
});

test('BRO-45: live-data regression — the actual Tristan/Arts Desk pair resolves to a non-error level', (t) => {
  if (!existsSync(SHOWS_FILE) || !existsSync(REGISTRY_FILE)) {
    t.skip('data/shows.json or data/outlet-registry.json not present in this context');
    return;
  }

  const showsData = JSON.parse(readFileSync(SHOWS_FILE, 'utf8'));
  const shows = showsData.shows || showsData;
  const show = shows.find((s) => s.id === SHOW_ID);
  if (!show) {
    t.skip(`${SHOW_ID} not present in data/shows.json — nothing to regression-check`);
    return;
  }

  const reg = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
  const { outletRegionMap, dualMarket, tier12Outlets } = buildOutletMaps(reg);

  const isBroadway = isBroadwayCategory(show);
  const v = classifyReverseCrossMarket({
    region: outletRegionMap[OUTLET_ID],
    isDualMarket: dualMarket.has(OUTLET_ID),
    isTier12: tier12Outlets.has(OUTLET_ID),
    isBroadway,
  });

  assert.notEqual(v.level, 'error',
    `${SHOW_ID} (category=${JSON.stringify(show.category)}) vs outlet "${OUTLET_ID}" now classifies as 'error' `
    + `(${v.reason}) — this is the BRO-45 regression: check outlet-registry.json tier/isDualMarket for `
    + `"${OUTLET_ID}" and shows.json category for "${SHOW_ID}"`);
});
