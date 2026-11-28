'use strict';

/**
 * standing-outlets.js — B1 of the v2 reconciler Sprint B plan
 * (~/Documents/claude-outputs/review-pipeline-from-scratch-design-2026-07-29.md).
 *
 * A "standing outlet" is one the registry says reliably reviews virtually
 * every opening in a market (outlet-registry.json `standingCoverage:true`,
 * scoped by `standingMarkets`). Unlike every other review-census source, this
 * is a PSEUDO-source: no archive file, no network call — a pure registry
 * lookup. Its purpose is to make an outlet going silent a visible census gap
 * instead of an invisible one: no roundup ever "names an outlet that isn't
 * there", so NY Post / Hollywood Reporter going quiet for three months
 * (task #582) produced zero signal until a human noticed. A standing outlet
 * is expected whether or not any roundup mentions it.
 *
 * Membership is EARNED, never assumed from tier (card #627). Measured over
 * three seasons of Broadway openings, tier-1 Hollywood Reporter covers ~19%
 * of them while tier-2 New York Stage Review covers ~99% — so flagging by
 * tier would make 4 of every 5 HR cells a false "missing" alert, the same
 * false-positive class isNoReviewExpected's decay window exists to prevent,
 * mirrored here in the opposite direction. scripts/audit-standing-coverage.js
 * derives the qualifying set from reviews.json and reports registry drift in
 * both directions; run it before hand-editing standingCoverage. An outlet
 * that covers only a slice of openings still gets silence protection — just
 * from the market-pulse-aware heartbeat (scripts/lib/outlet-cadence.js), the
 * right instrument for "this outlet stopped entirely", where standingCoverage
 * is the right instrument for "this outlet is missing from THIS opening".
 *
 * FAN-OUT CAP: standing outlets only being added/removed from the registry
 * changes what "expected" means for every in-window show at once — unlike
 * archive sources (which only ever add cells one show at a time, as each
 * show's own roundup is scraped), a single registry edit or a genuinely
 * broken extractor can make a standing outlet miss dozens of shows in one
 * ledger rebuild. capNewStandingCells bounds how many *previously-untracked*
 * cells one run may inject, so a burst surfaces gradually across cycles
 * instead of flooding the digest/dispatch path in one hour. Cells already in
 * the prior ledger are never capped — only fresh discovery is throttled.
 */

const DEFAULT_MAX_NEW_PER_RUN = 15;

// "No press night" suppression (card #627 live smoke test). Some Broadway
// engagements never get a press opening at all: Beetlejuice's 2025 limited
// return of the 2019 production (0 scored reviews) and All Out (1). Standing
// coverage says "every outlet reviews every OPENING" — it does not say every
// outlet reviews every ticketed engagement, so on those shows the whole
// flagged set turns into one GAP cell per outlet describing a single fact:
// nobody held a press night. That is a show-level absence, not 11 independent
// outlet failures, and it drowns the ledger it is supposed to sharpen.
//
// The bar is deliberately evidence-based rather than metadata-based
// (`limitedRun`/`isRevival`/a null previewsStartDate all fire on shows that DO
// get reviewed). If even a couple of dispatch-tier outlets showed up, there
// was a press night and every other standing outlet is genuinely missing.
const NO_PRESS_NIGHT_GRACE_DAYS = 21; // >> the 48h cell GRACE — real reviews land in days
const NO_PRESS_NIGHT_MIN_OUTLETS = 3;

/**
 * True when a show is far enough past its clock that near-total dispatch-tier
 * silence means "no press night", not "every outlet failed at once".
 * Scoped to standing-outlet insertion ONLY — archive-named gaps are untouched,
 * so a show an aggregator DID cover keeps producing its real cells, and the
 * show's coverage % still reports the absence.
 * @param {number|null} clockAgeHours hours since openingDate/previewsStartDate (null → unknown, never suppress)
 * @param {number} scoredDispatchTierOutlets distinct T1/T2 outlets with a scored review
 */
function isNoPressNightShow(clockAgeHours, scoredDispatchTierOutlets) {
  if (clockAgeHours == null || !Number.isFinite(clockAgeHours)) return false;
  if (clockAgeHours < NO_PRESS_NIGHT_GRACE_DAYS * 24) return false;
  return scoredDispatchTierOutlets < NO_PRESS_NIGHT_MIN_OUTLETS;
}

/** outletIds with active standingCoverage for `market`. Pure, sorted for determinism. */
function standingOutletIds(outlets, market) {
  if (!outlets) return [];
  const ids = [];
  for (const outletId of Object.keys(outlets)) {
    const o = outlets[outletId];
    if (!o || !o.standingCoverage) continue;
    const markets = o.standingMarkets || ['broadway'];
    if (markets.includes(market)) ids.push(outletId);
  }
  return ids.sort();
}

/**
 * The pseudo-source's review-census.js `fn` shape: (showId, opts) -> rows.
 * Reads opts.outlets + opts.market (buildCensusFromArchives always passes
 * the full opts object through to pseudo sources).
 */
function standingOutletsSource(showId, opts) {
  const outlets = opts && opts.outlets;
  const market = (opts && opts.market) || 'broadway';
  return standingOutletIds(outlets, market).map((outletId) => ({
    outlet: (outlets[outletId] && outlets[outletId].displayName) || outletId,
    outletId,
    critic: 'Unknown',
    stars: null,
    url: '',
  }));
}

/**
 * Throttle how many NEW standing-outlet cells one ledger run may add.
 * @param {Set<string>} existingCellKeys  `${showId}::${outletId}` keys already in the prior ledger
 * @param {{used:number, cap:number}} counter  mutable, shared across the whole run's shows
 * @param {string} showId
 * @param {string[]} candidateOutletIds
 * @returns {string[]} outletIds allowed through this cycle (already-tracked + budget-permitting new ones)
 */
function capNewStandingCells(existingCellKeys, counter, showId, candidateOutletIds) {
  const allowed = [];
  for (const outletId of candidateOutletIds) {
    const key = `${showId}::${outletId}`;
    if (existingCellKeys.has(key)) { allowed.push(outletId); continue; } // already tracked — free
    if (counter.used >= counter.cap) continue; // new discovery — capped this run
    allowed.push(outletId);
    counter.used++;
  }
  return allowed;
}

module.exports = {
  standingOutletIds, standingOutletsSource, capNewStandingCells, DEFAULT_MAX_NEW_PER_RUN,
  isNoPressNightShow, NO_PRESS_NIGHT_GRACE_DAYS, NO_PRESS_NIGHT_MIN_OUTLETS,
};
