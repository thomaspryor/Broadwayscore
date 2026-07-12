/**
 * BWW grosses table row parser — pure function extracted from
 * scripts/scrape-grosses.ts (2026-07-12) to make it unit-testable.
 *
 * Column layout (verified 2026-07-12 against live https://www.broadwayworld.com/grosses.php):
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
 */

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
 * @returns {object | null}
 */
function parseBwwGrossesRow(cells, splitShowTheater) {
  if (!cells || cells.length < 10) return null;

  const split = splitShowTheater(cells[0]?.trim() || '');
  if (!split) return null;

  const attendanceCell = cells[5] || '';
  const attendanceParts = attendanceCell.split(/\s+/).filter(Boolean);

  const row = {
    show: split.show,
    theater: split.theater,
    gross: parseCurrency(cells[1]),
    grossPrevWeek: parseCurrency(cells[2]),
    // cells[3] = week-over-week gross diff (skip)
    grossYoY: null, // enriched from history downstream
    atp: parseCurrency(cells[4]?.split(/\s+/)?.[0]),
    attendance: parseNumber(attendanceParts[0]),
    seatsOffered: parseNumber(attendanceParts[1]),
    performances: parseNumber(cells[6]),
    capacityPct: parsePercentage(cells[7]),
    capacityPctPrevWeek: parsePercentage(cells[8]),
    // cells[9] = capacity diff (skip)
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

module.exports = { parseBwwGrossesRow, parseCurrency, parsePercentage, parseNumber };
