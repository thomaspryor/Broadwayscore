/**
 * Playbill weekly Broadway grosses parser (https://playbill.com/grosses).
 *
 * Pure functions, no I/O. The one Playbill grosses parser: used by
 * scripts/scrape-grosses.ts (its first source tier) and by
 * scripts/backfill-grosses-history.ts, so every history week has the same
 * field semantics whichever script wrote it.
 *
 * Why Playbill (BRO-4623): BroadwayWorld's grosses.php started serving a
 * Cloudflare "Just a moment..." challenge on 2026-09-23, so every BWW tier
 * returned either a challenge page (no week in the <title>) or a selector
 * timeout, and grosses.json froze at week ending 9/13/2026.
 *
 * Playbill republishes the Broadway League's weekly figures as static,
 * server-rendered HTML, and serves any past week at ?week=YYYY-MM-DD (the
 * week <select> lists every available week back to 1985). Layout verified
 * live 2026-10-04 (weeks 2026-09-06 .. 2026-09-27):
 *
 *   <option value="https://playbill.com/grosses?week=2026-09-13" selected>
 *   "Week's Total" .accent  → sum of every row's gross (used as a checksum)
 *   <thead><th> = Show | This Week Gross (Potential Gross) | Diff $ |
 *                 Avg Ticket (Top Ticket) | Seats Sold (Seats in Theatre) |
 *                 Perfs (Previews) | % Cap | Diff % cap
 *   <td data-label="..."> each holds a .data-value span (main figure) and,
 *   for the paired columns, a .subtext span (the parenthesised figure).
 *
 * Field semantics, checked against the BWW-sourced grosses-history.json
 * weeks 2026-07-05, 08-02, 09-06 and 09-13 (112 show-weeks: gross,
 * attendance, performances and atp all equal; capacity equal in 109, off by
 * 0.01-0.02 points in 3; see tests/unit/parse-playbill-grosses.test.mjs):
 *   - gross        Playbill shows cents; BWW showed whole dollars. Rounded
 *                  to the nearest dollar so history stays integer-valued.
 *   - capacityPct  "83.42%" → 83.42 (same percent-number form as BWW).
 *   - atp          average ticket price, "$87.91" → 87.91.
 *   - attendance   Seats Sold.
 *   - performances Perfs + Previews. BWW's "Perf./Prev." first token was the
 *                  number of performances played that week, previews
 *                  included; Playbill splits them into two figures.
 *   - seatsOffered Seats in Theatre × (Perfs + Previews), kept ONLY when
 *                  attendance ÷ seatsOffered reproduces the published % Cap
 *                  (within 0.05 points). Playbill's "Seats in Theatre" is the
 *                  per-performance seats offered (it varies by production
 *                  configuration the same way BWW's figure did): it equals
 *                  BWW's seats-offered in 59 of the 61 rows where BWW had one
 *                  (2026-07-05, 08-02); the other 2 (one seat per show off)
 *                  fail the arithmetic check and stay null. That per-row check
 *                  keeps a wrong value out of RevPAS math.
 *   - grossPrevWeek / capacityPctPrevWeek  derived from the Diff $ and
 *                  Diff % cap columns (this week minus diff), which is
 *                  what BWW published directly in its prev-week columns.
 *
 * Column positions are resolved from the header text via findColumnIndex
 * (BRO-2375 column-drift class) and the header is checked with
 * assertTableSchema before any row is read, so a Playbill layout change
 * fails loud instead of silently mis-assigning values.
 */
const cheerio = require('cheerio');
const { assertTableSchema, TableSchemaError, findColumnIndex } = require('./table-schema-assertion');

const PLAYBILL_GROSSES_URL = 'https://playbill.com/grosses';

const TABLE_SCHEMA = {
  minCells: 8,
  expectedHeaders: ['Show', 'This Week Gross', 'Diff $', 'Avg Ticket', 'Seats Sold', 'Perfs', '% Cap', 'Diff % cap'],
};

const ISO_WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

function playbillGrossesUrl(week) {
  if (!week) return PLAYBILL_GROSSES_URL;
  if (!ISO_WEEK_RE.test(week)) throw new Error(`playbillGrossesUrl: week must be YYYY-MM-DD, got "${week}"`);
  return `${PLAYBILL_GROSSES_URL}?week=${week}`;
}

