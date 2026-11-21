/**
 * Exact title equivalence for production routing and its audits.
 *
 * Keep this conservative: title-match.js intentionally folds more variants
 * for external-source discovery. Using that matcher to measure routing
 * collisions reports sibling pairs the runtime router cannot produce.
 */
function normalizeRoutingTitle(title) {
  return String(title || '').toLowerCase().trim().replace(/[!?.,'"]/g, '');
}

module.exports = { normalizeRoutingTitle };
