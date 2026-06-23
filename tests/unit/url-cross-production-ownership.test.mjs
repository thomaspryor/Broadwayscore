/**
 * Unit tests for shouldTakeUrlOwnership — the cross-production URL ownership
 * decision used by gather-reviews.js when the same review URL appears under two
 * productions of the same title.
 *
 * Run: node --test tests/unit/url-cross-production-ownership.test.mjs
 *
 * Per CLAUDE.md §15 these require() the real function — no copied logic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldTakeUrlOwnership } = require('../../scripts/lib/url-cross-production.js');

describe('shouldTakeUrlOwnership', () => {
  test('re-homes only when the review year is strictly closer to this show', () => {
    // 2026 review, this=2026 revival, incumbent=2016 original → take it.
    assert.strictEqual(
      shouldTakeUrlOwnership({ reviewYear: 2026, thisYear: 2026, existingYear: 2016 }),
      true
    );
  });

  test('does NOT take an older review from the incumbent (the bug)', () => {
    // 2016 review currently under the 2016 original; a 2026 revival sweep must
    // NOT claim it. This is the Les Liaisons 2016→2026 mis-homing.
    assert.strictEqual(
      shouldTakeUrlOwnership({ reviewYear: 2016, thisYear: 2026, existingYear: 2016 }),
      false
    );
  });

  test('unknown review year never re-homes (no newest-wins)', () => {
    // The branch that caused the corruption: publishDate not yet enriched.
    assert.strictEqual(
      shouldTakeUrlOwnership({ reviewYear: null, thisYear: 2026, existingYear: 2016 }),
      false
    );
    assert.strictEqual(
      shouldTakeUrlOwnership({ reviewYear: undefined, thisYear: 2026, existingYear: 2017 }),
      false
    );
  });

  test('an exact tie never re-homes (no newest-wins on tie)', () => {
    // review 2021 is equidistant from a 2019 and a 2023 production.
    assert.strictEqual(
      shouldTakeUrlOwnership({ reviewYear: 2021, thisYear: 2023, existingYear: 2019 }),
      false
    );
    assert.strictEqual(
      shouldTakeUrlOwnership({ reviewYear: 2021, thisYear: 2019, existingYear: 2023 }),
      false
    );
  });

  test('missing any production year → false', () => {
    assert.strictEqual(shouldTakeUrlOwnership({ reviewYear: 2020, thisYear: null, existingYear: 2016 }), false);
    assert.strictEqual(shouldTakeUrlOwnership({ reviewYear: 2020, thisYear: 2020, existingYear: null }), false);
    assert.strictEqual(shouldTakeUrlOwnership({}), false);
    assert.strictEqual(shouldTakeUrlOwnership(), false);
  });

  test('newer review correctly transfers to the newer production', () => {
    // 2024 review, incumbent is a 2010 original, this is a 2024 revival → take it.
    assert.strictEqual(
      shouldTakeUrlOwnership({ reviewYear: 2024, thisYear: 2024, existingYear: 2010 }),
      true
    );
  });
});
