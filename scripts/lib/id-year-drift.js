/**
 * Id-year drift (2026 data audit, BRO-4204 S5-T4).
 *
 * A show id is minted ONCE at discovery — `<market-slug>-<year>` — with the
 * year taken from the first trustworthy date (opening, then previews, then
 * an unconfirmed start) or, when the source listed the title before any
 * date, the CURRENT year (scripts/discover-new-shows.js mintCandidateId, via
 * scripts/lib/todaytix-dates.js productionIdYear). Dates arrive later through
 * enrichment, but the id (= the URL) is never renamed, so `evita-2026` opens
 * in 2027 and `wanted-2022` in 2026. The audit found 22 such non-closed rows.
 *
 * This module is the pure decision function behind validate-data.js's
 * "id year matches neither date year" WARN, extracted so the unit test runs
 * the real rule with in-memory rows (CLAUDE.md §15). Rule, as specified:
 *
 *   - closed shows are skipped (their ids are history; renames are S8-T1's job
 *     for rows that are still live);
 *   - ids without a trailing 4-digit year are skipped (nothing to compare);
 *   - rows with neither an openingDate year nor a previewsStartDate year are
 *     skipped (no evidence yet — that is exactly the fallback case, which the
 *     row now records as `idYearProvisional: true` at minting);
 *   - otherwise the id year must equal the opening year OR the previews year.
 *
 * Year extraction reuses stripIdSuffix from market-slug.js: the trailing year
 * is whatever stripIdSuffix removed after the market suffix, so a title that
 * itself ends in four digits ("1536" → `1536-west-end-2026`) is read from the
 * suffix, not from the title.
 */

'use strict';

const { stripIdSuffix, stripMarketSuffix } = require('./market-slug');

const TRAILING_YEAR_RE = /-(\d{4})$/;

/**
 * The 4-digit year suffix of a show id, or null when the id has none.
 * `stripIdSuffix` drops `-<market>-<year>` / `-<year>`; the year is what sits
 * between the market-stripped base and the end of the id.
 */
function idYearOf(id) {
  if (typeof id !== 'string' || !id) return null;
  const base = stripIdSuffix(id);
  if (base === id) return null; // nothing was stripped → no year suffix
  const m = id.match(TRAILING_YEAR_RE);
  if (!m) return null;
  // Guard: the stripped remainder must be the id minus a real `-<year>` (with
  // or without a market suffix), not a title that merely ends in digits.
  const withoutYear = id.slice(0, -m[0].length);
  if (stripMarketSuffix(withoutYear) !== base) return null;
  return m[1];
}

/** YYYY of an ISO-ish date string, or null. */
function dateYearOf(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})-\d{2}-\d{2}/);
  return m ? m[1] : null;
}

/**
 * Pure decision: does this row's id year disagree with its dates?
 *
 * @returns {null | { id, idYear, openingYear, previewsYear, status, idYearProvisional }}
 *   null when the row is skipped or consistent; a hit object otherwise.
 */
function idYearDrift(show) {
  if (!show || typeof show !== 'object' || show._devOnly) return null;
  if (show.status === 'closed') return null;
  const idYear = idYearOf(show.id);
  if (!idYear) return null;
  const openingYear = dateYearOf(show.openingDate);
  const previewsYear = dateYearOf(show.previewsStartDate);
  if (!openingYear && !previewsYear) return null;
  if (idYear === openingYear || idYear === previewsYear) return null;
  return {
    id: show.id,
    idYear,
    openingYear,
    previewsYear,
    status: show.status == null ? null : show.status,
    idYearProvisional: show.idYearProvisional === true,
  };
}

/** Every drifted row, in shows.json order. */
function findIdYearDrift(shows) {
  const hits = [];
  for (const show of Array.isArray(shows) ? shows : []) {
    const hit = idYearDrift(show);
    if (hit) hits.push(hit);
  }
  return hits;
}

/** The operator-facing WARN text — the contract CI logs and the digest grep for. */
function formatIdYearDriftWarning(hit) {
  const dates = [
    `opening ${hit.openingYear || 'none'}`,
    `previews ${hit.previewsYear || 'none'}`,
  ].join(', ');
  const provisional = hit.idYearProvisional ? '; minted with the current-year fallback' : '';
  return `Id year drift: ${hit.id} (${hit.status || 'no status'}) is a ${hit.idYear} id but its dates say ${dates}${provisional} — rename via S8-T1 (rename-show-id.js) once dates are confirmed`;
}

/**
 * Run the check and report through the caller's warn/ok sinks. One WARN per
 * drifted id; an ok line when none. Never an error — the id is a live URL and
 * renaming it is a deliberate, tooled step, not something validate-data does.
 *
 * @returns the hits, for callers that want them.
 */
function checkIdYearDrift(shows, { warn, ok } = {}) {
  const hits = findIdYearDrift(shows);
  for (const hit of hits) {
    if (warn) warn(formatIdYearDriftWarning(hit));
  }
  if (hits.length === 0 && ok) {
    ok('Every non-closed show id year matches its opening or previews year');
  }
  return hits;
}

module.exports = {
  idYearOf,
  dateYearOf,
  idYearDrift,
  findIdYearDrift,
  formatIdYearDriftWarning,
  checkIdYearDrift,
};
