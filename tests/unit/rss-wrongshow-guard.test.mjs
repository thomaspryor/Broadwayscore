/**
 * Unit tests for the wrongShow-unknown lock in gather-reviews.js
 *
 * Tests the new isWrongShowUnknownLocked helper that prevents the variety--unknown
 * loop from the DoaS Apr 9-10 postmortem (#13). When both the existing file and
 * the incoming review have criticName === "unknown" AND the existing file is
 * flagged wrongShow, refuse to overwrite — outlet+unknown is too weak an identity
 * match to claim "same review, just a new URL."
 *
 * Helper is extracted to scripts/lib/review-guards.js so this test can require()
 * the real function (per CLAUDE.md §15).
 *
 * Refs: memory/project_doas_opening_night_issues.md issue #13
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isWrongShowUnknownLocked } = require('../../scripts/lib/review-guards.js');

describe('isWrongShowUnknownLocked', () => {
  test('existing wrongShow=true, both critics unknown → locked', () => {
    assert.strictEqual(
      isWrongShowUnknownLocked(
        { wrongShow: true, criticName: 'Unknown', url: 'https://variety.com/A' },
        { criticName: 'Unknown', url: 'https://variety.com/B' }
      ),
      true,
      'When both sides are unknown critics on a wrongShow file, must refuse the replace'
    );
  });

  test('existing wrongShow=true, incoming has named critic → NOT locked (allow upgrade)', () => {
    assert.strictEqual(
      isWrongShowUnknownLocked(
        { wrongShow: true, criticName: 'Unknown', url: 'https://variety.com/A' },
        { criticName: 'Marilyn Stasio', url: 'https://variety.com/B' }
      ),
      false,
      'Named-critic upgrade path should NOT be blocked — preserves the unknown→named upgrade behavior'
    );
  });

  test('existing wrongShow=true, existing has named critic → NOT locked', () => {
    // Existing is a real review (with named critic) flagged wrongShow.
    // Incoming with same name on a different URL should still be subject to other guards
    // (not this one — this one only fires for both-unknown case).
    assert.strictEqual(
      isWrongShowUnknownLocked(
        { wrongShow: true, criticName: 'Naveen Kumar', url: 'https://variety.com/A' },
        { criticName: 'Unknown', url: 'https://variety.com/B' }
      ),
      false
    );
  });

  test('existing NOT wrongShow → never locked', () => {
    assert.strictEqual(
      isWrongShowUnknownLocked(
        { wrongShow: false, criticName: 'Unknown', url: 'https://variety.com/A' },
        { criticName: 'Unknown', url: 'https://variety.com/B' }
      ),
      false
    );
    assert.strictEqual(
      isWrongShowUnknownLocked(
        { criticName: 'Unknown', url: 'https://variety.com/A' }, // wrongShow undefined
        { criticName: 'Unknown', url: 'https://variety.com/B' }
      ),
      false
    );
  });

  test('existing wrongProduction (not wrongShow) → not locked by THIS guard', () => {
    // wrongProduction has its own guards (S2). This helper only handles wrongShow.
    assert.strictEqual(
      isWrongShowUnknownLocked(
        { wrongProduction: true, criticName: 'Unknown', url: 'https://variety.com/A' },
        { criticName: 'Unknown', url: 'https://variety.com/B' }
      ),
      false
    );
  });

  test('null/undefined critic names treated as unknown', () => {
    assert.strictEqual(
      isWrongShowUnknownLocked(
        { wrongShow: true, criticName: null, url: 'https://variety.com/A' },
        { criticName: undefined, url: 'https://variety.com/B' }
      ),
      true
    );
  });

  test('"" empty string critic treated as unknown', () => {
    assert.strictEqual(
      isWrongShowUnknownLocked(
        { wrongShow: true, criticName: '', url: 'https://variety.com/A' },
        { criticName: '', url: 'https://variety.com/B' }
      ),
      true
    );
  });

  test('null existing or incoming → false (defensive)', () => {
    assert.strictEqual(isWrongShowUnknownLocked(null, { criticName: 'Unknown' }), false);
    assert.strictEqual(isWrongShowUnknownLocked({ wrongShow: true }, null), false);
  });

  test('case-insensitive critic comparison', () => {
    assert.strictEqual(
      isWrongShowUnknownLocked(
        { wrongShow: true, criticName: 'UNKNOWN', url: 'https://variety.com/A' },
        { criticName: 'unknown', url: 'https://variety.com/B' }
      ),
      true
    );
  });
});
