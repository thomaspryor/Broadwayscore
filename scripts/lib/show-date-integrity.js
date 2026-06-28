'use strict';

/**
 * Pure show-date integrity predicates for validate-data.js.
 *
 * Catches the date-bug class fixed 2026-06-28: upcoming revivals that inherited their
 * historical namesake's opening date (e.g. a-few-good-men-2026 carrying 1989-11-15 and
 * status=open), and a closed show whose previews date landed AFTER its opening.
 * See memory/feedback_clone_inherited_dates_yyyy_id.
 *
 * Two signal strengths:
 *  - HARD ERROR: previews-after-opening, and a date that EXACTLY equals a same-title
 *    sibling's date (unambiguous inheritance — distinct productions never share an
 *    opening night). Both are 0-false-positive on the real corpus.
 *  - WARNING: the id-year-gap heuristic (recent `{title}-{YYYY}` id with a decades-older
 *    opening, still pre-open). Catches clones whose namesake isn't in the DB, but can also
 *    flag a legit long-runner imported with a recent id-year (e.g. book-of-mormon-west-end-2024
 *    opened 2013) — so it only warns, never blocks.
 */

const PRE_OPEN_STATUSES = new Set(['open', 'previews', 'upcoming', 'announced']);

function normTitle(t) { return (t || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Unambiguous: a production's previews always precede its opening. Anything else is a bug.
function previewsAfterOpening(show) {
  return !!(show && show.previewsStartDate && show.openingDate && show.previewsStartDate > show.openingDate);
}

// COVID-disruption windows — a production whose previews began in the season leading into
// the March-2020 shutdown and which opened during the staggered 2020-2022 reopening was
// legitimately delayed (Company/Six/Lehman Trilogy/The Minutes etc.). Bounded windows (not a
// hard-coded id list) so the carve-out covers only genuinely COVID-affected runs — a show
// with previews years earlier (sunset-baby 2013→2024) is NOT exempt just because its span
// happens to cross 2020.
const COVID_PREVIEW_MIN = '2019-09-01', COVID_PREVIEW_MAX = '2020-03-15';
const COVID_OPENING_MIN = '2020-09-01', COVID_OPENING_MAX = '2023-01-01';

/**
 * A previews date implausibly far BEFORE the opening — the wrong-production previews class
 * (sunset-baby-off-broadway-2026 had previews 2013-12-17 vs opening 2024-02-22, the 2013
 * original's date). Distinct from previewsAfterOpening (which is previews AFTER opening) and
 * from inheritedDateFromSibling (which needs an exact sibling-date match). Excludes the
 * legitimate COVID-delayed class.
 * @param {object} show
 * @param {object} [opts] - { maxGapDays = 365 }
 * @returns {boolean}
 */
function excessivePreviewGap(show, opts = {}) {
  const { maxGapDays = 365 } = opts;
  if (!show || !show.previewsStartDate || !show.openingDate) return false;
  const p = show.previewsStartDate, o = show.openingDate;
  if (p >= o) return false; // previews-after / same handled elsewhere
  const gapDays = (Date.parse(o + 'T00:00:00Z') - Date.parse(p + 'T00:00:00Z')) / 86400000;
  if (!(gapDays > maxGapDays)) return false;
  // COVID carve-out: previews in the pre-shutdown window AND opening in the reopening window.
  const covidDelayed = p >= COVID_PREVIEW_MIN && p <= COVID_PREVIEW_MAX
    && o >= COVID_OPENING_MIN && o <= COVID_OPENING_MAX;
  if (covidDelayed) return false;
  return true;
}

/**
 * HARD signal: this show's openingDate (or previewsStartDate) is byte-identical to a
 * DIFFERENT same-title production's. Distinct productions never share an opening night, so
 * an exact match is the date having been cloned from the namesake.
 * @param {object} show
 * @param {object[]} sameTitleSiblings - other shows with the same normalized title (any id)
 * @returns {{ field: 'openingDate'|'previewsStartDate', siblingId: string }|null}
 */
function inheritedDateFromSibling(show, sameTitleSiblings) {
  if (!show || !Array.isArray(sameTitleSiblings)) return null;
  for (const sib of sameTitleSiblings) {
    if (!sib || sib.id === show.id) continue;
    if (show.openingDate && sib.openingDate === show.openingDate) return { field: 'openingDate', siblingId: sib.id };
    if (show.previewsStartDate && sib.previewsStartDate === show.previewsStartDate) return { field: 'previewsStartDate', siblingId: sib.id };
  }
  return null;
}

/**
 * SOFT signal (warning only): a recently-minted `{title}-{YYYY}` id whose openingDate is
 * from a much earlier year while the show is still pre-open. Catches clones whose namesake
 * isn't a separate DB entry; tolerates the occasional legit recent-import long-runner.
 * @param {object} show
 * @param {number} currentYear - injected for testability
 * @param {object} [opts] - { recentWithin=2, gapYears=10 }
 */
function suspiciousInheritedYear(show, currentYear, opts = {}) {
  const { recentWithin = 2, gapYears = 10 } = opts;
  if (!show || !show.id || !show.openingDate) return false;
  const m = String(show.id).match(/-(\d{4})$/);
  if (!m) return false;
  const idYear = parseInt(m[1], 10);
  const openYear = parseInt(String(show.openingDate).slice(0, 4), 10);
  if (!Number.isFinite(idYear) || !Number.isFinite(openYear)) return false;
  return idYear >= currentYear - recentWithin
    && idYear - openYear >= gapYears
    && PRE_OPEN_STATUSES.has(show.status);
}

module.exports = { previewsAfterOpening, excessivePreviewGap, inheritedDateFromSibling, suspiciousInheritedYear, normTitle, PRE_OPEN_STATUSES };
