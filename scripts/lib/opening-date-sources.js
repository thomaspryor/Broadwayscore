/**
 * opening-date-sources.js — where a missing `openingDate` should be sourced,
 * per market. The fill source is market-specific: only Broadway has IBDB (an
 * authoritative opening-date database); Off-Broadway, West End and Off-West-End
 * each have their own enricher driven by Playbill / Show-Score / official
 * listings / SERP. Used to make "open show with null openingDate" warnings and
 * logs actionable (point the operator at the right enricher) instead of a
 * generic "look it up".
 *
 * Wired into:
 *   - scripts/validate-data.js — daily soft-check warning per stranded show
 *   - scripts/update-show-status.js — Check 2d log when a review-driven flip
 *     can't derive a press-night date (all reviews dateless)
 */

const OPENING_DATE_SOURCES = {
  broadway: {
    source: 'IBDB',
    enricher: 'enrich-ibdb-dates.js',
  },
  'off-broadway': {
    // No IBDB off-Broadway — Playbill production pages + Show-Score "Opens" date.
    source: 'Playbill / Show-Score',
    enricher: 'enrich-off-broadway-dates.js (+ enrich-ob-dates-from-showscore.js)',
  },
  'west-end': {
    source: 'official listing / SOLT / SERP',
    enricher: 'enrich-west-end-dates.js',
  },
  'off-west-end': {
    source: 'official listing / SERP',
    enricher: 'enrich-west-end-dates.js',
  },
};

/**
 * Human-readable hint: where to source a missing openingDate for `category`.
 * Falls back to a generic manual-lookup string for an unknown/missing market.
 */
function openingDateSourceHint(category) {
  const entry = OPENING_DATE_SOURCES[category];
  if (!entry) return 'manual Playbill / official-listing lookup (unknown market)';
  return `${entry.source} (${entry.enricher})`;
}

module.exports = { OPENING_DATE_SOURCES, openingDateSourceHint };
