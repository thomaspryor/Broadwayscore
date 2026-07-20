'use strict';

/**
 * Shared predicate for identifying a Reddit post as a "Grosses Analysis" /
 * "Post-Mortem" weekly commercial-data post, regardless of author.
 *
 * Consolidated from 3 near-duplicate implementations (2026-07-19,
 * plan-review finding): scripts/scrape-boring-waltz-costs.js's
 * isRelevantPost(), and an inline `/grosses\s*analysis/i` regex in
 * scripts/update-commercial-data.js's fetchGrossesAnalysisPost(). Both
 * scripts now import from here instead of maintaining their own copy —
 * a 3rd/4th divergent copy is exactly what this consolidation avoids.
 */
function isRelevantPost(post) {
  const title = (post.title || '').toLowerCase();
  return title.includes('grosses') || title.includes('post-mortem') || title.includes('postmortem');
}

module.exports = { isRelevantPost };
