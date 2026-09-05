/**
 * playbill-url-market.js — is a cached Playbill URL for the WRONG MARKET?
 *
 * WHY THIS EXISTS. `data/playbill-urls.json` is a DURABLE cache keyed by show
 * id, and validate-show-venue.js reads it BEFORE it builds any query — so a
 * wrong URL written once is returned forever and no later fix to the query, the
 * venue token or the scorer can dislodge it. Measured on the live cache
 * 2026-09-05: 6 of 113 entries point at an entirely unrelated production, and
 * every one of the 6 is the same shape, a London show cached to a New York URL:
 *
 *   ish-off-west-end-2026          "Ish"          -> circle-jerk-off-broadway-...
 *   kings-2-off-west-end-2026      "Kings 2"      -> richard-ii-henry-iv-off-broadway-...
 *   keith-off-west-end-2026        "Keith"        -> lewberger-the-wizard-of-friendship-off-broadway-...
 *   amplify-off-west-end-2026      "Amplify"      -> paranormal-activity-broadway-...
 *   meet-me-here-off-west-end-2026 "Meet Me Here" -> two-strangers-carry-a-cake-across-new-york-broadway-...
 *   babylon-off-west-end-2026      "Babylon"      -> the-green-pastures-broadway-theatre-vault-...
 *
 * They are all still `announced`, so without this they would be validated with
 * the wrong Playbill page at go-live.
 *
 * Today's scorePlaybillUrl ALREADY rejects every one of these — its cross-market
 * hard reject (card #590) returns null for exactly this shape. That is the
 * point: these entries predate the guard, and because the cache short-circuits
 * ahead of the scorer they never get re-judged. So the check has to run at cache
 * READ time, not only at selection time.
 *
 * WHY *ONLY* THE CROSS-MARKET TEST, and not "re-resolve anything the scorer
 * dislikes". 21 of the 113 cached URLs score null under scorePlaybillUrl, but
 * 15 of those are CORRECT and merely unverifiable:
 *   - 10 are legacy Playbill URLs with no market segment at all, so the scorer's
 *     regex cannot match ("...-eugene-oneill-theatre-vault-0000013715")
 *   - 5 are title-shape mismatches where the URL is right ("Doubt: A Parable"
 *     vs slug "doubt", "& Juliet" vs slug "juliet")
 * Treating score<=0 as a cache miss would evict those 15 correct entries, spend
 * SERP calls re-resolving them, and land them right back on the same hard filter
 * that could not verify them in the first place. The cross-market test flags 6
 * of 113 and all 6 are independently confirmed wrong — zero false positives on
 * the live cache.
 *
 * Pure and separate so both the CLI and the test require() the same predicate
 * (CLAUDE.md rule 15).
 */

'use strict';

const LONDON_CATEGORIES = new Set(['west-end', 'off-west-end']);

/**
 * @param {string} url   a playbill.com/production/... URL
 * @param {object} show  a shows.json entry (needs `category`)
 * @returns {boolean} true when the URL's market contradicts the show's market
 */
function isCrossMarketPlaybillUrl(url, show) {
  if (!url || !show) return false;
  const u = String(url).toLowerCase();
  // Playbill's West End productions use "london" as the market segment, NOT
  // "west-end" — the same alternative scorePlaybillUrl had to learn (card #590).
  const isLondonUrl = u.includes('-london-');
  const isNycUrl = u.includes('-broadway-') || u.includes('-off-broadway-');
  const isLondonShow = LONDON_CATEGORIES.has(show.category);

  // A URL carrying BOTH markers is not evidence of anything — "two-strangers-
  // carry-a-cake-across-new-york-broadway-..." contains "-broadway-" inside a
  // TITLE, and a London title could equally contain "-london-". Only decide
  // when exactly one market marker is present.
  if (isLondonUrl && isNycUrl) return false;

  if (isLondonShow && isNycUrl) return true;
  if (!isLondonShow && isLondonUrl) return true;
  return false;
}

module.exports = { isCrossMarketPlaybillUrl, LONDON_CATEGORIES };
