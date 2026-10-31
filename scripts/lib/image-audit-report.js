'use strict';

/**
 * Build the image-verification.json to write after an audit run, or null when
 * the file should be left alone.
 *
 * A full run replaces the report. A --show run PATCHES it: it used to replace
 * all 734 rows with one (BRO-5326). A patch keeps the full run's generatedAt,
 * mode and stats, so hundreds of February rows do not look freshly audited
 * (apply-image-cleanup.js acts on every 'delete' row); its own time goes in
 * partialUpdatedAt and on each row it wrote (auditedAt). An id that matched no
 * show writes nothing.
 */
function buildAuditReport({ prior, results, singleShow, mode, showCount, stats, now }) {
  const rows = Object.keys(results || {});
  if (singleShow && rows.length === 0) return null;
  const stamped = {};
  for (const id of rows) stamped[id] = { ...results[id], auditedAt: now };
  if (!singleShow) {
    return { generatedAt: now, mode, totalShows: showCount, results: stamped, stats };
  }
  const merged = { ...((prior && prior.results) || {}), ...stamped };
  if (prior && prior.generatedAt) {
    return { ...prior, totalShows: Object.keys(merged).length, results: merged, partialUpdatedAt: now };
  }
  return { generatedAt: now, mode, totalShows: Object.keys(merged).length, results: merged, stats, partialUpdatedAt: now };
}

module.exports = { buildAuditReport };
