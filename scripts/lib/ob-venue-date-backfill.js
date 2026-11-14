'use strict';

const { decideVenueListingPromotion } = require('./ob-cross-validation');

// Only date an existing announced stub. A later production and any row with
// established run dates belong to their own enrichment paths.
function datedBackfillFor(candidate, row, options = {}) {
  if (!candidate || candidate.category !== 'off-broadway'
    || !row || row.category !== 'off-broadway' || row.status !== 'announced') return null;
  if (['previewsStartDate', 'openingDate', 'closingDate'].some(k => row[k] != null)) return null;
  const idYear = /-(20\d\d)$/.exec(String(row.id || ''));
  const first = candidate.listingFirstDate;
  if (!idYear || typeof first !== 'string') return null;
  const year = Number(idYear[1]);
  const runYear = Number(first.slice(0, 4));
  if (runYear < year || runYear > year + 1) return null;
  const decision = decideVenueListingPromotion(candidate, { ...options, allowFirstDateOnly: true });
  if (!decision.confirmed) return null;
  const patch = {};
  // OvationTix's next ticket on sale is never evidence of a first preview.
  if (!candidate.listingFirstDateIsNext) patch.previewsStartDate = first;
  if (candidate.listingLastDate && !candidate.listingLastDateIsHorizon) patch.closingDate = candidate.listingLastDate;
  return Object.keys(patch).length ? patch : null;
}

module.exports = { datedBackfillFor };
