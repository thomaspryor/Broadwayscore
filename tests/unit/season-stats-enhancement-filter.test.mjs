// Season-stats nonprofit-vs-enhancement filter.
//
// BRO-4623: this file used to mirror the predicate from data-commercial.ts
// "verbatim" (a copy that silently drifts, CLAUDE.md §15). The predicate now
// lives in src/lib/commercial-metrics.ts as isExcludedFromSeasonStats, which
// getSeasonStats calls, and this test imports the real function. It moved from
// tests/unit-test-manifest.txt to tests/unit-test-manifest-tsx.txt because it
// now imports TypeScript.
//
// Behavior under test:
//   - designation='Nonprofit' with no productionType   → SKIP (pure nonprofit)
//   - designation='Nonprofit' + productionType='enhancement' → INCLUDE
//     (Ragtime LCT 2025: LCT shell + commercial co-producers w/ recoup outcome)
//   - designation='Tour Stop'                          → SKIP
//   - designation='Easy Winner' / 'Flop' / etc.        → INCLUDE

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { isExcludedFromSeasonStats } = await import('../../src/lib/commercial-metrics.ts');

describe('getSeasonStats filter — enhancement deals stay in recoupment math', () => {
  test('pure-nonprofit (no productionType) → skipped', () => {
    assert.equal(isExcludedFromSeasonStats({ designation: 'Nonprofit' }), true);
  });

  test('Nonprofit + productionType=enhancement (Ragtime pattern) → INCLUDED', () => {
    assert.equal(isExcludedFromSeasonStats({ designation: 'Nonprofit', productionType: 'enhancement' }), false);
  });

  test('Nonprofit + productionType=original → skipped (pure nonprofit)', () => {
    assert.equal(isExcludedFromSeasonStats({ designation: 'Nonprofit', productionType: 'original' }), true);
  });

  test('Tour Stop → skipped', () => {
    assert.equal(isExcludedFromSeasonStats({ designation: 'Tour Stop' }), true);
  });

  test('Tour Stop + productionType=enhancement (hypothetical) → still skipped', () => {
    // Tour stops carry no investor capital regardless of productionType
    assert.equal(isExcludedFromSeasonStats({ designation: 'Tour Stop', productionType: 'enhancement' }), true);
  });

  test('Easy Winner → included', () => {
    assert.equal(isExcludedFromSeasonStats({ designation: 'Easy Winner' }), false);
  });

  test('Flop → included', () => {
    assert.equal(isExcludedFromSeasonStats({ designation: 'Flop' }), false);
  });

  test('TBD → included', () => {
    assert.equal(isExcludedFromSeasonStats({ designation: 'TBD' }), false);
  });

  test('missing designation → included (never silently dropped)', () => {
    assert.equal(isExcludedFromSeasonStats({}), false);
    assert.equal(isExcludedFromSeasonStats({ designation: null }), false);
  });
});
