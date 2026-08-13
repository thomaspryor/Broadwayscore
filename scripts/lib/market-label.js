/**
 * Canonical market labels for LLM prompt context.
 *
 * Every LLM prompt that frames a review has to tell the model which house the
 * production is filed under. Two call sites used to hand-roll that ternary
 * (scripts/llm-scoring/input-builder.ts and scripts/lib/classifier-prompts.js)
 * and both ended the chain with a bare `: 'Broadway'` fallback. Any market the
 * ternary did not name was therefore announced to the model as Broadway.
 *
 * That is not a cosmetic slip — it actively manufactures wrong_production
 * rejections. Regional tryouts are the live case: the ensemble scoreability
 * gate was told "The Family Album ... at La Jolla Playhouse (Broadway)", both
 * legs correctly answered "this is a La Jolla Playhouse world premiere, not a
 * Broadway production", and a clean 7006-char review was stamped
 * wrongProduction and dropped from the show's score (2026-07-30).
 *
 * Central lookup + explicit unknown handling, so a market added to shows.json
 * can never again be silently relabelled as Broadway.
 */

/**
 * market/category slug → keyword used in web/image SEARCH QUERIES.
 *
 * Distinct from MARKET_LABELS because the prompt label for regional is a prose
 * sentence ("Regional (US, outside New York)") that would poison a search
 * query. Same failure mode as the prompt ternary though: fetch-show-images-auto
 * hardcoded "Broadway" in its Google Images queries, so an Off-Broadway show at
 * a 60-seat bookstore was searched as a Broadway production — 0 usable
 * candidates for the-gin-game-2026, which then shipped with no image
 * (2026-07-31).
 */
const MARKET_SEARCH_KEYWORDS = {
  broadway: 'Broadway',
  'off-broadway': 'Off-Broadway',
  'west-end': 'West End',
  'off-west-end': 'Off-West End',
  regional: 'theater',
};

/** market/category slug → human label used in prompt text. */
const MARKET_LABELS = {
  broadway: 'Broadway',
  'off-broadway': 'Off-Broadway',
  'west-end': 'West End',
  'off-west-end': 'Off-West End',
  regional: 'Regional (US, outside New York)',
};

/**
 * Label for a regional production at a UK feeder house.
 *
 * `regional` is one slug covering two countries. Announcing an RSC
 * Stratford-upon-Avon world premiere as "Regional (US, outside New York)" is
 * the same failure this file was written to stop, one country over: the model
 * is handed a fact the review body flatly contradicts, so both ensemble legs
 * answer "this is an English production, not a US regional one" and the review
 * is stamped wrongProduction. Card #1405 (Game of Thrones: The Mad King, RSC).
 */
const MARKET_LABEL_REGIONAL_UK = 'Regional (UK, outside London)';

/**
 * Venue substrings that make a `regional` show a UK production. Same table
 * scripts/lib/aggregator-candidate-extract.js and src/lib/market-utils.ts read,
 * so a venue added there is picked up here with no second edit.
 */
let _ukRegionalVenues = null;
let _ukRegionalVenuesWarned = false;
function ukRegionalVenueMatches() {
  if (_ukRegionalVenues !== null) return _ukRegionalVenues;
  let rows;
  try {
    // eslint-disable-next-line global-require
    rows = require('../../data/uk-regional-venues.json');
  } catch (err) {
    // A missing or malformed table must not throw inside a prompt builder, but
    // it must not be cached either: caching [] on one transient read error
    // would freeze every UK regional show back to the US wording for the rest
    // of the process, silently reintroducing the exact bug this file fixes.
    // Return the empty fallback WITHOUT memoizing, so the next call retries.
    if (!_ukRegionalVenuesWarned) {
      _ukRegionalVenuesWarned = true;
      console.warn(`[market-label] uk-regional-venues.json unreadable (${err.message}) — UK regional shows will be labelled US until it loads`);
    }
    return [];
  }
  if (!Array.isArray(rows)) {
    if (!_ukRegionalVenuesWarned) {
      _ukRegionalVenuesWarned = true;
      console.warn('[market-label] uk-regional-venues.json is not an array — UK regional shows will be labelled US');
    }
    return [];
  }
  _ukRegionalVenues = rows
    .map((r) => String((r && r.match) || '').trim().toLowerCase())
    .filter(Boolean);
  return _ukRegionalVenues;
}

/**
 * True when a venue string names a known UK regional feeder house.
 *
 * @param {string|null|undefined} venue
 * @returns {boolean}
 */
