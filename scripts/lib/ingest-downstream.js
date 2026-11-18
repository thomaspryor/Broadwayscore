'use strict';

/**
 * Workflows dispatched after new reviews land. The `-f` names must match the
 * target workflow's workflow_dispatch inputs — GitHub rejects unknown inputs,
 * and `-f show=` (llm-ensemble-score.yml's input is `show_id`) made every
 * ingest's scoring dispatch fail (BRO-4185). Locked by ingest-urls.test.mjs.
 *
 * BRO-7747: for a press-night (urgent) show, scoring runs with
 * fast_rebuild=true and NO parallel rebuild-reviews.yml is dispatched. The
 * parallel slow rebuild started before the review was scored, so it could not
 * show the new score, and it held the shared rebuild-reviews group for ~15
 * minutes (2026-11-17, Blue Man Group: cancelled by hand). Scoring's own
 * auto-trigger then runs rebuild-fast.yml, which vercel-deploy follows.
 */
function downstreamWorkflows(showId, newReviews, { urgent = false } = {}) {
  if (urgent) {
    return [
      { name: 'LLM Ensemble Score', file: 'llm-ensemble-score.yml', args: `-f show_id=${showId} -f fast_rebuild=true` },
    ];
  }
  return [
    { name: 'LLM Ensemble Score', file: 'llm-ensemble-score.yml', args: `-f show_id=${showId}` },
    { name: 'Rebuild Reviews', file: 'rebuild-reviews.yml', args: `-f reason="ingest-urls: ${newReviews} reviews for ${showId}"` },
  ];
}

module.exports = { downstreamWorkflows };
