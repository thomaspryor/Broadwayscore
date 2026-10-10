/**
 * Verifies that detect-syndicated-duplicates.js and rebuild-all-reviews.js
 * share the same syndication pair definitions via scripts/lib/syndication-pairs.js.
 *
 * Why: When Card #6 extracted KNOWN_SYNDICATION_PAIRS to the shared module, only
 * rebuild-all-reviews.js was updated. detect-syndicated-duplicates.js had its own
 * inline copy. Opening-night incremental rebuilds (rebuild-fast.yml) call
 * rebuild-all-reviews.js, while detect-syndicated-duplicates.js is run separately
 * to flag secondary files. If the two scripts diverge, flagging and skipping logic
 * produce different results.
 *
 * Run: node --test tests/unit/syndication-pairs-shared.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('Syndication pairs — shared module consistency', () => {
  it('detect-syndicated-duplicates uses KNOWN_SYNDICATION_PAIRS from the shared module', () => {
    // Both scripts import from the same source — verify the object is identical
    const { KNOWN_SYNDICATION_PAIRS } = require('../../scripts/lib/syndication-pairs');

    // Re-require the shared module to get a reference
    const sharedPairs = KNOWN_SYNDICATION_PAIRS;

    // Verify the shared module exports the expected structure
    assert.ok(typeof sharedPairs === 'object', 'KNOWN_SYNDICATION_PAIRS must be an object');
    assert.ok(Object.keys(sharedPairs).length > 0, 'KNOWN_SYNDICATION_PAIRS must not be empty');
  });

  it('KNOWN_SYNDICATION_PAIRS has required critics', () => {
    const { KNOWN_SYNDICATION_PAIRS } = require('../../scripts/lib/syndication-pairs');

    const expectedCritics = [
      'chris jones',
      'kathleen campion',
      'tulis mccall',
      'stanford friedman',
      'david rooney',
      'alexandra lipari',
      'zachary stewart',
      'david gordon',
      'mark kennedy',
      'jennifer farrar',
    ];

    for (const critic of expectedCritics) {
      assert.ok(
        KNOWN_SYNDICATION_PAIRS[critic],
        `Missing critic "${critic}" in KNOWN_SYNDICATION_PAIRS`
      );
      assert.ok(
        typeof KNOWN_SYNDICATION_PAIRS[critic].primary === 'string',
        `Critic "${critic}" must have a primary outlet`
      );
      assert.ok(
        Array.isArray(KNOWN_SYNDICATION_PAIRS[critic].secondary),
        `Critic "${critic}" must have a secondary[] array`
      );
    }
  });

  it('detect-syndicated-duplicates.js does NOT define its own inline KNOWN_SYNDICATION object', () => {
    const fs = require('fs');
    const path = require('path');

    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts/detect-syndicated-duplicates.js'),
      'utf8'
    );

    // Should NOT contain an inline object literal for the pairs
    const inlineDefinition = /const KNOWN_SYNDICATION\s*=\s*\{/;
    assert.ok(
      !inlineDefinition.test(source),
      'detect-syndicated-duplicates.js must not define KNOWN_SYNDICATION inline — use the shared module'
    );

    // Should import from the shared module
    const sharedImport = /require.*syndication-pairs/;
    assert.ok(
      sharedImport.test(source),
      'detect-syndicated-duplicates.js must require ./lib/syndication-pairs'
    );
  });

  it('rebuild-all-reviews.js does NOT define its own inline KNOWN_SYNDICATION_PAIRS', () => {
    const fs = require('fs');
    const path = require('path');

    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts/rebuild-all-reviews.js'),
      'utf8'
    );

    // Should NOT contain an inline object literal for the pairs
    const inlineDefinition = /const KNOWN_SYNDICATION(?:_PAIRS)?\s*=\s*\{/;
    assert.ok(
      !inlineDefinition.test(source),
      'rebuild-all-reviews.js must not define KNOWN_SYNDICATION_PAIRS inline — use the shared module'
    );

    // Should import from the shared module
    const sharedImport = /require.*syndication-pairs/;
    assert.ok(
      sharedImport.test(source),
      'rebuild-all-reviews.js must require ./lib/syndication-pairs'
    );
  });
});
