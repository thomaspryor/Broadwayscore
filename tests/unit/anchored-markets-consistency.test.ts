/**
 * ANCHORED_MARKETS consistency invariant (TS canonical vs JS mirror).
 *
 * Why this test exists: src/config/scoring.ts::ANCHORED_MARKETS is a
 * human-edited "source of truth" that scripts/lib/star-reliability.js
 * intentionally duplicates rather than imports (that module has zero
 * TS-side imports by design, per its own comment). Nothing enforced the
 * two stayed equal — the same drift class that TIER_WEIGHTS hit before
 * tests/unit/tier-config-consistency.test.ts was added (T4 added to one
 * side, four stale-copy sites didn't notice). A market added to one side
 * and not the other would silently under- or over-anchor scoring for an
 * entire market with no test failure anywhere.
 *
 * Run: node --test tests/unit/anchored-markets-consistency.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANCHORED_MARKETS } from '../../src/config/scoring';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ANCHORED_MARKETS: jsAnchoredMarkets, shouldUseAnchoredMode } = require('../../scripts/lib/star-reliability');

test('TS and JS ANCHORED_MARKETS canonicals agree', () => {
  const tsSet = Array.from(ANCHORED_MARKETS).sort();
  const jsSet = Array.from(jsAnchoredMarkets).sort();
  assert.deepEqual(jsSet, tsSet, 'scripts/lib/star-reliability.js ANCHORED_MARKETS must match src/config/scoring.ts ANCHORED_MARKETS');
});

test('shouldUseAnchoredMode auto-anchors every TS-side market', () => {
  Array.from(ANCHORED_MARKETS).forEach((category) => {
    assert.equal(
      shouldUseAnchoredMode({ category, envFlag: false }),
      true,
      `category=${category} is in ANCHORED_MARKETS but shouldUseAnchoredMode did not auto-anchor it`
    );
  });
});

test('shouldUseAnchoredMode does not auto-anchor a market outside ANCHORED_MARKETS', () => {
  assert.equal(
    shouldUseAnchoredMode({ category: 'regional', envFlag: false }),
    false,
    'regional is not in ANCHORED_MARKETS and should require ANCHORED_BANDS_PILOT=1'
  );
});
