/**
 * google-image-retry-candidate.js — card #795.
 *
 * fetch-show-images-auto.js's Google Images step searches for a poster
 * candidate independently of the square/thumbnail candidate it verifies.
 * When the thumbnail candidate fails verification, the retry loop used to
 * build its next candidate with a hardcoded `poster: null` — discarding a
 * poster image that had already been fetched, verified-independent, and
 * written to disk. The orphaned poster.jpg then sat unreferenced forever
 * while shows.json kept images.poster: null (gimme-a-sign-off-broadway-2026,
 * el-quijote-off-broadway-2026 — both stuck "missing_poster" in the daily
 * health check despite a valid poster file already on disk).
 *
 * Pure decision extracted so it's require()-able in a test — the retry
 * function itself does real network/disk I/O and can't be.
 */
'use strict';

// The poster search is independent of which thumbnail candidate wins
// verification, so a rejected thumbnail must never cost an already-fetched
// poster — carry it forward unchanged.
function buildRetryCandidateImages({ showId, previousPoster = null }) {
  return {
    thumbnail: `/images/shows/${showId}/thumbnail.jpg`,
    poster: previousPoster || null,
    hero: null,
  };
}

module.exports = { buildRetryCandidateImages };
