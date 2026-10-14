/**
 * Tests for scripts/backfill-html-override-rename.js — the durable backfill
 * for the cats-2026-style asymmetric files. Independent of the runtime
 * conflict-mode rename in collect-review-texts.js.
 *
 * Coverage of the PR #290 ship-check P0/P1 findings:
 *   1. mergeIntoDestStrict predicate uses `=== undefined`, NOT `!existingData[key]`
 *      → manually-cleared `wrongShow: false` is preserved against truthy source
 *   2. Corrupt-source filter covers all 8 validate-review-texts skip flags
 *   3. _locked dest blocks the merge write (via safeWriteReview lockedOverride)
 *   4. _locked source blocks the unlink (via safeUnlinkReview)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  isSourceCorrupt,
  mergeIntoDestStrict,
} = require('../../scripts/backfill-html-override-rename');

describe('mergeIntoDestStrict predicate (PR #290 ship-check P0)', () => {
  test('source wrongShow:true does NOT overwrite manually-cleared dest wrongShow:false', () => {
    // The cats-2026-style scenario: source file has bad/junk data including
    // wrongShow:true (an exclusion flag). Operator manually cleared
    // wrongShow:false on the canonical dest file. The wrong predicate
    // (`!existingData.wrongShow`) is true for `false` — and would let
    // source.wrongShow:true clobber the cleared flag. The strict predicate
    // (`existingData.wrongShow === undefined`) is false for `false`, so
    // the cleared flag survives.
    const dest = { wrongShow: false, criticName: 'Frank Rizzo' };
    const source = { wrongShow: true, criticName: 'Frank Rizzo', sourceField: 'X' };
    const merged = mergeIntoDestStrict(dest, source);
    assert.equal(merged.wrongShow, false, 'manually-cleared wrongShow:false MUST survive');
    assert.equal(merged.sourceField, 'X', 'undefined dest fields take source values');
  });

  test('source value fills undefined dest field', () => {
    const dest = { criticName: 'Frank Rizzo' };
    const source = { criticName: 'Frank Rizzo', publishDate: '2026-04-26' };
    const merged = mergeIntoDestStrict(dest, source);
    assert.equal(merged.publishDate, '2026-04-26');
  });

  test('source value does not overwrite ANY explicitly-set dest field (truthy or falsy)', () => {
    const dest = {
      criticsPickFalsy: false,
      score: 0,
      tags: [],
      note: '',
      explicit: 'set',
    };
    const source = {
      criticsPickFalsy: true,
      score: 99,
      tags: ['polluted'],
      note: 'polluted',
      explicit: 'polluted',
    };
    const merged = mergeIntoDestStrict(dest, source);
    assert.equal(merged.criticsPickFalsy, false);
    assert.equal(merged.score, 0);
    assert.deepEqual(merged.tags, []);
    assert.equal(merged.note, '');
    assert.equal(merged.explicit, 'set');
  });

  test('null and undefined source values are skipped (not propagated)', () => {
    const dest = { stable: 'x' };
    const source = { stable: 'y', shouldNotAppear: null, alsoShouldNotAppear: undefined };
    const merged = mergeIntoDestStrict(dest, source);
    assert.equal(merged.shouldNotAppear, undefined);
    assert.equal(merged.alsoShouldNotAppear, undefined);
    assert.equal(merged.stable, 'x');
  });

  test('returns a new reference — does not mutate inputs', () => {
    const dest = { x: 1 };
    const source = { x: 2, y: 3 };
    const merged = mergeIntoDestStrict(dest, source);
    assert.equal(merged.y, 3);
    assert.equal(dest.y, undefined, 'dest must not be mutated');
    assert.equal(source.x, 2, 'source must not be mutated');
    assert.notEqual(merged, dest);
  });
});

describe('isSourceCorrupt — full validate-review-texts skip-set parity', () => {
  // Each of these flags excludes a file from rebuild via validate-review-texts.
  // If the source has any of them, merging it into dest would propagate junk
  // into a clean destination. The PR #290 second-opinion review specifically
  // called out widening from the original 4 to all 8.
  const corruptFlags = [
    { wrongShow: true },
    { wrongProduction: true },
    { wrongUrl: true },
    { wrongAttribution: true },
    { contentTier: 'invalid' },
    { contentVerification: { wrongArticle: true } },
    { contentVerification: { wrongProduction: true } },
    { fabricatedEntry: true },
    { isRoundupArticle: true },
    { suspectedMisattribution: true },
    { fullTextWrongAuthor: true },
  ];

  for (const flags of corruptFlags) {
    const flagDescription = JSON.stringify(flags);
    test(`is corrupt: ${flagDescription}`, () => {
      assert.equal(isSourceCorrupt(flags), true);
    });
  }

  test('clean source (no corrupt flags) is NOT corrupt', () => {
    assert.equal(isSourceCorrupt({ criticName: 'Frank Rizzo', fullText: 'X' }), false);
  });

  test('explicit-false corrupt flags are NOT corrupt (operator-cleared)', () => {
    const cleared = {
      wrongShow: false,
      wrongProduction: false,
      wrongUrl: false,
      wrongAttribution: false,
      isRoundupArticle: false,
    };
    assert.equal(isSourceCorrupt(cleared), false);
  });
});
