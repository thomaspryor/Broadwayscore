/**
 * Unit tests for shouldAutoClearWrongProductionUkDualMarket in
 * scripts/lib/wrong-production-autoclear.js — the UK/dual-market outlet
 * auto-clear path (rebuild-all-reviews.js:2464-2534 prior to task #1189's
 * extraction). This was the largest wrongProduction auto-clear path but,
 * unlike the other 3 named predicates in this module, was never extracted
 * into a named, unit-testable predicate — leaving it invisible to
 * scoring-delta.js's mandated inclusion replay (CLAUDE.md rule 12.7).
 *
 * Run: node --test scripts/lib/wrong-production-autoclear-uk-dual-market.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldAutoClearWrongProductionUkDualMarket } = require('./wrong-production-autoclear');

const baseCtx = {
  isLondonMarketShow: true,
  isUkUrl: true,
  outletIsDualOrUk: false,
  outletIsLondonRegion: false,
  isDateMismatch: false,
  isShowListingUrl: false,
  cvBlocksClear: false,
};

describe('shouldAutoClearWrongProductionUkDualMarket', () => {
  it('returns false when wrongProduction is not true', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket({ url: 'https://timeout.com/london/x' }, baseCtx),
      false
    );
  });

  it('returns false when wrongProductionOverride is set', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        { wrongProduction: true, wrongProductionOverride: true, url: 'https://timeout.com/london/x' },
        baseCtx
      ),
      false
    );
  });

  it('returns false when show is not London market', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        { wrongProduction: true, url: 'https://timeout.com/london/x' },
        { ...baseCtx, isLondonMarketShow: false }
      ),
      false
    );
  });

  it('returns false when data.url is missing', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket({ wrongProduction: true }, baseCtx),
      false
    );
  });

  it('returns true for a UK URL with no blockers (isUkUrl alone satisfies both gates)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        { wrongProduction: true, url: 'https://timeout.com/london/x' },
        baseCtx
      ),
      true
    );
  });

  for (const note of [
    'Same URL exists elsewhere',
    'Pre-opening guard: review predates show',
    'flagged 120 days before show opened',
    'URL contains year 2019',
  ]) {
    it(`returns false for structural flag note: "${note}"`, () => {
      assert.strictEqual(
        shouldAutoClearWrongProductionUkDualMarket(
          { wrongProduction: true, wrongProductionNote: note, url: 'https://timeout.com/london/x' },
          baseCtx
        ),
        false
      );
    });
  }

  it('returns false when isDateMismatch (review predates show by > PRE_WINDOW_DAYS)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        { wrongProduction: true, url: 'https://timeout.com/london/x' },
        { ...baseCtx, isDateMismatch: true }
      ),
      false
    );
  });

  it('returns false when neither isUkUrl nor outletIsDualOrUk (outer gate)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        { wrongProduction: true, url: 'https://nytimes.com/x' },
        { ...baseCtx, isUkUrl: false, outletIsDualOrUk: false }
      ),
      false
    );
  });

  it('returns false when outletIsDualOrUk but NOT isUkUrl and NOT outletIsLondonRegion (inner gate)', () => {
    // Mirrors the inline comment: dual-market outlets alone are not enough —
    // their flags can be genuine same-title other-market reviews.
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        { wrongProduction: true, url: 'https://broadwayworld.com/article/x' },
        { ...baseCtx, isUkUrl: false, outletIsDualOrUk: true, outletIsLondonRegion: false }
      ),
      false
    );
  });

  it('returns true when outletIsDualOrUk AND outletIsLondonRegion, even without isUkUrl', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        { wrongProduction: true, url: 'https://broadwayworld.com/article/x' },
        { ...baseCtx, isUkUrl: false, outletIsDualOrUk: true, outletIsLondonRegion: true }
      ),
      true
    );
  });

  it('returns false when cvBlocksClear is true', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        { wrongProduction: true, url: 'https://timeout.com/london/x' },
        { ...baseCtx, cvBlocksClear: true }
      ),
      false
    );
  });

  it('returns false when wrongProductionReason is set (manual/audit reason)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        {
          wrongProduction: true,
          wrongProductionReason: 'audit-driven: cross-market contamination',
          url: 'https://timeout.com/london/x',
        },
        baseCtx
      ),
      false
    );
  });

  it('returns false when isShowListingUrl is true', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        { wrongProduction: true, url: 'https://whatsonstage.com/shows/x' },
        { ...baseCtx, isShowListingUrl: true }
      ),
      false
    );
  });
});