function parseMoney(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[$,\s]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parsePct(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[%,\s]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseCount(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[,\s]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const num = parseInt(cleaned, 10);
  return Number.isFinite(num) ? num : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** "2026-09-13" → "9/13/2026" (the unpadded M/D/YYYY form grosses.json uses). */
function isoWeekToMDY(iso) {
  if (!ISO_WEEK_RE.test(iso || '')) return null;
  const [y, m, d] = iso.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
}

function cellParts($, td) {
  const $td = $(td);
  const main = $td.find('.data-value').first();
  const sub = $td.find('.subtext').first();
  return {
    main: (main.length ? main.text() : $td.text()).replace(/\s+/g, ' ').trim(),
    sub: sub.length ? sub.text().replace(/\s+/g, ' ').trim() : '',
  };
}

/**
 * Parse one Playbill grosses page.
 *
 * @param {string} html
 * @returns {{
 *   weekEnding: string|null,        // YYYY-MM-DD of the week actually shown (the selected <option>)
 *   availableWeeks: string[],       // every YYYY-MM-DD in the week <select>, newest first
 *   weekTotalGross: number|null,    // Playbill's "Week's Total" figure
 *   headerCells: string[],
 *   schemaError: string|null,       // set (and rows empty) when the header check fails
 *   rows: Array<{
 *     show: string, theater: string,
 *     gross: number|null, potentialGross: number|null,
 *     grossDiff: number|null, grossPrevWeek: number|null,
 *     atp: number|null, topTicket: number|null,
 *     attendance: number|null, seatsInTheatre: number|null, seatsOffered: number|null,
 *     performances: number|null, perfs: number|null, previews: number|null,
 *     capacityPct: number|null, capacityDiff: number|null, capacityPctPrevWeek: number|null,
 *   }>
 * }}
 */
function parsePlaybillGrossesHtml(html) {
  const $ = cheerio.load(html || '');

  const availableWeeks = [];
  let weekEnding = null;
  $('option').each((_i, el) => {
    const value = $(el).attr('value') || '';
    const m = value.match(/[?&]week=(\d{4}-\d{2}-\d{2})\b/);
    if (!m) return;
    availableWeeks.push(m[1]);
    if (weekEnding === null && $(el).attr('selected') !== undefined) weekEnding = m[1];
  });

  let weekTotalGross = null;
  $('.week-total .accent').each((_i, el) => {
    if (weekTotalGross === null) weekTotalGross = parseMoney($(el).text());
  });

  const $table = $('table').filter((_i, el) => $(el).find('td[data-label]').length > 0).first();
  const headerCells = $table.find('thead th').map((_i, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();

  const result = { weekEnding, availableWeeks, weekTotalGross, headerCells, schemaError: null, rows: [] };

  try {
    assertTableSchema([headerCells], TABLE_SCHEMA);
  } catch (err) {
    if (err instanceof TableSchemaError) {
      result.schemaError = err.message;
      return result;
    }
    throw err;
  }

  const idx = {
    show: findColumnIndex(headerCells, 'Show'),
    gross: findColumnIndex(headerCells, 'This Week Gross'),
    grossDiff: findColumnIndex(headerCells, 'Diff $'),
    atp: findColumnIndex(headerCells, 'Avg Ticket'),
    seats: findColumnIndex(headerCells, 'Seats Sold'),
    perfs: findColumnIndex(headerCells, 'Perfs'),
    cap: findColumnIndex(headerCells, '% Cap'),
    capDiff: findColumnIndex(headerCells, 'Diff % cap'),
  };
  const maxIdx = Math.max(...Object.values(idx));

  $table.find('tbody tr').each((_i, tr) => {
    const tds = $(tr).find('td');
    if (tds.length <= maxIdx) return;

    const showCell = cellParts($, tds[idx.show]);
    const show = showCell.main;
    if (!show || /^total/i.test(show)) return;

    const grossCell = cellParts($, tds[idx.gross]);
    const atpCell = cellParts($, tds[idx.atp]);
    const seatsCell = cellParts($, tds[idx.seats]);
    const perfsCell = cellParts($, tds[idx.perfs]);

    const grossRaw = parseMoney(grossCell.main);
    const grossDiff = parseMoney(cellParts($, tds[idx.grossDiff]).main);
    const capacityPct = parsePct(cellParts($, tds[idx.cap]).main);
    const capacityDiff = parsePct(cellParts($, tds[idx.capDiff]).main);
    const attendance = parseCount(seatsCell.main);
    const seatsInTheatre = parseCount(seatsCell.sub);
    const perfs = parseCount(perfsCell.main);
    const previews = parseCount(perfsCell.sub);
    const performances = perfs == null && previews == null ? null : (perfs || 0) + (previews || 0);

    // Previous week = this week minus the published diff. Playbill prints a
    // diff of exactly $0.00 / 0.00% for a show's first reported week (School
    // Girls 2026-09-13, The Imaginary Invalid 2026-09-27), where there is no
    // prior week at all; a real week-over-week change of exactly zero cents
    // does not happen. Both prev-week fields are null then, never "same as
    // this week". A 0.00% capacity diff alone is real (Ragtime at 100% two
    // weeks running), so only the gross diff decides first-week status.
    const firstWeek = grossDiff === 0;
    let grossPrevWeek = null;
    if (!firstWeek && grossRaw != null && grossDiff != null) {
      const prev = Math.round(grossRaw - grossDiff);
      grossPrevWeek = prev > 0 ? prev : null;
    }
    let capacityPctPrevWeek = null;
    if (!firstWeek && capacityPct != null && capacityDiff != null) {
      const prev = round2(capacityPct - capacityDiff);
      capacityPctPrevWeek = prev > 0 ? prev : null;
    }

    let seatsOffered = null;
    if (seatsInTheatre && performances && attendance != null && capacityPct != null) {
      const offered = seatsInTheatre * performances;
      if (Math.abs((attendance / offered) * 100 - capacityPct) < 0.05) seatsOffered = offered;
    }

    result.rows.push({
      show,
      theater: showCell.sub,
      gross: grossRaw == null ? null : Math.round(grossRaw),
      potentialGross: parseMoney(grossCell.sub),
      grossDiff: grossDiff == null ? null : Math.round(grossDiff),
      grossPrevWeek,
      atp: atpCell.main ? parseMoney(atpCell.main) : null,
      topTicket: parseMoney(atpCell.sub),
      attendance,
      seatsInTheatre,
      seatsOffered,
      performances,
      perfs,
      previews,
      capacityPct,
      capacityDiff,
      capacityPctPrevWeek,
    });
  });

  return result;
}

/**
 * Integrity checks on a parsed page, independent of show matching. Returns a
 * list of human-readable problems (empty = OK). Callers treat any problem as
 * "this page is not trustworthy" and fall through to the next source.
 *
 * @param {ReturnType<typeof parsePlaybillGrossesHtml>} parsed
 * @param {{ expectedWeek?: string }} [opts]
 * @returns {string[]}
 */
function validatePlaybillGrosses(parsed, opts = {}) {
  const problems = [];
  if (!parsed) return ['no parse result'];
  if (parsed.schemaError) problems.push(`table schema: ${parsed.schemaError}`);
  if (!parsed.weekEnding) problems.push('no selected week in the week <select>');
  if (opts.expectedWeek && parsed.weekEnding && parsed.weekEnding !== opts.expectedWeek) {
    // Playbill falls back to the latest week for an unknown ?week= value.
    problems.push(`requested week ${opts.expectedWeek} but page shows ${parsed.weekEnding}`);
  }
  if (parsed.rows.length === 0) problems.push('no data rows');
  if (parsed.weekTotalGross != null && parsed.rows.length > 0) {
    // Row grosses are rounded to whole dollars, so allow $1 per row of drift.
    const sum = parsed.rows.reduce((acc, r) => acc + (r.gross || 0), 0);
    if (Math.abs(sum - parsed.weekTotalGross) > parsed.rows.length) {
      problems.push(`row grosses sum to $${sum} but Week's Total is $${parsed.weekTotalGross}`);
    }
  }
  return problems;
}

/**
 * Same structural sanity ranges parse-bww-grosses-row.js applies to BWW rows
 * (ATP $15-$1000, 1-16 performances, 5-120% capacity). A row outside them
 * means a column was mis-read; the caller drops it loudly. Rows with no gross
 * (dark week) are always kept.
 */
function isPlausibleRow(row) {
  if (!row || row.gross == null) return true;
  return (row.atp == null || (row.atp >= 15 && row.atp <= 1000)) &&
    (row.performances == null || (row.performances >= 1 && row.performances <= 16)) &&
    (row.capacityPct == null || (row.capacityPct >= 5 && row.capacityPct <= 120));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoToMs = (iso) => Date.parse(`${iso}T00:00:00Z`);

/**
 * Weeks Playbill offers that grosses-history.json is missing, so the weekly
 * run can fill a gap left by failed runs (BRO-4623: 2026-09-20 and 2026-09-27
 * were lost while BWW was blocked) without a separate backfill dispatch.
 *
 * Looks only at the `maxWeeks` most recent available weeks before the week
 * being scraped. A week counts as present when any history key is within
 * `toleranceDays` of it: some BWW-era keys landed on a Monday (2026-06-22,
 * 2026-07-06) instead of the Sunday Playbill uses, and those must not be
 * fetched again as duplicates. A gap that fails to backfill stays a gap, so
 * the next run retries it.
 *
 * @param {string[]} historyKeys - Object.keys(history.weeks)
 * @param {string[]} availableWeeks - from parsePlaybillGrossesHtml
 * @param {string} currentWeekISO - the week this run is writing as current
 * @param {number} maxWeeks
 * @param {number} [toleranceDays]
 * @returns {string[]} missing weeks, oldest first
 */
function findMissingHistoryWeeks(historyKeys, availableWeeks, currentWeekISO, maxWeeks, toleranceDays = 3) {
  if (!maxWeeks || maxWeeks <= 0) return [];
  const keyMs = (historyKeys || []).filter(k => ISO_WEEK_RE.test(k)).map(isoToMs);
  const candidates = [...new Set((availableWeeks || []).filter(w => ISO_WEEK_RE.test(w) && w < currentWeekISO))]
    .sort()
    .reverse()
    .slice(0, maxWeeks);
  return candidates
    .filter(w => {
      const ms = isoToMs(w);
      return !keyMs.some(k => Math.abs(k - ms) <= toleranceDays * DAY_MS);
    })
    .sort();
}

module.exports = {
  PLAYBILL_GROSSES_URL,
  TABLE_SCHEMA,
  playbillGrossesUrl,
  parsePlaybillGrossesHtml,
  validatePlaybillGrosses,
  isPlausibleRow,
  findMissingHistoryWeeks,
  isoWeekToMDY,
};
