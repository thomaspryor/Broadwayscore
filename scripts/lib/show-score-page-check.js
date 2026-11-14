/**
 * Show Score page validation decision for scrape-show-score-audience.js (BRO-262).
 *
 * Deterministic pass first (skipLlm: year-mismatch + short-title partial-match
 * guards). The Gemini heading tiebreaker was rejecting genuinely correct pages
 * (0% success), so it only runs when the page has no JSON-LD name to vouch for
 * it (jsonLdName already passed titlesMatch() in the caller).
 */
const { validatePageMatchesShow } = require('./page-validator');
const { checkPageProductionWindow } = require('./show-score-production-window');

async function checkShowScorePage(html, show, { jsonLdName = null, url = null, validate = validatePageMatchesShow } = {}) {
  // BRO-5866: same title, different production (Safe House 2026 on the 2025
  // St. Ann's page). The title/year checks below can't see it; the review
  // dates can. productionMismatch tells the caller the stored rating came
  // from another production and must go too.
  const window = checkPageProductionWindow(html, show, url);
  if (!window.ok) return { valid: false, productionMismatch: true, reason: window.reason };
  const opts = {
    openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null,
    pageType: 'audience-aggregator',
  };
  const deterministic = await validate(html, show.title, { ...opts, skipLlm: true });
  if (deterministic.valid) return { valid: true, reason: deterministic.reason };
  if (jsonLdName) return { valid: false, reason: deterministic.reason };
  const llm = await validate(html, show.title, opts);
  return { valid: !!llm.valid, reason: llm.reason };
}

module.exports = { checkShowScorePage };
