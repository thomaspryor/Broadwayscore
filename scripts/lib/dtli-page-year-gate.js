/**
 * Page-level year gate for a fetched DTLI show page (BRO-8266).
 *
 * validatePageMatchesShow reads only the page title/h1/h2, and a DTLI show
 * page's headings carry no year, so a same-title page from an older production
 * passed (galileo-2026 read the 2012 Classic Stage Company page). The review
 * items carry dates: when ALL of them predate the show's year the page is a
 * different production's. Absence of dates is not evidence, so an empty or
 * undated page passes (same rule as pickBestDtliSlug).
 */
const { dtliSlugPredatesShow, extractDtliReviewYears, dtliShowYear } = require('./review-guards');

/** @returns {{wrong:boolean, years:number[], showYear:number|null}} */
function dtliPageWrongProduction(html, show) {
  const showYear = dtliShowYear(show);
  const years = extractDtliReviewYears(html);
  return { wrong: !!showYear && dtliSlugPredatesShow(years, showYear), years, showYear };
}

module.exports = { dtliPageWrongProduction };
