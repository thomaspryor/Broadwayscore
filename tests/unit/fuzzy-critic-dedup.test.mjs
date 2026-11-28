/**
 * Unit tests for areSameCriticFuzzy (scripts/lib/review-guards.js) — the
 * Levenshtein-based critic-name matcher that catches typo-duplicates the
 * URL dedup + static CRITIC_CANONICAL_MAP miss.
 *
 * Audit 2026-04-24 surfaced 18 such pairs in live data (see
 * ~/Documents/claude-outputs/critic-typo-duplicates-2026-04-24.md). This
 * test locks in the behavior on the actual observed variants.
 *
 * Guardrails:
 *  - Legitimate distinct critics (edit distance >> 2) must NOT collapse.
 *  - Short names (< 6 alnum chars) must NOT collapse even at low distance —
 *    risk of merging "Li" and "Liu" or "Kim" and "Kam".
 *  - Exact matches return false (callers short-circuit exact case first).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  areSameCriticFuzzy,
  FUZZY_CRITIC_MIN_LENGTH,
  FUZZY_CRITIC_MAX_EDIT_DISTANCE,
} = require('../../scripts/lib/review-guards.js');

describe('areSameCriticFuzzy — the 18 real typo pairs from 2026-04-24 audit', () => {
  const pairs = [
    ['Isabella Biedenahrn', 'Isabella Biedenharn'],
    ['Aliya Al-Hassan', 'Aliya Al-Hussain'],
    ['Chris Nashawaty', 'Chris Nashawty'],
    ['Andrzej Lukowski', 'Andrzej Lukowsksi'],
    ['Robert Hoffler', 'Robert Hofler'],
    ['Frank Scheck', 'Frank Sheck'],
    ['Marilyn Stasio', 'Marylin Stasio'],
    ['Lovia Gayarkye', 'Lovia Gyarkye'],
    ['Sara Holdren', 'Sarah Holdren'],
    ['Brian Scott Lipon', 'Brian Scott Lipton'],
    ['Elysa Garder', 'Elysa Gardner'],
    ['Elysa Gardner', 'Elyssa Garner'],
    ['Ronni Reich', 'Ronnie Reich'],
    ['Mark Shenton', 'Mark Sheton'],
  ];

  for (const [a, b] of pairs) {
    test(`${a} ≈ ${b}`, () => {
      assert.strictEqual(areSameCriticFuzzy(a, b), true,
        `Expected fuzzy-same; this pair shipped as duplicates in live data`);
    });
  }
});

describe('areSameCriticFuzzy — legitimate distinct critics DO NOT collapse', () => {
  // These are real multi-critic cases at the same outlet. Audit output 2026-04-24
  // included all of these as "pure-miss candidates" at the URL-dedup layer — they
  // MUST pass through (edit distance is far above 2).
  const pairs = [
    ['Ben Brantley', 'Charles Isherwood'], // NYT on 13-2008
    ['Greg Evans', 'Pete Hammond'], // Deadline on 1776-2022
    ['Charles Isherwood', 'Frank Rizzo'], // Variety on 1776-2022
    ['Peter Marks', 'Frank Rizzo'], // Variety on 1776-2022
    ['A.D. Amorosi', 'Aramide Tinubu'], // Variety on A Beautiful Noise
    ['Alexis Soloski', 'Jesse Hassenger'], // Guardian on Christmas Carol
    ['Barry Gordin', 'Samuel L. Leiter'], // Theater Life on Christmas Carol
    ['Christopher Bonanos', 'Jesse Green'], // Vulture on 1984
  ];

  for (const [a, b] of pairs) {
    test(`${a} ≢ ${b}`, () => {
      assert.strictEqual(areSameCriticFuzzy(a, b), false,
        `These are distinct critics — MUST NOT collapse. Breaking this hides legitimate multi-critic coverage.`);
    });
  }
});

describe('areSameCriticFuzzy — guardrails', () => {
  test('exact matches return false (callers handle exact case separately)', () => {
    assert.strictEqual(areSameCriticFuzzy('Jesse Green', 'Jesse Green'), false);
  });

  test('case/whitespace differences still return false (would be caught by exact-match path)', () => {
    // Normalization collapses them to the same key before the Levenshtein check.
    assert.strictEqual(areSameCriticFuzzy('jesse green', 'JESSE GREEN'), false);
    assert.strictEqual(areSameCriticFuzzy('Jesse  Green', 'Jesse Green'), false);
  });

  test('short names do NOT fuzzy-match even at low edit distance', () => {
    // "Li" vs "Liu" edit distance 1 — must not collapse (risk too high).
    assert.strictEqual(areSameCriticFuzzy('Li', 'Liu'), false);
    assert.strictEqual(areSameCriticFuzzy('Kim', 'Kam'), false);
    // Same applies when both are 5 chars (below the 6-char floor)
    assert.strictEqual(areSameCriticFuzzy('Smith', 'Smiht'), false);
  });

  test('empty/null/non-string input returns false without throwing', () => {
    assert.strictEqual(areSameCriticFuzzy(null, 'Jesse Green'), false);
    assert.strictEqual(areSameCriticFuzzy('Jesse Green', null), false);
    assert.strictEqual(areSameCriticFuzzy('', ''), false);
    assert.strictEqual(areSameCriticFuzzy(undefined, undefined), false);
    assert.strictEqual(areSameCriticFuzzy(123, 'Jesse Green'), false);
    assert.strictEqual(areSameCriticFuzzy({}, 'Jesse Green'), false);
  });

  test('length-gap > FUZZY_CRITIC_MAX_EDIT_DISTANCE skipped fast (no pathological Levenshtein)', () => {
    // One very long name, one short — can't be fuzzy-same regardless of content.
    assert.strictEqual(areSameCriticFuzzy('a'.repeat(20), 'b'.repeat(10)), false);
  });

  test('constants exposed for tunability', () => {
    assert.strictEqual(typeof FUZZY_CRITIC_MIN_LENGTH, 'number');
    assert.strictEqual(typeof FUZZY_CRITIC_MAX_EDIT_DISTANCE, 'number');
    assert.strictEqual(FUZZY_CRITIC_MIN_LENGTH, 6);
    assert.strictEqual(FUZZY_CRITIC_MAX_EDIT_DISTANCE, 2);
  });
});
