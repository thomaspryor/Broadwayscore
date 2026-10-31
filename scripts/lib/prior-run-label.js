/**
 * Display label for a review that belongs to a returning production's
 * declared priorRuns window — e.g. "2022 Gielgud run" on a 2026 To Kill a
 * Mockingbird review from its earlier Gielgud Theatre run (BRO-1397).
 *
 * Shared between the rebuild pipeline (server-side JSON generation) and
 * ReviewsList.tsx (client component) so the label always matches the same
 * window findMatchingPriorRun uses to decide the review belongs there.
 */
const { findMatchingPriorRun } = require('./wrong-production-autoclear');

/**
 * @param {Array<{openingDate?: string, closingDate?: string, venue?: string}>} priorRuns
 * @param {string|Date|null} publishDate
 * @returns {string|null}
 */
function getPriorRunLabel(priorRuns, publishDate) {
  const run = findMatchingPriorRun(publishDate, priorRuns);
  if (!run || !run.openingDate) return null;
  const year = String(run.openingDate).slice(0, 4);
  if (!/^\d{4}$/.test(year)) return null;
  const venue = run.venue ? run.venue.trim().replace(/\s+theatre$|\s+theater$/i, '') : null;
  return venue ? `${year} ${venue} run` : `${year} run`;
}

module.exports = { getPriorRunLabel };
