import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyReverseCrossMarket,
  classifyCrossMarketContamination,
  isUkVenueString,
  isUsVenueString,
  evaluateReverseLondonCrossMarketGuard,
  evaluateForwardCrossMarketGuard,
} = require('./cross-market-guard.js');

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
    outletRegion: 'london', isDualMarket: false,
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
    outletRegion: 'new-york', isDualMarket: false,
  });
  assert.equal(v.level, 'contamination');
});

test('legit: dual-market outlet reviewing the Broadway opening on its actual date → clear (not flagged)', () => {
  // Guardian reviews a Broadway show on opening day; its same-title WE sibling is months/years away.
  const v = classifyCrossMarketContamination({
    reviewDate: D('2026-06-11'), thisShow: DELACORTE, siblings: SIB_WE,
    outletRegion: 'london', isDualMarket: true,
  });
  // review is 0d from THIS show, ~72d from sibling → no date cluster with sibling → clear.
  assert.equal(v.level, 'clear');
});

test('legit: US blog London-trip review of the ACTUAL West End show → clear', () => {
  // frontmezzjunkies reviews the WE show near its opening; date clusters with THIS show, not a sibling.
  const v = classifyCrossMarketContamination({
    reviewDate: D('2026-04-02'), thisShow: WEST_END, siblings: SIB_OB,
    outletRegion: 'new-york', isDualMarket: false,
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
    outletRegion: 'new-york', isDualMarket: false,
  });
  // best sibling is the regional one (23d away) but thisDiff is only 1d → no cluster-farther-from-this → clear.
  assert.equal(v.level, 'clear');
});

test('legacy >180d path preserved: tight sibling cluster + far from this show → contamination without corroboration', () => {
  const v = classifyCrossMarketContamination({
    reviewDate: D('2026-03-31'), thisShow: { opening: D('2027-01-01'), market: 'us' }, siblings: SIB_WE,
    outletRegion: null, isDualMarket: false,
  });
  assert.equal(v.level, 'contamination');
});

test('url-token match is SLUG-BOUNDED, not substring (no FP on hollywood/marshall/theglobeandmail)', () => {
  // dual-market outlet, date-clustered with the sibling → only url-token corroboration can flag.
  const mk = (tokens, reviewUrl) => classifyCrossMarketContamination({
    reviewDate: D('2026-03-31'), thisShow: DELACORTE,
    siblings: [{ ...SIB_WE[0], tokens }], outletRegion: 'london', isDualMarket: true, reviewUrl,
  }).level;
  // token 'wood' must NOT match 'hollywood'; 'globe' must NOT match 'theglobeandmail'.
  assert.equal(mk(['wood'], 'https://www.thetimes.com/hollywood-romeo-juliet-review'), 'review');
  assert.equal(mk(['globe'], 'https://www.theglobeandmail.com/romeo-juliet-review'), 'review');
  assert.equal(mk(['sink'], 'https://x.com/romeo-juliet-sinking-feeling-review'), 'review');
  // but a properly slug-delimited token DOES match.
  assert.equal(mk(['sadie-sink'], 'https://x.com/romeo-juliet-review-sadie-sink'), 'contamination');
  assert.equal(mk(['sink'], 'https://x.com/romeo-juliet-sink-review'), 'contamination');
});

test('no siblings or missing dates → clear (never throws)', () => {
  assert.equal(classifyCrossMarketContamination({ reviewDate: D('2026-04-01'), thisShow: DELACORTE, siblings: [] }).level, 'clear');
  assert.equal(classifyCrossMarketContamination({ reviewDate: null, thisShow: DELACORTE, siblings: SIB_WE }).level, 'clear');
  assert.equal(classifyCrossMarketContamination({ reviewDate: D('2026-04-01'), thisShow: { opening: null, market: 'us' }, siblings: SIB_WE }).level, 'clear');
});

// ── classifyUsOnWeCrossMarket (forward direction: US outlet on WE show) ──────
// Error tier requires BOTH signals (US region + pre-window date) — a domain-only
// gate was rejected 2026-06-21 because NYT/Variety legitimately review the West
// End near opening. See card 386637c5.

const { classifyUsOnWeCrossMarket } = require('./cross-market-guard.js');

test('US-on-WE: dual-market and Tier 1/2 outlets are skipped (NYT/Variety review the WE)', () => {
  assert.equal(
    classifyUsOnWeCrossMarket({ region: 'us', isDualMarket: true, isTier12: false, isPreWindowDate: true }).level,
    'skip'
  );
  assert.equal(
    classifyUsOnWeCrossMarket({ region: 'us', isDualMarket: false, isTier12: true, isPreWindowDate: true }).level,
    'skip'
  );
});

test('US-on-WE: UK-side regions (london/uk/dual) are skipped', () => {
  for (const region of ['london', 'uk', 'dual']) {
    assert.equal(
      classifyUsOnWeCrossMarket({ region, isDualMarket: false, isTier12: false, isPreWindowDate: true }).level,
      'skip'
    );
  }
});

