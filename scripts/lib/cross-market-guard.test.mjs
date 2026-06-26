import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyReverseCrossMarket, classifyCrossMarketContamination } = require('./cross-market-guard.js');

const D = (s) => new Date(s + 'T00:00:00Z');

test('isDualMarket outlet is always skipped (legit by definition)', () => {
  // guardian/FT/telegraph: London Tier 1 but isDualMarket — must not flag on Broadway.
  assert.equal(
    classifyReverseCrossMarket({ region: 'london', isDualMarket: true, isTier12: true, isBroadway: true }).level,
    'skip'
  );
  assert.equal(
    classifyReverseCrossMarket({ region: 'london', isDualMarket: true, isTier12: false, isBroadway: false }).level,
    'skip'
  );
});

test('non-London outlet is skipped regardless of category/tier', () => {
  assert.equal(
    classifyReverseCrossMarket({ region: 'us', isDualMarket: false, isTier12: false, isBroadway: true }).level,
    'skip'
  );
  assert.equal(
    classifyReverseCrossMarket({ region: null, isDualMarket: false, isTier12: true, isBroadway: true }).level,
    'skip'
  );
});

test('Tier 3 London outlet on Broadway is ADVISORY, not error (the plays-to-see / Arts Desk class)', () => {
  // This is the regression that matters: pre-2026-06-15 this returned a hard error
  // and turned CI red. It must now be advisory so it does not block the build.
  const v = classifyReverseCrossMarket({ region: 'london', isDualMarket: false, isTier12: false, isBroadway: true });
  assert.equal(v.level, 'advisory');
  assert.match(v.reason, /isDualMarket candidate/);
});

test('untiered London outlet on Broadway is advisory (isTier12 false covers tier null)', () => {
  assert.equal(
    classifyReverseCrossMarket({ region: 'london', isDualMarket: false, isTier12: false, isBroadway: true }).level,
    'advisory'
  );
});

test('Tier 1/2 London prestige outlet on Broadway is a hard ERROR (genuine contamination)', () => {
  // Evening Standard / Times UK never legitimately cover mainstage Broadway.
  const v = classifyReverseCrossMarket({ region: 'london', isDualMarket: false, isTier12: true, isBroadway: true });
  assert.equal(v.level, 'error');
});

test('London outlet on off-Broadway/other is a tolerated WARNING (opera transmissions, transfers)', () => {
  // The Arts Desk reviewing a Met opera cinema transmission (off-Broadway category).
  assert.equal(
    classifyReverseCrossMarket({ region: 'london', isDualMarket: false, isTier12: false, isBroadway: false }).level,
    'warning'
  );
  // Even a Tier 1/2 London outlet on off-Broadway is only a warning, not an error.
  assert.equal(
    classifyReverseCrossMarket({ region: 'london', isDualMarket: false, isTier12: true, isBroadway: false }).level,
    'warning'
  );
});

// ─── classifyCrossMarketContamination ───────────────────────────────────────
// Show fixtures: Delacorte/SITP R&J (off-Broadway, us, opened 2026-06-11) and its
// West End sibling (uk, opened 2026-03-31) — the #382 incident, ~72 days apart.
const DELACORTE = { opening: D('2026-06-11'), market: 'us' };
const WEST_END = { opening: D('2026-03-31'), market: 'uk' };
const SIB_WE = [{ id: 'romeo-and-juliet-west-end-2026', opening: WEST_END.opening, market: 'uk' }];
const SIB_OB = [{ id: 'romeo-and-juliet-off-broadway-2026', opening: DELACORTE.opening, market: 'us' }];

test('#382: London Tier-1 review near WE opening, on the OB show, region-corroborated → contamination', () => {
  // Evening Standard (region london, NOT dual) review dated 2026-04-01 on the Delacorte show.
  const v = classifyCrossMarketContamination({
    reviewDate: D('2026-04-01'), thisShow: DELACORTE, siblings: SIB_WE,
    outletRegion: 'london', isDualMarket: false, urlMatchesSibling: false,
  });
  assert.equal(v.level, 'contamination');
  assert.equal(v.sibId, 'romeo-and-juliet-west-end-2026');
});

