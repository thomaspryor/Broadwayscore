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
  // BRO-303 (2026-10-05): Mezzanine's catalog is keyed to specific London/NYC
  // stagings. Each entry below is a DIFFERENT production from our open show, so
  // the ratings must not be linked (audience ratings are production-specific):
  //  - "The Great Gatsby" 3387 ratings: London Coliseum 2025; ours is the 2026
  //    North American tour.
  //  - "Mrs Doubtfire" 1393: Shaftesbury Theatre (West End) 2023; ours is the
  //    2025 North American tour.
  //  - "Hell's Kitchen" 172: The Public Theater (NYC) 2023; ours is the 2025
  //    North American tour.
  //  - "Macbeth" 329 (Harold Pinter Theatre) and 108 (Dock X), both 2024 London
  //    stagings; ours is the 2026 Metropolitan Opera production.
  //  - "This Is Not A Drill" 30: The Theater at St. Jean 2025; ours is the 2026
  //    Playwrights Realm walking tour "This Is Not Not a Drill".
  // Keyed to the exact show id, so a genuine Mezzanine entry for our own run
  // still surfaces.
  'mezzanine|the great gatsby|the-great-gatsby-tour-2026',
  'mezzanine|mrs doubtfire|mrs-doubtfire-tour-2025',
  'mezzanine|hell s kitchen|hells-kitchen-tour-2025',
  'mezzanine|macbeth|macbeth-off-broadway-2026',
  'mezzanine|this is not a drill|this-is-not-not-a-drill-off-broadway-2026',
  // BRO-5167 (2026-10-12): Mezzanine "An Oak Tree" (56-57 ratings) is the Young
  // Vic run (previews 2025-05-06, closed 2025-05-17); ours is the 2026 Other
  // Palace run (previews 2026-10-07). Kept because the audit file written before
  // the earlier-closed-run rule below carries no closing date.
  'mezzanine|an oak tree|an-oak-tree-off-west-end-2026',
  // BRO-5167: Mezzanine "The Curious Case of Benjamin Button" (2448 ratings) is
  // the London Ambassadors run; ours is the 2026 Public Theater (NYC) run. The
  // stale audit file has no sourceMarket, so the market rule can't see it yet.
  'mezzanine|the curious case of benjamin button|the-curious-case-of-benjamin-button-off-broadway-2026',
]);

// A source production that CLOSED before our show's first performance is an
// earlier staging, never our run, so its ratings must not link and the audit
// must not ask about it (BRO-5167: Young Vic "An Oak Tree" closed May 2025,
// ours starts Oct 2026). The grace window absorbs date slop between catalogs;
// kept short because a tour stop closing a few weeks before a new London run
// is still a different production (High School Musical, Lowry -> Troubadour).
const EARLIER_RUN_GRACE_DAYS = 7;

/**
 * @param {string|null} sourceClosed  ISO date the source production closed.
 * @param {{previewsStartDate?: string|null, openingDate?: string|null}|null} show
 * @returns {boolean} true when the source run ended well before ours began.
 */
function isEarlierClosedRun(sourceClosed, show, graceDays = EARLIER_RUN_GRACE_DAYS) {
  if (!sourceClosed || !show) return false;
  const ourStart = show.previewsStartDate || show.openingDate;
  if (!ourStart) return false;
  const closedMs = Date.parse(String(sourceClosed).slice(0, 10));
  const startMs = Date.parse(String(ourStart).slice(0, 10));
  if (!Number.isFinite(closedMs) || !Number.isFinite(startMs)) return false;
  return startMs - closedMs > graceDays * 86400000;
}

function nonMatchKey(source, sourceName, ourShowId) {
  // Lowercase source — health-check.js passes 'Theatr'/'Mezzanine' (capitalized)
  // while some callers pass lowercase; normalize so the key matches either way.
  const src = String(source || '').toLowerCase();
  const norm = foldDiacritics(String(sourceName || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${src}|${norm}|${ourShowId}`;
}

// Which of our markets a source catalog's city can be. A London staging is never
// a NYC/tour run and a NYC staging is never a West End or touring run.
const SOURCE_MARKET_TO_OUR_MARKET = { london: 'west-end', nyc: 'broadway' };

function startYear(show) {
  const y = parseInt(String((show && (show.openingDate || show.previewsStartDate)) || '').slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

/**
 * Pure decision: is this audit flag provably a DIFFERENT production from our
 * show? Applied by the scraper when writing the audit and again by the health
 * check, so a stale audit file (scraper down) still drops these.
 * @param {{sourceClosed?: string|null, mYear?: number|null, sourceMarket?: string|null}} flag
 * @param {object|undefined} show  shows.json entry
 * @returns {string|null} reason, or null when it may be our run
 */
function differentProductionReason(flag, show) {
  if (!flag || !show) return null;
  if (isEarlierClosedRun(flag.sourceClosed, show)) return 'source run closed before ours began';
  const ours = startYear(show);
  if (flag.mYear && ours && Math.abs(flag.mYear - ours) > 2) return 'source run is from a different era';
  const want = flag.sourceMarket && SOURCE_MARKET_TO_OUR_MARKET[flag.sourceMarket];
  if (want && show.market && show.market !== want) return 'source run is in a different city';
  return null;
}

function openShowCoverageGaps(coverageReports, openShowIds, showsById = null) {
  const gaps = [];
  for (const report of coverageReports || []) {
    if (!report || !Array.isArray(report.flagged)) continue;
    for (const f of report.flagged) {
      if (!f || !f.ourShowId || !openShowIds.has(f.ourShowId)) continue;
      const sourceName = f.mezzName || f.theatrName || f.sourceName || f.name || null;
      if (CONFIRMED_NON_MATCHES.has(nonMatchKey(report.source, sourceName, f.ourShowId))) continue;
      if (showsById && differentProductionReason(f, showsById.get(f.ourShowId))) continue;
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

module.exports = { openShowCoverageGaps, CONFIRMED_NON_MATCHES, nonMatchKey, isEarlierClosedRun, differentProductionReason, EARLIER_RUN_GRACE_DAYS };