test('US-on-WE: explicit US region + pre-window date → error (blocks the build)', () => {
  // The Glengarry WE 2026 class: Broadway-2025 EW/NYDailyNews/Yahoo reviews on
  // the WE revival, dated ~a year before the WE opening.
  for (const region of ['us', 'new-york', 'chicago']) {
    const r = classifyUsOnWeCrossMarket({ region, isDualMarket: false, isTier12: false, isPreWindowDate: true });
    assert.equal(r.level, 'error');
  }
});

test('US-on-WE: US region with in-window date → warning only (legit transfer coverage)', () => {
  assert.equal(
    classifyUsOnWeCrossMarket({ region: 'us', isDualMarket: false, isTier12: false, isPreWindowDate: false }).level,
    'warning'
  );
});

test('US-on-WE: unknown region never errors, even pre-window (not enough signal)', () => {
  for (const region of [null, undefined, '']) {
    assert.equal(
      classifyUsOnWeCrossMarket({ region, isDualMarket: false, isTier12: false, isPreWindowDate: true }).level,
      'warning'
    );
  }
});

// BRO-222: isUkVenueString classifies show.priorRuns[].venue free text.
test('isUkVenueString: recognizes Fringe / West End / regional UK venue text', () => {
  assert.equal(isUkVenueString('Edinburgh Festival Fringe (Assembly)'), true);
  assert.equal(isUkVenueString('Bridge Theatre, London'), true);
  assert.equal(isUkVenueString("Audible's Minetta Lane Theatre"), false);
  assert.equal(isUkVenueString(null), false);
  assert.equal(isUkVenueString(undefined), false);
});

// Regression: bare "fringe"/"england" collide with genuine US venue text
// (FringeNYC, "New England ..." theaters) — a false match here would wrongly
// EXEMPT a real cross-market review, worse than under-matching. Caught in
// ship-check adversarial review (gpt-5.4-mini), fixed by dropping those two
// keywords from UK_VENUE_RE.
test('isUkVenueString: does NOT false-positive on US "Fringe"/"New England" venue text', () => {
  assert.equal(isUkVenueString('SoHo Playhouse (New York International Fringe Festival)'), false);
  assert.equal(isUkVenueString('New England Repertory Theatre'), false);
});

// BRO-222: the reverse cross-market guard (London outlet on a Broadway/off-
// Broadway show) previously consulted show.priorRuns nowhere at all — this is
// the guard that actually suppressed the live newsletter-show incident
// (rosie-odonnell-common-knowledge-off-broadway-2026's neurodiversereview
// review: UK outlet, published inside the declared Edinburgh Fringe run, still
// excluded as "Cross-market: London outlet reviewing off-broadway show").
test('evaluateReverseLondonCrossMarketGuard: a UK outlet on a show whose priorRun venue is UK is NOT cross-market rejected', () => {
  const priorRuns = [{ openingDate: '2025-08-01', closingDate: '2025-08-10', venue: 'Edinburgh Festival Fringe (Assembly)' }];
  const r = evaluateReverseLondonCrossMarketGuard({
    outletIsLondon: true,
    reviewDate: D('2025-08-09'), // inside the declared Fringe window
    priorRuns,
  });
  assert.equal(r.shouldFlag, false);
  assert.equal(r.exemptedByPriorRun, true);
});

test('evaluateReverseLondonCrossMarketGuard: same outlet WITHOUT priorRuns passed is still flagged (proves the fix, not a tautology)', () => {
  const r = evaluateReverseLondonCrossMarketGuard({
    outletIsLondon: true,
    reviewDate: D('2025-08-09'),
    // priorRuns omitted — mirrors current-guard-logic-before-the-fix behavior
  });
  assert.equal(r.shouldFlag, true);
  assert.equal(r.exemptedByPriorRun, false);
});

test('evaluateReverseLondonCrossMarketGuard: in-window date but a NON-UK priorRun venue is still flagged', () => {
  const priorRuns = [{ openingDate: '2025-08-01', closingDate: '2025-08-10', venue: "Audible's Minetta Lane Theatre" }];
  const r = evaluateReverseLondonCrossMarketGuard({
    outletIsLondon: true,
    reviewDate: D('2025-08-09'),
    priorRuns,
  });
  assert.equal(r.shouldFlag, true);
});

test('evaluateReverseLondonCrossMarketGuard: a date OUTSIDE the declared priorRun window is still flagged', () => {
  const priorRuns = [{ openingDate: '2025-08-01', closingDate: '2025-08-10', venue: 'Edinburgh Festival Fringe (Assembly)' }];
  const r = evaluateReverseLondonCrossMarketGuard({
    outletIsLondon: true,
    reviewDate: D('2026-06-14'), // the republished-review class — explicitly NOT covered by this fix
    priorRuns,
  });
  assert.equal(r.shouldFlag, true);
});

test('evaluateReverseLondonCrossMarketGuard: non-London outlet is never flagged regardless of priorRuns', () => {
  const r = evaluateReverseLondonCrossMarketGuard({ outletIsLondon: false, reviewDate: D('2025-08-09'), priorRuns: null });
  assert.equal(r.shouldFlag, false);
});

