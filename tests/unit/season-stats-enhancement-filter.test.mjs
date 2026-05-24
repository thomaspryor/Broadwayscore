// Pure-logic test for the season-stats nonprofit-vs-enhancement filter.
// The actual `getSeasonStats` in src/lib/data-commercial.ts is tightly coupled
// to JSON imports + getSeason(), so this test mirrors only the filter predicate
// from data-commercial.ts:238 verbatim and exercises it against synthetic rows.
//
// Behavior under test:
//   - designation='Nonprofit' with no productionType   → SKIP (pure nonprofit)
//   - designation='Nonprofit' + productionType='enhancement' → INCLUDE
//     (Ragtime LCT 2025: LCT shell + commercial co-producers w/ recoup outcome)
//   - designation='Tour Stop'                          → SKIP
//   - designation='Easy Winner' / 'Flop' / etc.        → INCLUDE
//
// If src/lib/data-commercial.ts:238 changes, mirror the change here.

import { test, describe } from 'node:test';
import assert from 'node:assert';

function isSkippedFromSeasonStats(data) {
  const isPureNonprofit = data.designation === 'Nonprofit' && data.productionType !== 'enhancement';
  return isPureNonprofit || data.designation === 'Tour Stop';
}

describe('getSeasonStats filter — enhancement deals stay in recoupment math', () => {
  test('pure-nonprofit (no productionType) → skipped', () => {
    assert.equal(isSkippedFromSeasonStats({ designation: 'Nonprofit' }), true);
  });

  test('Nonprofit + productionType=enhancement (Ragtime pattern) → INCLUDED', () => {
    assert.equal(isSkippedFromSeasonStats({ designation: 'Nonprofit', productionType: 'enhancement' }), false);
  });

  test('Nonprofit + productionType=original → skipped (pure nonprofit)', () => {
    assert.equal(isSkippedFromSeasonStats({ designation: 'Nonprofit', productionType: 'original' }), true);
  });

  test('Tour Stop → skipped', () => {
    assert.equal(isSkippedFromSeasonStats({ designation: 'Tour Stop' }), true);
  });

  test('Tour Stop + productionType=enhancement (hypothetical) → still skipped', () => {
    // Tour stops carry no investor capital regardless of productionType
    assert.equal(isSkippedFromSeasonStats({ designation: 'Tour Stop', productionType: 'enhancement' }), true);
  });

  test('Easy Winner → included', () => {
    assert.equal(isSkippedFromSeasonStats({ designation: 'Easy Winner' }), false);
  });

  test('Flop → included', () => {
    assert.equal(isSkippedFromSeasonStats({ designation: 'Flop' }), false);
  });

  test('TBD → included', () => {
    assert.equal(isSkippedFromSeasonStats({ designation: 'TBD' }), false);
  });
});
