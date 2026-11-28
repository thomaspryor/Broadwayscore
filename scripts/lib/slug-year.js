'use strict';
/**
 * Strip a production-year suffix from a show slug (BRO-8447).
 *
 * Aggregator URL guessing uses the slug without its "-YYYY" suffix. That suffix
 * is only a production year when it matches the show's opening year or the year
 * in its id. "the-dead-1904" is a TITLE ("The Dead, 1904"), and stripping it
 * produced "the-dead", the 2000 Broadway "James Joyce's The Dead" page.
 */
function stripProductionYearSuffix(show) {
  const slug = (show && show.slug) || '';
  const m = slug.match(/-(\d{4})$/);
  if (!m) return slug;
  const year = Number(m[1]);
  const openingYear = show.openingDate ? Number(String(show.openingDate).slice(0, 4)) : null;
  const idMatch = String(show.id || '').match(/-(\d{4})$/);
  const idYear = idMatch ? Number(idMatch[1]) : null;
  const previewsYear = show.previewsStartDate ? Number(String(show.previewsStartDate).slice(0, 4)) : null;
  if (year === openingYear || year === idYear || year === previewsYear) {
    return slug.slice(0, -5);
  }
  return slug;
}

module.exports = { stripProductionYearSuffix };
