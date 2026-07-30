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
 * Deliberately curated, not derived: only outlets with a DIRECT evidenced
 * silent-gap incident (#582) start with standingCoverage:true. Guessing more
 * outlets into this set risks false "missing" alerts on shows that outlet
 * simply doesn't cover — the same false-positive class isNoReviewExpected's
 * decay window exists to prevent, mirrored here in the opposite direction.
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
};
