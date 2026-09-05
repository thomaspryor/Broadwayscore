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
const { UK_SIDE_REGIONS, UK_SELF_HEAL_REGIONS, outletIsUkSideSelfHealRegion } = require('./cross-market-guard');

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


/**
 * BRO-591 follow-up: the FLAGGING guard (cross-market-guard.js) was synced to
 * UK_SIDE_REGIONS, but the CLEARING path in rebuild-all-reviews.js kept a bare
 * `region === 'london'` test. A region:'uk' outlet (New Statesman is registered
 * that way) could therefore be flagged `Cross-market: US outlet "new-statesman"
 * reviewing London show` and never clear: newstatesman.com is a .com domain so
 * isUkUrl is false, and 'uk' failed the london-only inner gate. Two real files
 * were stranded that way (john-proctor-is-the-villain-west-end-2026 and
 * romeo-and-juliet-west-end-2026), both forced to contentTier 'invalid'.
 */
describe('UK self-heal region set (BRO-591 clearing-side sync)', () => {
  it('is exactly UK_SIDE_REGIONS minus the deliberately-excluded dual', () => {
    const expected = new Set([...UK_SIDE_REGIONS].filter((r) => r !== 'dual'));
    assert.deepStrictEqual([...UK_SELF_HEAL_REGIONS].sort(), [...expected].sort());
  });

  it("includes 'uk' — the region that could not self-heal before this fix", () => {
    assert.ok(UK_SELF_HEAL_REGIONS.has('uk'));
    assert.ok(UK_SELF_HEAL_REGIONS.has('london'));
  });

  it("excludes 'dual' — those flags can be genuine other-market reviews", () => {
    assert.ok(UK_SIDE_REGIONS.has('dual'));
    assert.strictEqual(UK_SELF_HEAL_REGIONS.has('dual'), false);
  });

  it('clears a region:uk outlet on a non-UK-looking .com URL (the stranded case)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        {
          wrongProduction: true,
          wrongProductionNote: 'Cross-market: US outlet "new-statesman" reviewing London show',
          url: 'https://www.newstatesman.com/culture/theatre/2026/04/romeo-and-juliet-have-been-let-down',
        },
        // What the call site now computes for a region:'uk' outlet: isUkUrl stays
        // false (.com), but the UK-side region satisfies both gates.
        { ...baseCtx, isUkUrl: false, outletIsDualOrUk: true, outletIsLondonRegion: true }
      ),
      true
    );
  });

  it('still refuses a dual-market outlet that is not UK-URL and not UK-region', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUkDualMarket(
        {
          wrongProduction: true,
          url: 'https://observer.com/2026/04/some-review/',
        },
        { ...baseCtx, isUkUrl: false, outletIsDualOrUk: true, outletIsLondonRegion: false }
      ),
      false
    );
  });
});

describe('outletIsUkSideSelfHealRegion (the wiring BRO-591 left behind)', () => {
  it('accepts a region:uk outlet — the New Statesman case', () => {
    assert.strictEqual(
      outletIsUkSideSelfHealRegion({ 'new-statesman': 'uk' }, 'new-statesman', 'new-statesman'),
      true
    );
  });

  it('accepts a region:london outlet (unchanged behaviour)', () => {
    assert.strictEqual(
      outletIsUkSideSelfHealRegion({ guardian: 'london' }, 'guardian', 'guardian'),
      true
    );
  });

  it('rejects a dual-market outlet', () => {
    assert.strictEqual(
      outletIsUkSideSelfHealRegion({ observer: 'dual' }, 'observer', 'observer'),
      false
    );
  });

  it('rejects a US outlet', () => {
    assert.strictEqual(
      outletIsUkSideSelfHealRegion({ variety: 'us' }, 'variety', 'variety'),
      false
    );
  });

  it('finds a UK region on the RAW id when the canonical id maps elsewhere', () => {
    // The regression the plain `a || b` form would reintroduce: a truthy non-UK
    // value on the canonical key must not mask a UK value on the raw key.
    assert.strictEqual(
      outletIsUkSideSelfHealRegion({ canon: 'us', 'raw alias': 'uk' }, 'canon', 'raw alias'),
      true
    );
  });

  it('is safe on an unregistered outlet and a missing map', () => {
    assert.strictEqual(outletIsUkSideSelfHealRegion({}, 'nobody', 'nobody'), false);
    assert.strictEqual(outletIsUkSideSelfHealRegion(null, 'nobody', 'nobody'), false);
  });
});
