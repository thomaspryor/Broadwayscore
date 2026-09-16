/**
 * BWW grosses table row parser — pure function extracted from
 * scripts/scrape-grosses.ts (2026-07-12) to make it unit-testable.
 *
 * Column layout (verified 2026-08-12 against live https://www.broadwayworld.com/grosses.php):
 *   [0] Show / Theater
 *   [1] This-week gross           [2] Last-week gross          [3] gross diff ($)
 *   [4] "AVG. TIX / TOP TIX"      "$101.74 $344.00"            → ATP is first token
 *   [5] "ATTEND. / CAPACITY"      e.g. "10,644 10,592"         → attendance first, offered seats second
 *   [6] "PERF. / PREV."           → this-week perfs is first token
 *   [7] Capacity % this week      [8] Capacity % prev wk       [9] capacity diff (%)
 *
 * Column [5]'s second token is the seats offered THIS WEEK (per-perf offered × perfs),
 * NOT the theater's nominal max. Varies by production configuration — e.g. Circle in
 * the Square Just In Time offers ~690 seats/perf, well below room max. Arithmetic
 * check: attendance ÷ seatsOffered × 100 reproduces published CAP % to 2 decimals
 * across every sampled show.
 *
 * Positions above are resolved from the live header row via findColumnIndex
 * (BRO-2375 — same column-drift class as #118 / BRO-47's scrape-alltime.ts
 * fix), not assumed fixed: assertTableSchema's expectedHeaders check only
 * guarantees the labels are present somewhere in the header row, not that
 * an inserted/reordered column hasn't shifted them off these indices. The
 * numbers above are the CURRENT resolved positions, kept as a fallback for
 * callers that don't have a header row available (e.g. existing tests).
 */
const { findColumnIndex } = require('./table-schema-assertion');

const LEGACY_INDICES = {
  showIdx: 0, grossIdx: 1, grossPrevIdx: 2, atpIdx: 4,
  attendIdx: 5, perfIdx: 6, capIdx: 7, capPrevIdx: 8,
};

/**
 * Resolves the BWW grosses columns' indices from the live header row instead
 * of assuming the fixed layout documented above. Falls back to that fixed
 * layout for any label that can't be found (or when no header row is
 * available at all), so a caller without header text still gets the
 * pre-BRO-2375 behavior rather than crashing.
 *
 * @param {string[]} [headerCells] - header cell text, in document order
 * @returns {typeof LEGACY_INDICES}
 */
function resolveBwwColumnIndices(headerCells) {
  if (!headerCells || headerCells.length === 0) return { ...LEGACY_INDICES };

  const resolve = (label, fallback) => {
    const found = findColumnIndex(headerCells, label);
    return found !== -1 ? found : fallback;
  };

  // Full documented header text used where possible instead of a loose
  // substring (e.g. 'Perf' rather than 'Perf./Prev.') — findColumnIndex
  // tries an exact match first, but a loose substring can still resolve to
  // the WRONG column if BWW inserts a new column whose label also contains
  // that substring (e.g. a "Performance Change" column ahead of "Perf./Prev.").
  // 'Gross' and 'Show' are kept loose because they're expected to remain
  // exact matches against the live schema ("Gross", "Show/Theater").
  return {
    showIdx: resolve('Show', LEGACY_INDICES.showIdx),
    grossIdx: resolve('Gross', LEGACY_INDICES.grossIdx),
    grossPrevIdx: resolve('Gross/Prev week', LEGACY_INDICES.grossPrevIdx),
    atpIdx: resolve('Avg. Tix/Top Tix', LEGACY_INDICES.atpIdx),
    attendIdx: resolve('Attend./Capacity', LEGACY_INDICES.attendIdx),
    perfIdx: resolve('Perf./Prev.', LEGACY_INDICES.perfIdx),
    capIdx: resolve('Cap %/This Wk', LEGACY_INDICES.capIdx),
    capPrevIdx: resolve('Cap %/Last Wk', LEGACY_INDICES.capPrevIdx),
  };
}

function parseCurrency(value) {
  if (!value || value === '-') return null;
  const cleaned = String(value).replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parsePercentage(value) {
  if (!value || value === '-') return null;
  const cleaned = String(value).replace(/%/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseNumber(value) {
  if (!value || value === '-') return null;
  const cleaned = String(value).replace(/,/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
}

/**
 * Parse a single BWW grosses table row into structured data.
 * Returns null if the row is too short or fails the structural sanity guard.
 *
 * @param {string[]} cells - Raw cell text from a `<tr>` in the BWW table
 * @param {(showTheater: string) => {show: string, theater: string} | null} splitShowTheater
 * @param {string[]} [headerCells] - header cell text for this table, used to
 *   resolve column positions by label (BRO-2375). Omit to use the legacy
 *   fixed layout (existing behavior, for callers without a header row).
 * @returns {object | null}
 */
function parseBwwGrossesRow(cells, splitShowTheater, headerCells) {
  if (!cells || cells.length < 10) return null;

  const idx = resolveBwwColumnIndices(headerCells);
  const maxIdx = Math.max(...Object.values(idx));
  if (cells.length <= maxIdx) return null;

  const split = splitShowTheater(cells[idx.showIdx]?.trim() || '');
  if (!split) return null;

  const attendanceCell = cells[idx.attendIdx] || '';
  const attendanceParts = attendanceCell.split(/\s+/).filter(Boolean);

  const row = {
    show: split.show,
    theater: split.theater,
    gross: parseCurrency(cells[idx.grossIdx]),
    grossPrevWeek: parseCurrency(cells[idx.grossPrevIdx]),
    grossYoY: null, // enriched from history downstream
    atp: parseCurrency(cells[idx.atpIdx]?.split(/\s+/)?.[0]),
    attendance: parseNumber(attendanceParts[0]),
    seatsOffered: parseNumber(attendanceParts[1]),
    performances: parseNumber(cells[idx.perfIdx]),
    capacityPct: parsePercentage(cells[idx.capIdx]),
    capacityPctPrevWeek: parsePercentage(cells[idx.capPrevIdx]),
  };

  // Structural sanity guard — if BWW shifts columns again, these ranges break
  // and we drop the row LOUDLY instead of silently shipping garbage (the
  // 2026-06 incident: ATP read as "8", capacity as 0.25%, perf as 100).
  if (row.gross != null) {
    const sane =
      (row.atp == null || (row.atp >= 15 && row.atp <= 1000)) &&
      (row.performances == null || (row.performances >= 1 && row.performances <= 16)) &&
      (row.capacityPct == null || (row.capacityPct >= 5 && row.capacityPct <= 120));
    if (!sane) return null;
  }

  return row;
}

module.exports = { parseBwwGrossesRow, parseCurrency, parsePercentage, parseNumber, resolveBwwColumnIndices };
