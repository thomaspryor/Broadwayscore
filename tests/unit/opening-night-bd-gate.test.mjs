import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isBrightDataAllowedForShow, SERP_BUDGET } = require('../../scripts/opening-night-poller.js');

// ── SERP_BUDGET constant ──
test('SERP_BUDGET is 12 (post-cost-reduction)', () => {
  // Guard: if someone bumps this back to 30 without doing the math, BD spend
  // will silently 2-3× again. Forces a conscious test update if raised.
  assert.equal(SERP_BUDGET, 12);
});

// ── BrightData gate: on for BW/WE ──
test('BD allowed for broadway', () => {
  assert.equal(isBrightDataAllowedForShow({ category: 'broadway' }), true);
});

test('BD allowed for west-end', () => {
  assert.equal(isBrightDataAllowedForShow({ category: 'west-end' }), true);
});

// ── BrightData gate: off for OB/OWE ──
test('BD skipped for off-broadway', () => {
  assert.equal(isBrightDataAllowedForShow({ category: 'off-broadway' }), false);
});

test('BD skipped for off-west-end', () => {
  assert.equal(isBrightDataAllowedForShow({ category: 'off-west-end' }), false);
});

// ── Conservative defaults: misclassified shows still get BD ──
test('BD allowed for null category (Schmigadoon-style misclassification safety)', () => {
  // Reason: shows occasionally ship with null category on opening day.
  // We'd rather overspend by a few dollars than silently drop SERP quality
  // for an unclassified BW/WE opening.
  assert.equal(isBrightDataAllowedForShow({ category: null }), true);
});

test('BD allowed for undefined category', () => {
  assert.equal(isBrightDataAllowedForShow({}), true);
});

test('BD allowed for empty-string category', () => {
  assert.equal(isBrightDataAllowedForShow({ category: '' }), true);
});

// ── market fallback ──
test('falls back to show.market when category missing', () => {
  assert.equal(isBrightDataAllowedForShow({ market: 'off-broadway' }), false);
  assert.equal(isBrightDataAllowedForShow({ market: 'broadway' }), true);
});

test('category takes precedence over market when both present', () => {
  // Category is the newer canonical field; market is legacy.
  // If they disagree we trust category.
  assert.equal(
    isBrightDataAllowedForShow({ category: 'broadway', market: 'off-broadway' }),
    true
  );
  assert.equal(
    isBrightDataAllowedForShow({ category: 'off-broadway', market: 'broadway' }),
    false
  );
});

// ── Null/undefined show object ──
test('null show: returns true (conservative)', () => {
  assert.equal(isBrightDataAllowedForShow(null), true);
});

test('undefined show: returns true (conservative)', () => {
  assert.equal(isBrightDataAllowedForShow(undefined), true);
});

// ── Unknown categories fall through to BD allowed ──
test('unknown category string allows BD (future-proof)', () => {
  // If a new market tag ships (e.g., "touring"), gate should NOT silently
  // drop BD — requires explicit listing in the OB/OWE exclusion.
  assert.equal(isBrightDataAllowedForShow({ category: 'touring' }), true);
  assert.equal(isBrightDataAllowedForShow({ category: 'regional' }), true);
});
