/**
 * Unit tests for shouldSkipLockedEnrichment helper (Joe Turner postmortem P0 #2).
 *
 * Used by enrichment scripts that mutate NON-PROTECTED fields (criticName,
 * isSyndicatedDuplicate, outletId). safeWriteReview's lockedOverride only
 * protects PROTECTED_FIELDS, so non-PROTECTED writers need an explicit
 * early-return on locked files.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { shouldSkipLockedEnrichment } = require('../../scripts/lib/review-write-guard');

describe('shouldSkipLockedEnrichment', () => {
  test('locked=true → skip with reason', () => {
    const result = shouldSkipLockedEnrichment({ _locked: true, fullText: 'x' });
    assert.equal(result.skip, true);
    assert.equal(result.reason, '_locked=true');
  });

  test('locked=false → do not skip', () => {
    const result = shouldSkipLockedEnrichment({ _locked: false, fullText: 'x' });
    assert.equal(result.skip, false);
    assert.equal(result.reason, null);
  });

  test('locked field missing → do not skip', () => {
    const result = shouldSkipLockedEnrichment({ fullText: 'x' });
    assert.equal(result.skip, false);
    assert.equal(result.reason, null);
  });

  test('null existingData → do not skip', () => {
    const result = shouldSkipLockedEnrichment(null);
    assert.equal(result.skip, false);
    assert.equal(result.reason, null);
  });

  test('undefined existingData → do not skip', () => {
    const result = shouldSkipLockedEnrichment(undefined);
    assert.equal(result.skip, false);
    assert.equal(result.reason, null);
  });

  test('non-object input (string) → do not skip', () => {
    const result = shouldSkipLockedEnrichment('not an object');
    assert.equal(result.skip, false);
    assert.equal(result.reason, null);
  });

  test('truthy non-boolean _locked (string "true") → do not skip (strict comparison)', () => {
    // We use === true rather than a truthy check to avoid surprising callers
    // when _locked accidentally lands as a string in legacy data.
    const result = shouldSkipLockedEnrichment({ _locked: 'true' });
    assert.equal(result.skip, false);
  });

  test('locked file with no other fields → skip', () => {
    const result = shouldSkipLockedEnrichment({ _locked: true });
    assert.equal(result.skip, true);
  });
});
