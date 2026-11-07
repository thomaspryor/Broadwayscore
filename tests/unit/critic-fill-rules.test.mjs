import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldFillDefaultCritic } = require('../../scripts/lib/critic-fill-rules');

describe('shouldFillDefaultCritic', () => {
  test('null/undefined outlet entry → false', () => {
    assert.strictEqual(shouldFillDefaultCritic(null), false);
    assert.strictEqual(shouldFillDefaultCritic(undefined), false);
  });

  test('outlet entry without defaultCritic → false', () => {
    assert.strictEqual(shouldFillDefaultCritic({}), false);
    assert.strictEqual(shouldFillDefaultCritic({ tier: 1 }), false);
    assert.strictEqual(shouldFillDefaultCritic({ defaultCritic: null }), false);
    assert.strictEqual(shouldFillDefaultCritic({ defaultCritic: '' }), false);
  });

  test('outlet entry with defaultCritic and no multiAuthor flag → true (current behavior preserved)', () => {
    assert.strictEqual(
      shouldFillDefaultCritic({ defaultCritic: 'Don Aucoin', tier: 3 }),
      true
    );
  });

  test('outlet entry with defaultCritic and multiAuthor=false → true', () => {
    assert.strictEqual(
      shouldFillDefaultCritic({ defaultCritic: 'Don Aucoin', multiAuthor: false }),
      true
    );
  });

  test('outlet entry with defaultCritic and multiAuthor=true → false (the fix)', () => {
    // The Recs case: defaultCritic was Erin Muldoon but bylines rotate.
    assert.strictEqual(
      shouldFillDefaultCritic({ defaultCritic: 'Erin Muldoon', multiAuthor: true }),
      false
    );
  });

  test('multiAuthor=true alone (no defaultCritic) → false', () => {
    assert.strictEqual(
      shouldFillDefaultCritic({ multiAuthor: true }),
      false
    );
  });

  test('multiAuthor truthy values other than literal true → still fills (strict equality)', () => {
    // Defensive: only literal `true` suppresses. Stray truthy values (e.g., a
    // string "true" left over from a hand edit) should NOT silently change
    // behavior — they should look wrong, not pretend to work.
    assert.strictEqual(
      shouldFillDefaultCritic({ defaultCritic: 'X', multiAuthor: 'true' }),
      true
    );
    assert.strictEqual(
      shouldFillDefaultCritic({ defaultCritic: 'X', multiAuthor: 1 }),
      true
    );
  });
});