function isUkRegionalVenue(venue) {
  // Strings only, deliberately. String(['Royal Shakespeare Theatre']) is
  // 'Royal Shakespeare Theatre', so a coercing version would silently match an
  // array — and getMarketLabel's optional 2nd param makes `arr.map(getMarketLabel)`
  // a live footgun (no such caller today; verified by grep, kept impossible here).
  if (typeof venue !== 'string') return false;
  const v = venue.trim().toLowerCase();
  if (!v) return false;
  return ukRegionalVenueMatches().some((m) => v.includes(m));
}

/**
 * Markets whose productions are NOT New York / West End commercial runs.
 * Reviews of these legitimately describe a hometown theater, so the
 * wrong_production gate needs the extra context note below.
 */
const NON_METRO_MARKETS = new Set(['regional']);

/**
 * Map a shows.json `market` or `category` slug to its prompt label.
 *
 * Callers pass either vocabulary: `market` is broadway|west-end|regional,
 * `category` additionally carries off-broadway|off-west-end. Both are looked
 * up in the same table.
 *
 * `venue` is optional and only consulted for `regional`, where the same slug
 * covers both US and UK feeder houses (see MARKET_LABEL_REGIONAL_UK). Callers
 * that omit it keep the pre-#1405 US wording.
 *
 * @param {string|null|undefined} market
 * @param {string|null|undefined} [venue]
 * @returns {string} label, or 'Broadway' only when the slug really is Broadway
 *   or absent. An unrecognised slug is echoed back rather than silently
 *   becoming 'Broadway'.
 */
function getMarketLabel(market, venue) {
  if (market === null || market === undefined || market === '') return MARKET_LABELS.broadway;
  const key = String(market).trim().toLowerCase();
  if (key === 'regional' && isUkRegionalVenue(venue)) return MARKET_LABEL_REGIONAL_UK;
  if (Object.prototype.hasOwnProperty.call(MARKET_LABELS, key)) return MARKET_LABELS[key];
  // Unknown slug: echo it instead of lying. A model told "(dublin-fringe)" may
  // be mildly confused; a model told "(Broadway)" confidently rejects the review.
  return String(market);
}

/**
 * True when the market is a non-NYC/non-West-End production whose reviews will
 * describe a regional venue and season.
 *
 * @param {string|null|undefined} market
 * @returns {boolean}
 */
function isNonMetroMarket(market) {
  if (market === null || market === undefined) return false;
  return NON_METRO_MARKETS.has(String(market).trim().toLowerCase());
}

/**
 * Prompt note telling the model that a regional venue in the review body is
 * expected, not evidence of a mismatch. Mirrors the opera carve-out in
 * scripts/lib/opera-prompt-context.js.
 *
 * @param {string|null|undefined} venue
 * @returns {string}
 */
function getRegionalPromptContext(venue) {
  const where = venue ? ` (${venue})` : '';
  // The country half of this sentence is load-bearing. Telling the model an RSC
  // Stratford-upon-Avon production is "a US theater outside New York" hands it a
  // claim the review body contradicts in its first paragraph, which is a
  // wrong_production rejection waiting to happen — the same shape as the bare
  // ': Broadway' fallback this file replaced. Card #1405.
  const isUk = isUkRegionalVenue(venue);
  const place = isUk ? 'a UK theatre outside London' : 'a US theater outside New York';
  const metro = isUk ? 'a West End production' : 'a Broadway production';
  return [
    `NOTE: This is a REGIONAL production${where} — ${place},`,
    `often a world premiere, pre-${isUk ? 'West End' : 'Broadway'} tryout, or resident-company staging.`,
    `It is NOT ${metro} and is not supposed to be one. A review that`,
    'describes this regional theater, its season, or a world premiere IS valid for',
    'this show — do NOT flag it wrong_show or wrong_production merely because the',
    `production is not ${isUk ? 'in the West End' : 'on Broadway'}.`,
  ].join(' ');
}

/**
 * Map a shows.json `market`/`category` slug to the keyword to put in a search
 * query. Unknown slugs fall back to 'theater' (neutral) rather than 'Broadway'
 * (an active lie that returns the wrong production's art).
 *
 * @param {string|null|undefined} market
 * @returns {string}
 */
function getMarketSearchKeyword(market) {
  if (market === null || market === undefined || market === '') return MARKET_SEARCH_KEYWORDS.broadway;
  const key = String(market).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MARKET_SEARCH_KEYWORDS, key)) return MARKET_SEARCH_KEYWORDS[key];
  return 'theater';
}

module.exports = {
  MARKET_LABELS,
  MARKET_LABEL_REGIONAL_UK,
  MARKET_SEARCH_KEYWORDS,
  NON_METRO_MARKETS,
  isUkRegionalVenue,
  getMarketLabel,
  getMarketSearchKeyword,
  isNonMetroMarket,
  getRegionalPromptContext,
};
