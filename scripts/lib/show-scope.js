// BRO-2691: SHOW_FILTER scope helpers for collect-review-texts.js.
// The candidate filter itself was always enforced; the "152 shows with
// SHOW_FILTER=2 shows" report came from generateReport() dumping the RESUMED
// progress.json (<24h old) cumulative state. These pure helpers let the run
// track only its own attempts and let the main loop re-check scope.

function parseShowFilter(raw) {
  return new Set(String(raw || '').split(',').map(s => s.trim()).filter(Boolean));
}

// Empty filter set = no restriction.
function isInShowScope(showId, filterSet) {
  return !filterSet || filterSet.size === 0 || filterSet.has(showId);
}

// reviewIds are "<showId>/<file>.json"
function showIdOfReviewId(reviewId) {
  const i = String(reviewId).indexOf('/');
  return i < 0 ? String(reviewId) : String(reviewId).slice(0, i);
}

function summarizeRunScope({ runProcessed = [], runFailed = [], filterSet, resumedProcessed = 0, resumedFailed = 0 }) {
  const all = [...runProcessed, ...runFailed];
  const shows = [...new Set(all.map(showIdOfReviewId))].sort();
  const outOfScope = shows.filter(s => !isInShowScope(s, filterSet));
  return {
    processed: runProcessed.length,
    failed: runFailed.length,
    shows,
    outOfScopeShows: outOfScope,
    inheritedFromResume: { processed: resumedProcessed, failed: resumedFailed },
  };
}

module.exports = { parseShowFilter, isInShowScope, showIdOfReviewId, summarizeRunScope };
