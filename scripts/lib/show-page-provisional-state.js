'use strict';

/**
 * @param {{ provisional?: boolean, discoverySource?: string,
 *   criticScore?: { score?: number | null, reviewCount?: number } | null }} show
 * @returns {boolean}
 */
function shouldShowReviewsSyncing(show) {
  if (show.criticScore?.score != null) return false;
  return show.provisional === true || (
    (show.criticScore?.reviewCount ?? 0) === 0 &&
    (show.discoverySource?.startsWith('audit-') ?? false)
  );
}

module.exports = { shouldShowReviewsSyncing };
