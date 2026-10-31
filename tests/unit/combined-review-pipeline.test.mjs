/**
 * combined-review pipeline — end-to-end behavior tests
 *
 * Issue #316 ship-check follow-ups (P0/C+F, P1/E):
 *
 * 1. baseSlug() collapses revival/year-suffix/market-suffix variants so
 *    flag-combined-reviews.js doesn't false-positive on cross-variant URL
 *    collisions (the-lost-boys + the-lost-boys-2026 are the SAME show).
 *
 * 2. wrongShowCleared() does NOT honor isCombinedReview alone. Without
 *    explicit wrongShowOverride:true (set by the recovery branch only when
 *    URL co-occurrence verified across 2+ base shows AND the rejection
 *    reason was wrong_show), a feature/preview article that happens to
 *    mention multiple shows could silently pass into reviews.json if its
 *    contentTier ever upgraded from 'invalid'.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseSlug } = require('../../scripts/lib/combined-review-utils');
const { wrongShowCleared } = require('../../scripts/lib/review-guards');

describe('baseSlug — collapse same-show ID variants', () => {
  test('strips trailing -YYYY', () => {
    assert.strictEqual(baseSlug('the-lost-boys'), 'the-lost-boys');
    assert.strictEqual(baseSlug('the-lost-boys-2026'), 'the-lost-boys');
    assert.strictEqual(baseSlug('schmigadoon-2026'), 'schmigadoon');
  });

  test('strips market suffix (-off-broadway, -west-end, -off-west-end, -tour)', () => {
    assert.strictEqual(baseSlug('evita-off-broadway'), 'evita');
    assert.strictEqual(baseSlug('evita-west-end'), 'evita');
    assert.strictEqual(baseSlug('evita-off-west-end'), 'evita');
    assert.strictEqual(baseSlug('hamilton-tour'), 'hamilton');
    assert.strictEqual(baseSlug('hamilton-first-national-tour'), 'hamilton');
  });

  test('strips combined market+year suffix', () => {
    // e.g. `stranger-things-the-first-shadow-west-end-2023` → year strip first,
    // then market strip
    assert.strictEqual(baseSlug('stranger-things-the-first-shadow-west-end-2023'), 'stranger-things-the-first-shadow');
    assert.strictEqual(baseSlug('cats-the-jellicle-ball-off-broadway-2024'), 'cats-the-jellicle-ball');
    assert.strictEqual(baseSlug('avenue-q-west-end-2026'), 'avenue-q');
  });

  test('does not strip year from middle of slug', () => {
    // Defensive: ensure regex is anchored to end
    assert.strictEqual(baseSlug('1984-2014'), '1984');
    assert.strictEqual(baseSlug('1984'), '1984'); // no trailing year — leave alone
  });

  test('lost-boys + lost-boys-2026 collapse to same base', () => {
    assert.strictEqual(baseSlug('the-lost-boys'), baseSlug('the-lost-boys-2026'));
  });

  test('lost-boys + schmigadoon do NOT collapse (different shows)', () => {
    assert.notStrictEqual(baseSlug('the-lost-boys-2026'), baseSlug('schmigadoon-2026'));
  });
});

describe('wrongShowCleared — explicit-override semantics', () => {
  test('returns true on wrongShowManualClear', () => {
    assert.strictEqual(wrongShowCleared({ wrongShowManualClear: true }), true);
  });

  test('returns true on wrongShowOverride', () => {
    assert.strictEqual(wrongShowCleared({ wrongShowOverride: true }), true);
  });

  test('returns true on wrongProductionManualClear', () => {
    assert.strictEqual(wrongShowCleared({ wrongProductionManualClear: true }), true);
  });

  test('returns true on humanReviewedWrongProduction === false', () => {
    assert.strictEqual(wrongShowCleared({ humanReviewedWrongProduction: false }), true);
  });

  test('isCombinedReview alone is NOT sufficient', () => {
    // Issue #316 ship-check P0/C+F: previously this returned true, which
    // would silently include feature/preview articles flagged as combined
    // via URL co-occurrence (no content verification).
    assert.strictEqual(wrongShowCleared({ isCombinedReview: true }), false);
  });

  test('isCombinedReview + wrongShowOverride together = cleared', () => {
    // The recovery branch in flag-combined-reviews.js sets BOTH flags after
    // verifying URL co-occurrence across 2+ base shows AND
    // rejectionReason='wrong_show'. That combination is what unlocks
    // inclusion.
    assert.strictEqual(wrongShowCleared({ isCombinedReview: true, wrongShowOverride: true }), true);
  });

  test('returns false on bare data / undefined', () => {
    assert.strictEqual(wrongShowCleared({}), false);
    assert.strictEqual(wrongShowCleared(null), false);
    assert.strictEqual(wrongShowCleared(undefined), false);
  });

  test('returns false on humanReviewedWrongProduction undefined (must be ===false)', () => {
    assert.strictEqual(wrongShowCleared({ humanReviewedWrongProduction: undefined }), false);
  });
});
