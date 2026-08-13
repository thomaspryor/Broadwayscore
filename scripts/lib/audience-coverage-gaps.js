'use strict';

const { foldDiacritics } = require('./title-match');

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

// Operator-confirmed NON-matches. The coverage audit fuzzy-matches a source
// catalog entry to a same-titled open show to surface near-misses for review.
// Sometimes the answer, after a human looks, is "different production" — e.g. a
// source has ratings for an earlier NYC staging while our open show is a later,
// reworked London production. Those productions are distinct, so the ratings
// must NOT be linked (audience ratings are production-specific). Recording the
// confirmed non-match here stops the audit re-asking every week. Keyed by
// `source|normalizedSourceName|ourShowId` so it suppresses ONLY the specific
// confirmed collision — a genuine future gap on the same show still surfaces.
const CONFIRMED_NON_MATCHES = new Set([
  // theatr "Archduke" (Off-Broadway NYC, ~102 ratings) is the earlier NY staging,
  // not our 2026 Royal Court (London) production — reworked, distinct. 2026-06-28.
  // NOTE: this permanently suppresses ANY theatr "Archduke" → this London show
  // alert. If theatr ever lists the LONDON production under this same name and we
  // DO want those ratings, remove this entry.
  'theatr|archduke|archduke-west-end-2026',
  // theatr "The Jonathan Larson Project" (150 ratings, venue: Orpheum Theatre,
  // NYC) is the earlier Off-Broadway run, not our 2026 West End transfer —
  // Theatr's catalog only covers Broadway/Off-Broadway (eventCategory is always
  // 'Broadway' or 'Off & Off-Off Broadway', never a West End category), so this
  // entry can never be our London show. 2026-08-13 (BRO-303).
  'theatr|the jonathan larson project|the-jonathan-larson-project-off-west-end-2026',
]);

function nonMatchKey(source, sourceName, ourShowId) {
  // Lowercase source — health-check.js passes 'Theatr'/'Mezzanine' (capitalized)
  // while some callers pass lowercase; normalize so the key matches either way.
  const src = String(source || '').toLowerCase();
  const norm = foldDiacritics(String(sourceName || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${src}|${norm}|${ourShowId}`;
}

function openShowCoverageGaps(coverageReports, openShowIds) {
  const gaps = [];
  for (const report of coverageReports || []) {
    if (!report || !Array.isArray(report.flagged)) continue;
    for (const f of report.flagged) {
      if (!f || !f.ourShowId || !openShowIds.has(f.ourShowId)) continue;
      const sourceName = f.mezzName || f.theatrName || f.sourceName || f.name || null;
      if (CONFIRMED_NON_MATCHES.has(nonMatchKey(report.source, sourceName, f.ourShowId))) continue;
      gaps.push({
        source: report.source,
        ourShowId: f.ourShowId,
        ourTitle: f.ourTitle,
        // Source-side catalog name is keyed differently per source; normalize.
        sourceName,
        ratingsCount: f.ratingsCount || f.watched || 0,
        ...f,
      });
    }
  }
  gaps.sort((a, b) => (b.ratingsCount || 0) - (a.ratingsCount || 0));
  return gaps;
}

module.exports = { openShowCoverageGaps, CONFIRMED_NON_MATCHES, nonMatchKey };