// Card #1528 (BRO-222 cousin, opposite direction): the FORWARD cross-market
// guard (US outlet reviewing a West End/Off-West-End show) had zero priorRuns
// handling — a US critic's in-window coverage of a declared US prior run
// (e.g. an Off-Broadway/regional run before a West End transfer) would be
// wrongly flagged 'Cross-market: US outlet reviewing London show', the
// mirror image of the rosie-odonnell-common-knowledge incident BRO-222 fixed.

test('isUsVenueString: recognizes explicit US venue text via positive keyword match', () => {
  assert.equal(isUsVenueString('Playwrights Horizons (Off-Broadway)'), true);
  assert.equal(isUsVenueString('Berkeley Repertory Theatre'), true);
  assert.equal(isUsVenueString('Bridge Theatre, London'), false);
  assert.equal(isUsVenueString('Edinburgh Festival Fringe (Assembly)'), false);
  assert.equal(isUsVenueString(null), false);
  assert.equal(isUsVenueString(undefined), false);
});

// Regression (ship-check adversarial finding): isUsVenueString must NOT be
// the bare inverse of isUkVenueString — UK regional venues with no keyword
// in UK_VENUE_RE's necessarily-partial city list must still resolve to
// isUsVenueString === false (fail closed: guard keeps flagging), not get
// silently reclassified as "US" and wrongly exempt a real cross-market leak.
test('isUsVenueString: does NOT false-positive on unlisted UK regional venues (fails closed, not the UK-inverse)', () => {
  assert.equal(isUsVenueString('Chichester Festival Theatre'), false);
  assert.equal(isUsVenueString('Sheffield Crucible'), false);
  assert.equal(isUsVenueString('Bath Theatre Royal'), false);
  assert.equal(isUsVenueString('Nottingham Playhouse'), false);
  assert.equal(isUsVenueString('York Theatre Royal'), false);
  assert.equal(isUsVenueString('Newcastle Theatre Royal'), false);
  assert.equal(isUsVenueString('Belfast Grand Opera House'), false);
});

const forwardGuardBase = {
  outletRegionMap: {},
  registeredOutletIds: new Set(['nypost']),
  canonicalOutlet: 'nypost',
  rawOutlet: 'nypost',
  url: 'https://nypost.com/theater/some-review/',
  contentVerification: undefined,
};

test('evaluateForwardCrossMarketGuard: a US outlet on a show whose priorRun venue is US is NOT cross-market flagged when the review date falls inside the declared window', () => {
  const priorRuns = [{ openingDate: '2025-08-01', closingDate: '2025-08-10', venue: 'Playwrights Horizons (Off-Broadway)' }];
  const r = evaluateForwardCrossMarketGuard({
    ...forwardGuardBase,
    reviewDate: D('2025-08-09'), // inside the declared US prior run window
    priorRuns,
  });
  assert.equal(r.shouldFlag, false);
  assert.equal(r.exemptedByPriorRun, true);
});

test('evaluateForwardCrossMarketGuard: same outlet WITHOUT priorRuns passed is still flagged (proves the fix, not a tautology)', () => {
  const r = evaluateForwardCrossMarketGuard({
    ...forwardGuardBase,
    reviewDate: D('2025-08-09'),
    // priorRuns omitted — mirrors pre-fix behavior
  });
  assert.equal(r.shouldFlag, true);
  assert.equal(r.exemptedByPriorRun, false);
});

test('evaluateForwardCrossMarketGuard: in-window date but a UK priorRun venue is still flagged', () => {
  const priorRuns = [{ openingDate: '2025-08-01', closingDate: '2025-08-10', venue: 'Bridge Theatre, London' }];
  const r = evaluateForwardCrossMarketGuard({
    ...forwardGuardBase,
    reviewDate: D('2025-08-09'),
    priorRuns,
  });
  assert.equal(r.shouldFlag, true);
});

test('evaluateForwardCrossMarketGuard: a date OUTSIDE the declared priorRun window is still flagged', () => {
  const priorRuns = [{ openingDate: '2025-08-01', closingDate: '2025-08-10', venue: 'Playwrights Horizons (Off-Broadway)' }];
  const r = evaluateForwardCrossMarketGuard({
    ...forwardGuardBase,
    reviewDate: D('2026-06-14'), // outside every declared window — republished-review class, out of scope
    priorRuns,
  });
  assert.equal(r.shouldFlag, true);
});

test('evaluateForwardCrossMarketGuard: a London outlet is still skip-exempted regardless of priorRuns (unaffected by this fix)', () => {
  const r = evaluateForwardCrossMarketGuard({
    ...forwardGuardBase,
    outletRegionMap: { guardian: 'london' },
    registeredOutletIds: new Set(['guardian']),
    canonicalOutlet: 'guardian',
    rawOutlet: 'guardian',
    url: 'https://www.theguardian.com/stage/some-review',
    reviewDate: D('2025-08-09'),
    priorRuns: null,
  });
  assert.equal(r.shouldFlag, false);
  assert.equal(r.exemptedByPriorRun, false);
});
