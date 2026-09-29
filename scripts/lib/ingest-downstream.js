'use strict';

/**
 * Workflows dispatched after new reviews land. The `-f` names must match the
 * target workflow's workflow_dispatch inputs — GitHub rejects unknown inputs,
 * and `-f show=` (llm-ensemble-score.yml's input is `show_id`) made every
 * ingest's scoring dispatch fail (BRO-4185). Locked by ingest-urls.test.mjs.
 */
function downstreamWorkflows(showId, newReviews) {
  return [
    { name: 'LLM Ensemble Score', file: 'llm-ensemble-score.yml', args: `-f show_id=${showId}` },
    { name: 'Rebuild Reviews', file: 'rebuild-reviews.yml', args: `-f reason="ingest-urls: ${newReviews} reviews for ${showId}"` },
  ];
}

module.exports = { downstreamWorkflows };
