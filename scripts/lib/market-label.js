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

/** market/category slug → human label used in prompt text. */
const MARKET_LABELS = {
  broadway: 'Broadway',
  'off-broadway': 'Off-Broadway',
  'west-end': 'West End',
  'off-west-end': 'Off-West End',
  regional: 'Regional (US, outside New York)',
};

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
 * @param {string|null|undefined} market
 * @returns {string} label, or 'Broadway' only when the slug really is Broadway
 *   or absent. An unrecognised slug is echoed back rather than silently
 *   becoming 'Broadway'.
 */
function getMarketLabel(market) {
  if (market === null || market === undefined || market === '') return MARKET_LABELS.broadway;
  const key = String(market).trim().toLowerCase();
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
  return [
    `NOTE: This is a REGIONAL production${where} — a US theater outside New York,`,
    'often a world premiere, pre-Broadway tryout, or resident-company staging.',
    'It is NOT a Broadway production and is not supposed to be one. A review that',
    'describes this regional theater, its season, or a world premiere IS valid for',
    'this show — do NOT flag it wrong_show or wrong_production merely because the',
    'production is not on Broadway.',
  ].join(' ');
}

module.exports = {
  MARKET_LABELS,
  NON_METRO_MARKETS,
  getMarketLabel,
  isNonMetroMarket,
  getRegionalPromptContext,
};
