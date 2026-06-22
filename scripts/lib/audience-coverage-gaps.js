'use strict';

/**
 * Audience source coverage-gap detection (shared, unit-tested).
 *
 * Each audience scraper that matches against a full source catalog (Mezzanine,
 * Theatr) writes a coverage-audit file (data/audit/{source}-coverage.json) of
 * unmatched high-volume catalog entries that FUZZY-match one of our shows
 * lacking that source — i.e. data the source almost certainly has but our
 * matcher failed to link (a title-drift or missing-override gap).
 *
 * The audit files already exist; the failure mode they were meant to catch
 * (Encores! La Cage Aux Folles, open 2026, 85 Mezzanine ratings never linked
 * because of an "Encores!" title-prefix + venue-ambiguity gap) slipped through
 * because the audit only rendered as a passive HTML section in the daily
 * digest, mixed in with dozens of closed-revival flags, and never became a
 * CHECK that drives the subject line / escalation.
 *
 * This narrows the audit to its actionable core: flags on CURRENTLY OPEN shows.
 * A gap on a closed 1983 revival doesn't matter; a gap on a show running right
 * now is a missing audience source on a page users see today.
 *
 * @param {Array<{source: string, flagged: Array<object>}>} coverageReports
 *        One entry per source. `flagged[]` items carry at least `ourShowId`,
 *        `ourTitle`, a source-side name, and `ratingsCount`.
 * @param {Set<string>} openShowIds  Ids of shows with status === 'open'.
 * @returns {Array<object>} Gaps on open shows, sorted by ratingsCount desc.
 *          Each: { source, ourShowId, ourTitle, sourceName, ratingsCount, ...orig }
 */
function openShowCoverageGaps(coverageReports, openShowIds) {
  const gaps = [];
  for (const report of coverageReports || []) {
    if (!report || !Array.isArray(report.flagged)) continue;
    for (const f of report.flagged) {
      if (!f || !f.ourShowId || !openShowIds.has(f.ourShowId)) continue;
      gaps.push({
        source: report.source,
        ourShowId: f.ourShowId,
        ourTitle: f.ourTitle,
        // Source-side catalog name is keyed differently per source; normalize.
        sourceName: f.mezzName || f.theatrName || f.sourceName || f.name || null,
        ratingsCount: f.ratingsCount || f.watched || 0,
        ...f,
      });
    }
  }
  gaps.sort((a, b) => (b.ratingsCount || 0) - (a.ratingsCount || 0));
  return gaps;
}

module.exports = { openShowCoverageGaps };
