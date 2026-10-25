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
 *   <option value="https://playbill.com/grosses?week=2026-09-13" selected>2026-09-13</option>
 *                            → week read from the option text (value as fallback)
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
 *                  fail the arithmetic check and fall back to the value
 *                  attendance ÷ % Cap implies (deriveSeatsOffered in
 *                  grosses-history-repair.js). That per-row check keeps a
 *                  wrong value out of RevPAS math.
 *   - grossPrevWeek / capacityPctPrevWeek  derived from the Diff $ and
 *                  Diff % cap columns (this week minus diff), which is
 *                  what BWW published directly in its prev-week columns.
 *
 * Column positions are resolved from the header text by EXACT label (BRO-2375
 * column-drift class; exact because "% Cap" is a substring of "Diff % cap")
 * and the header is checked with assertTableSchema before any row is read,
 * so a Playbill layout change fails loud instead of silently mis-assigning
 * values.
 */
const cheerio = require('cheerio');
const { assertTableSchema, TableSchemaError } = require('./table-schema-assertion');
// Same value parsers and row sanity ranges as the BWW tiers, so both sources
// read and reject values by one rule.
const {
  parseCurrency: parseMoney,
  parsePercentage: parsePct,
  parseNumber: parseCount,
  isSaneGrossesRow,
} = require('./parse-bww-grosses-row');
const { deriveSeatsOffered } = require('./grosses-history-repair');
const { runWeekWindow, isBroadway, sameWork } = require('./grosses-run-window');

const PLAYBILL_GROSSES_URL = 'https://playbill.com/grosses';

const TABLE_SCHEMA = {
  minCells: 8,
  expectedHeaders: ['Show', 'This Week Gross', 'Diff $', 'Avg Ticket', 'Seats Sold', 'Perfs', '% Cap', 'Diff % cap'],
};

// Column key → exact header label (the <th> link text, subtext excluded).
const COLUMN_LABELS = {
  show: 'Show',
  gross: 'This Week Gross',
  grossDiff: 'Diff $',
  atp: 'Avg Ticket',
  seats: 'Seats Sold',
  perfs: 'Perfs',
  cap: '% Cap',
  capDiff: 'Diff % cap',
};

const normalizeLabel = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const ISO_WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

