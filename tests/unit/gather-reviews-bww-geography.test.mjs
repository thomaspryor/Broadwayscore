/**
 * BRO-254 follow-up: validateBWWRoundupGeography()'s NON_LOCAL_OUTLET_IDS was
 * re-derived from the outlet-registry-to-region-map pattern inline instead of
 * using scripts/lib/outlet-region-map.js's buildOutletMaps() (the canonical
 * single source of truth). Consolidated onto it — this fixed a narrow gap:
 * outlets with market:'west-end' but no explicit region field (e.g.
 * 'matttrueman') were never treated as non-local for Broadway validation
 * under the old inline logic, since it only read the explicit region field.
 *
 * Run: node --test tests/unit/gather-reviews-bww-geography.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateBWWRoundupGeography } = require('../../scripts/gather-reviews.js');

test('a review from a London-only outlet (matttrueman, market:west-end, no explicit region) is filtered from a Broadway roundup', () => {
  // 3 reviews so the single non-local outlet (1/3 = 0.33) stays under the
  // >=0.5 "reject entire roundup" threshold and hits the per-review filter path.
  const reviews = [
    { outletId: 'nytimes', excerpt: 'a Broadway review' },
    { outletId: 'variety', excerpt: 'another Broadway review' },
    { outletId: 'matttrueman', excerpt: 'a London freelance critic review' },
  ];
  const result = validateBWWRoundupGeography(reviews, '', 'some-broadway-show-2026', false);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(r => r.outletId).sort(), ['nytimes', 'variety']);
});

test('a review from a London-only outlet (matttrueman) is NOT filtered from a West End roundup', () => {
  const reviews = [
    { outletId: 'matttrueman', excerpt: 'a London freelance critic review' },
  ];
  const result = validateBWWRoundupGeography(reviews, '', 'some-west-end-show-2026', true);
  assert.equal(result.length, 1);
});

test('an empty reviews array returns unchanged (no-op, never throws)', () => {
  assert.deepEqual(validateBWWRoundupGeography([], '', 'show-id', false), []);
});