test('#382: dual-market outlet (Times UK/Telegraph) near WE opening flags ONLY with url-token corroboration', () => {
  // West End sibling carries cast/venue tokens (Sadie Sink / Noah Jupe / Harold Pinter).
  const sibWithTokens = [{ ...SIB_WE[0], tokens: ['sadie-sink', 'noah-jupe', 'harold-pinter'] }];
  const base = {
    reviewDate: D('2026-03-31'), thisShow: DELACORTE, siblings: sibWithTokens,
    outletRegion: 'london', isDualMarket: true,
  };
  // Region can't disambiguate a dual-market outlet; URL without a sibling token → 'review', not 'contamination'.
  assert.equal(classifyCrossMarketContamination({ ...base, reviewUrl: 'https://www.thetimes.com/culture/romeo-juliet-b1277295' }).level, 'review');
  // URL contains a sibling cast token → contamination.
  assert.equal(classifyCrossMarketContamination({ ...base, reviewUrl: 'https://www.thetimes.com/culture/romeo-juliet-review-sadie-sink-noah-jupe-hfr8798' }).level, 'contamination');
});

test('reverse: US blog review near OB opening, on the West End show → contamination', () => {
  // one-minute-critic (us) dated 2026-06-12 (Delacorte opening) on the West End show.
  const v = classifyCrossMarketContamination({
    reviewDate: D('2026-06-12'), thisShow: WEST_END, siblings: SIB_OB,
    outletRegion: 'new-york', isDualMarket: false, urlMatchesSibling: false,
  });
  assert.equal(v.level, 'contamination');
});

test('legit: dual-market outlet reviewing the Broadway opening on its actual date → clear (not flagged)', () => {
  // Guardian reviews a Broadway show on opening day; its same-title WE sibling is months/years away.
  const v = classifyCrossMarketContamination({
    reviewDate: D('2026-06-11'), thisShow: DELACORTE, siblings: SIB_WE,
    outletRegion: 'london', isDualMarket: true, urlMatchesSibling: false,
  });
  // review is 0d from THIS show, ~72d from sibling → no date cluster with sibling → clear.
  assert.equal(v.level, 'clear');
});

test('legit: US blog London-trip review of the ACTUAL West End show → clear', () => {
  // frontmezzjunkies reviews the WE show near its opening; date clusters with THIS show, not a sibling.
  const v = classifyCrossMarketContamination({
    reviewDate: D('2026-04-02'), thisShow: WEST_END, siblings: SIB_OB,
    outletRegion: 'new-york', isDualMarket: false, urlMatchesSibling: false,
  });
  assert.equal(v.level, 'clear');
});

test('durability: a newly-discovered 3rd same-title sibling does NOT turn a legit review into contamination', () => {
  // A regional R&J opens 2026-05-20, between the two. A legit Delacorte review dated near
  // the Delacorte opening still clusters with THIS show, not the new sibling → clear.
  const sibsPlus = [
    ...SIB_WE,
    { id: 'romeo-and-juliet-regional-2026', opening: D('2026-05-20'), market: 'us' },
  ];
  const v = classifyCrossMarketContamination({
    reviewDate: D('2026-06-12'), thisShow: DELACORTE, siblings: sibsPlus,
    outletRegion: 'new-york', isDualMarket: false, urlMatchesSibling: false,
  });
  // best sibling is the regional one (23d away) but thisDiff is only 1d → no cluster-farther-from-this → clear.
  assert.equal(v.level, 'clear');
});

test('legacy >180d path preserved: tight sibling cluster + far from this show → contamination without corroboration', () => {
  const v = classifyCrossMarketContamination({
    reviewDate: D('2026-03-31'), thisShow: { opening: D('2027-01-01'), market: 'us' }, siblings: SIB_WE,
    outletRegion: null, isDualMarket: false, urlMatchesSibling: false,
  });
  assert.equal(v.level, 'contamination');
});

test('no siblings or missing dates → clear (never throws)', () => {
  assert.equal(classifyCrossMarketContamination({ reviewDate: D('2026-04-01'), thisShow: DELACORTE, siblings: [] }).level, 'clear');
  assert.equal(classifyCrossMarketContamination({ reviewDate: null, thisShow: DELACORTE, siblings: SIB_WE }).level, 'clear');
  assert.equal(classifyCrossMarketContamination({ reviewDate: D('2026-04-01'), thisShow: { opening: null, market: 'us' }, siblings: SIB_WE }).level, 'clear');
});
