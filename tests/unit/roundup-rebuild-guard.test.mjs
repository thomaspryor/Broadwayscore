/**
 * Unit tests for shouldSkipRoundupAudit (review-guards.js)
 *
 * Session 4 (stale-flag audit) identified that isRoundupArticle setters in
 * rebuild-all-reviews.js and cleanup-known-issues.js re-flagged files where
 * clear-stale-roundup-flags.js had explicitly set isRoundupArticle=false +
 * roundupArticleClearedNote. This helper centralizes the check.
 *
 * Pattern: require() the real function, never copy logic into tests.
 *
 * Refs: Notion 34e637c5-416f-81a0-801c-e931351c07b8
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldSkipRoundupAudit } = require('../../scripts/lib/review-guards.js');

describe('shouldSkipRoundupAudit', () => {
  test('isRoundupArticle === false → skip (manually cleared)', () => {
    assert.strictEqual(
      shouldSkipRoundupAudit({ isRoundupArticle: false }),
      true,
      'clear-stale-roundup-flags.js sets isRoundupArticle=false — setter must skip'
    );
  });

  test('roundupArticleClearedNote present → skip', () => {
    assert.strictEqual(
      shouldSkipRoundupAudit({ roundupArticleClearedNote: '[2026-04-25 cleared stale isRoundupArticle]' }),
      true,
      'clear note breadcrumb is sufficient to trigger the skip'
    );
  });

  test('both false + note → skip', () => {
    assert.strictEqual(
      shouldSkipRoundupAudit({
        isRoundupArticle: false,
        roundupArticleClearedNote: '[2026-04-25 cleared]',
      }),
      true
    );
  });

  test('isRoundupArticle === true → do not skip (still flagged, setter is a no-op anyway)', () => {
    assert.strictEqual(shouldSkipRoundupAudit({ isRoundupArticle: true }), false);
  });

  test('no roundup fields → do not skip', () => {
    assert.strictEqual(shouldSkipRoundupAudit({}), false);
  });

  test('isRoundupArticle === undefined → do not skip', () => {
    assert.strictEqual(shouldSkipRoundupAudit({ isRoundupArticle: undefined }), false);
  });

  test('isRoundupArticle === null → do not skip (null is not explicit false)', () => {
    assert.strictEqual(shouldSkipRoundupAudit({ isRoundupArticle: null }), false);
  });

  test('null data → do not skip (defensive)', () => {
    assert.strictEqual(shouldSkipRoundupAudit(null), false);
    assert.strictEqual(shouldSkipRoundupAudit(undefined), false);
  });

  test('unrelated fields only → do not skip', () => {
    assert.strictEqual(
      shouldSkipRoundupAudit({ fullText: 'Some review text', wrongShow: false }),
      false
    );
  });
});