function playbillGrossesUrl(week) {
  if (!week) return PLAYBILL_GROSSES_URL;
  if (!ISO_WEEK_RE.test(week)) throw new Error(`playbillGrossesUrl: week must be YYYY-MM-DD, got "${week}"`);
  return `${PLAYBILL_GROSSES_URL}?week=${week}`;
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
  // Without a .data-value span, the main figure is the cell text minus the
  // subtext; whole-cell text would glue "6,847" and "1,026" into one number.
  const mainText = main.length ? main.text() : $td.clone().find('.subtext').remove().end().text();
  return {
    main: mainText.replace(/\s+/g, ' ').trim(),
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
    // The week is the option's text ("2026-09-13"). The ?week= link in its
    // value is only a fallback, should Playbill ever relabel the options.
    const text = $(el).text().trim();
    const fromValue = (($(el).attr('value') || '').match(/[?&]week=(\d{4}-\d{2}-\d{2})\b/) || [])[1];
    const week = ISO_WEEK_RE.test(text) ? text : fromValue;
    if (!week) return;
    availableWeeks.push(week);
    if (weekEnding === null && $(el).attr('selected') !== undefined) weekEnding = week;
  });

  let weekTotalGross = null;
  $('.week-total .accent').each((_i, el) => {
    if (weekTotalGross === null) weekTotalGross = parseMoney($(el).text());
  });

  const $table = $('table').filter((_i, el) => $(el).find('td[data-label]').length > 0).first();
  // Main header label only: each <th> is "<a>Label</a><span class="subtext">
  // Paired label</span>", and the subtext must not leak into the match.
  const headerCells = $table.find('thead th').map((_i, el) => {
    const $th = $(el).clone();
    $th.find('.subtext').remove();
    return $th.text().replace(/\s+/g, ' ').trim();
  }).get();

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

  // Exact label match only. findColumnIndex falls back to a substring match,
  // and assertTableSchema checks substrings too, so a renamed "% Cap" column
  // would otherwise resolve to "Diff % cap" and store the week-over-week diff
  // as capacity.
  const exactIndex = (label) => headerCells.findIndex(h => normalizeLabel(h) === normalizeLabel(label));
  const idx = {};
  for (const [key, label] of Object.entries(COLUMN_LABELS)) {
    idx[key] = exactIndex(label);
    if (idx[key] === -1) {
      result.schemaError = `column "${label}" not found (exact header match). Header row: ${JSON.stringify(headerCells)}`;
      return result;
    }
  }
  const maxIdx = Math.max(...Object.values(idx));

  $table.find('tbody tr').each((_i, tr) => {
    const tds = $(tr).find('td');
    if (tds.length <= maxIdx) return;

    const showCell = cellParts($, tds[idx.show]);
    const show = showCell.main;
    // Playbill's table has no total row today (the total sits above it); only
    // an exact "Total(s)" label is skipped, so a show whose title merely
    // starts with "Total" is never dropped.
    if (!show || /^(week'?s\s+)?totals?:?$/i.test(show)) return;

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
    // weeks running), so only the gross diff decides first-week status, and
    // with no readable gross diff neither prev-week field is derived.
    const firstWeek = grossDiff === 0;
    const hasPrevWeek = grossDiff != null && !firstWeek;
    let grossPrevWeek = null;
    if (hasPrevWeek && grossRaw != null) {
      const prev = Math.round(grossRaw - grossDiff);
      grossPrevWeek = prev > 0 ? prev : null;
    }
    let capacityPctPrevWeek = null;
    if (hasPrevWeek && capacityPct != null && capacityDiff != null) {
      const prev = round2(capacityPct - capacityDiff);
      capacityPctPrevWeek = prev > 0 ? prev : null;
    }

    let seatsOffered = null;
    if (seatsInTheatre && performances && attendance != null && capacityPct != null) {
      const offered = seatsInTheatre * performances;
      if (Math.abs((attendance / offered) * 100 - capacityPct) < 0.05) seatsOffered = offered;
    }
    // Seats in Theatre that miss the published % Cap (often one seat off):
    // fall back to the seats offered the published figures imply (BRO-4985).
    if (seatsOffered == null && performances) {
      seatsOffered = deriveSeatsOffered({ attendance, capacity: capacityPct, performances });
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
 * The Week's Total checksum holds for every week sampled from 2022 on, but
 * some older Playbill weeks (e.g. 1999-06-06, 2015-11-01, 2020-03-08,
 * 2021-09-19) print a total their own table does not add up to. A caller
 * filling old history, where a page's rows are the best record there is, can
 * pass `allowTotalMismatch` and get the mismatch back from weekTotalMismatch()
 * to log instead. The weekly scraper never does: for a current week a
 * mismatch means a dropped row and must fail loud.
 *
 * @param {ReturnType<typeof parsePlaybillGrossesHtml>} parsed
 * @param {{ expectedWeek?: string, allowTotalMismatch?: boolean }} [opts]
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
  const mismatch = weekTotalMismatch(parsed);
  if (mismatch && !opts.allowTotalMismatch) problems.push(mismatch);
  return problems;
}

/**
 * The checksum problem, or null when the rows add up (or there is no total).
 * Row grosses are rounded to whole dollars, so $1 per row of drift is allowed.
 *
 * @param {ReturnType<typeof parsePlaybillGrossesHtml>} parsed
 * @returns {string|null}
 */
function weekTotalMismatch(parsed) {
  if (!parsed || parsed.weekTotalGross == null || parsed.rows.length === 0) return null;
  const sum = parsed.rows.reduce((acc, r) => acc + (r.gross || 0), 0);
  if (Math.abs(sum - parsed.weekTotalGross) <= parsed.rows.length) return null;
  return `row grosses sum to $${sum} but Week's Total is $${parsed.weekTotalGross}`;
}

/**
 * The structural sanity ranges the BWW rows use (isSaneGrossesRow in
 * parse-bww-grosses-row.js: ATP $15-$1000, 1-16 performances, 5-120%
 * capacity). A row outside them means a column was mis-read; the caller
 * drops it loudly. Rows with no gross (dark week) are always kept.
 */
const isPlausibleRow = isSaneGrossesRow;

/**
 * One grosses-history.json entry from a parsed row (Playbill or BWW: both
 * use these field names). Every history writer goes through this, so a week
 * has the same shape whichever path wrote it.
 *
 * @param {{ gross: number|null, capacityPct: number|null, atp: number|null, attendance: number|null, seatsOffered?: number|null, performances: number|null }} row
 */
function toHistoryEntry(row) {
  return {
    gross: row.gross,
    capacity: row.capacityPct,
    atp: row.atp,
    attendance: row.attendance,
    seatsOffered: row.seatsOffered ?? null,
    performances: row.performances,
  };
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
  const candidates = [...new Set((availableWeeks || []).filter(w => ISO_WEEK_RE.test(w) && w < currentWeekISO))]
    .sort()
    .reverse()
    .slice(0, maxWeeks);
  return candidates.filter(w => !historyHasWeek(historyKeys, w, toleranceDays)).sort();
}

/**
 * The grosses-history.json key that already holds `week`: the week's own key,
 * else the nearest key within `toleranceDays` (the BWW-era Monday keys
 * 2026-06-22, 06-29 and 07-06 stood for the Sundays before them until
 * grosses-history-repair.js moved them, BRO-4985), else null.
 * Weeks are 7 days apart, so a key that close is the same week. Writers store
 * a week under this key when there is one, so none of them adds a Sunday
 * duplicate next to a Monday key (calculate-recoupment.js sums every week,
 * and data-commercial.ts picks weeks by position).
 *
 * @param {string[]} historyKeys
 * @param {string} week - YYYY-MM-DD
 * @param {number} [toleranceDays]
 * @returns {string|null}
 */
function findHistoryKey(historyKeys, week, toleranceDays = 3) {
  if (!ISO_WEEK_RE.test(week || '')) return null;
  const keys = historyKeys || [];
  if (keys.includes(week)) return week;
  const ms = isoToMs(week);
  let best = null;
  let bestDiff = Infinity;
  for (const k of keys) {
    if (!ISO_WEEK_RE.test(k)) continue;
    const diff = Math.abs(isoToMs(k) - ms);
    if (diff <= toleranceDays * DAY_MS && diff < bestDiff) {
      best = k;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * True when grosses-history.json already holds `week` (see findHistoryKey).
 *
 * @param {string[]} historyKeys
 * @param {string} week - YYYY-MM-DD
 * @param {number} [toleranceDays]
 */
function historyHasWeek(historyKeys, week, toleranceDays = 3) {
  return findHistoryKey(historyKeys, week, toleranceDays) !== null;
}

// The League's weekly figures come out on Monday afternoon US Eastern time.
// 18:00 UTC Monday is taken as the point after which a week counts as out.
const RELEASE_LAG_MS = (24 + 18) * 60 * 60 * 1000;

/**
 * The newest week ending whose figures can already be out on `now`: the
 * latest Sunday at least a day and 18 hours ago (released by Monday 18:00
 * UTC). Before that on a Monday, and all of Sunday, it is the Sunday a week
 * earlier, so an early run does not go looking for a week nobody has yet.
 *
 * @param {Date} now
 * @returns {string} YYYY-MM-DD
 */
function latestPublishableWeek(now) {
  const t = new Date(now.getTime() - RELEASE_LAG_MS);
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/**
 * Weeks the history holds but that miss a show it holds the weeks either side
 * of: a week scraped short (2026-03-29 has 26 of Playbill's 36 rows, so Death
 * of a Salesman's own-run total came up three weeks short, BRO-5016). Holes
 * are measured in calendar weeks, not stored keys, so a week missing from the
 * history altogether never stretches a hole; only holes of at most
 * `maxHoleWeeks` count, a longer one is a hiatus (Take Me Out went dark for
 * four months in 2022), not a scrape gap. Weeks with no key at all are not
 * listed here: a plain `--start-from` backfill fetches those.
 *
 * @param {{weeks: Record<string, Record<string, object>>}} history
 * @param {{maxHoleWeeks?: number}} [opts]
 * @returns {{week: string, slugs: string[]}[]} stored weeks to refill, oldest
 *   first, with the shows each one is missing
 */
function findShortHistoryWeeks(history, { maxHoleWeeks = 4 } = {}) {
  const weeks = Object.keys(history?.weeks || {}).filter(w => ISO_WEEK_RE.test(w)).sort();
  const ms = w => Date.parse(`${w}T00:00:00Z`);
  const seen = new Map();
  const out = new Map();
  weeks.forEach((w, i) => {
    for (const slug of Object.keys(history.weeks[w] || {})) {
      const prev = seen.get(slug);
      seen.set(slug, i);
      if (prev == null) continue;
      const missing = Math.round((ms(w) - ms(weeks[prev])) / (7 * DAY_MS)) - 1;
      if (missing < 1 || missing > maxHoleWeeks) continue;
      for (let j = prev + 1; j < i; j++) {
        if (!out.has(weeks[j])) out.set(weeks[j], new Set());
        out.get(weeks[j]).add(slug);
      }
    }
  });
  return [...out.keys()].sort().map(week => ({ week, slugs: [...out.get(week)].sort() }));
}

/**
 * Stored weeks inside the run of a Broadway production the history holds no
 * row for at all: its title never matched (Playbill's "Back To The Future"
 * first matched the West End run, "The Best Man" only fuzzily), so every week
 * of it was dropped. Only runs wholly inside the history and longer than one
 * night count. A week where a parked row of the same work waits is left to
 * the save-time repair, which re-homes it.
 *
 * @param {{weeks: Record<string, Record<string, object>>, _unplacedRows?: object}} history
 * @param {object[]} shows shows.json entries
 * @returns {{week: string, slugs: string[]}[]} oldest first
 */
function findUnstoredRunWeeks(history, shows, nowMs = Date.now()) {
  const weeks = Object.keys(history?.weeks || {}).filter(w => ISO_WEEK_RE.test(w)).sort();
  if (!weeks.length) return [];
  const ms = w => Date.parse(`${w}T00:00:00Z`);
  const stored = new Set();
  for (const w of weeks) for (const slug of Object.keys(history.weeks[w] || {})) stored.add(slug);
  const bySlug = new Map((shows || []).map(s => [s.slug || s.id, s]));
  const parked = history._unplacedRows || {};
  const [first, last] = [ms(weeks[0]), ms(weeks[weeks.length - 1])];
  const out = new Map();
  for (const show of shows || []) {
    const slug = show && (show.slug || show.id);
    if (!slug || stored.has(slug) || !isBroadway(show) || !show.closingDate || show.closingDate === show.openingDate) continue;
    const win = runWeekWindow(show, nowMs);
    if (!win || win.startMs < first || win.endMs > last) continue;
    for (const w of weeks) {
      const t = ms(w);
      if (t < win.startMs || t > win.endMs) continue;
      if (Object.keys(parked[w] || {}).some(p => sameWork(show, bySlug.get(p)))) continue;
      if (!out.has(w)) out.set(w, new Set());
      out.get(w).add(slug);
    }
  }
  return [...out.keys()].sort().map(week => ({ week, slugs: [...out.get(week)].sort() }));
}

/**
 * Add to a stored week the rows a fresh scrape of it has for `onlySlugs`, the
 * shows the week is known to be missing. A row the week already holds is never
 * touched, and nothing else from the scrape is added (a show the resolver maps
 * differently this time must not appear beside its stored twin).
 * @returns {string[]} the slugs added
 */
function addMissingRows(weekRows, snapshot, onlySlugs) {
  const added = [];
  for (const slug of onlySlugs || []) {
    if (weekRows[slug] || !snapshot?.[slug]) continue;
    weekRows[slug] = snapshot[slug];
    added.push(slug);
  }
  return added;
}

module.exports = {
  findShortHistoryWeeks,
  findUnstoredRunWeeks,
  addMissingRows,
  PLAYBILL_GROSSES_URL,
  TABLE_SCHEMA,
  playbillGrossesUrl,
  parsePlaybillGrossesHtml,
  validatePlaybillGrosses,
  weekTotalMismatch,
  isPlausibleRow,
  toHistoryEntry,
  findMissingHistoryWeeks,
  findHistoryKey,
  historyHasWeek,
  latestPublishableWeek,
  isoWeekToMDY,
};
