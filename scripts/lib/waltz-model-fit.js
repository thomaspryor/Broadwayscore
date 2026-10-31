/**
 * Weekly fit check of our single-week profit structure against
 * u/Boring_Waltz_9545's posted "Estimated Profit (Loss)" ranges (BRO-5027).
 *
 * His figures are inference, not truth, so this is an advisory drift signal:
 * it shows how often our model lands inside his closed ranges at HIS posted
 * weekly cost, by gross/cost band. Because the cost is his, the check measures
 * the variable-cost and theater-deal structure, not our cost estimates.
 *
 * data/audit is in the PUBLIC repo, so everything this produces is an
 * aggregate: percentages only, and a band is suppressed below MIN_ROWS rows or
 * MIN_SHOWS distinct shows (a 1-2 show band would be one show's figure).
 *
 * Pure, no IO. The weekly scraper (scrape-boring-waltz-costs.js) builds the
 * rows from the posts it already fetched and writes data/audit/waltz-model-fit.json;
 * health-check.js reads it through fitCheckStatus().
 */
const { extractWeeklyFinancialsFromPost } = require('./reddit-grosses');
const rm = require('./recoupment-model');
const { isPlausibleWeeklyCost } = require('./waltz-cost-gap-fill');

const WINDOW_DAYS = 84; // trailing 12 weeks of his posts
const MIN_ROWS = 5;
const MIN_SHOWS = 3;
const HISTORY_KEEP = 12;
const DRIFT_POINTS = 15;
// The Monday run writes his previous (usually Tuesday) post, so asOf is ~6
// days old at write time. Staleness is judged on the run date; a separate,
// looser bound catches him not posting.
const RUN_STALE_DAYS = 9;
const POSTS_STALE_DAYS = 16;
const STEADY_WEEK = 27; // full nut, no opening surcharge, no mature-run discount

const BANDS = [
  { key: 'low', label: '<0.9x cost', max: 0.9 },
  { key: 'mid', label: '0.9-1.3x', max: 1.3 },
  { key: 'high', label: '>=1.3x', max: Infinity },
];

/** Our pre-recoupment profit for one week at his posted cost, from the model itself. */
function ourWeeklyProfit(gross, nut, show) {
  const category = rm.classifyShow(show);
  return rm.calcWeeklyProfit(gross, nut, rm.getBaseVariableRate(category), false, STEADY_WEEK, false, null, null, show.type, category).profit;
}

/** 0 when inside [low, high], else the signed distance to the nearer bound. */
function rangeError(value, range) {
  if (value < range.low) return value - range.low;
  if (value > range.high) return value - range.high;
  return 0;
}

/**
 * Rows usable for the fit: matched show, gross, cost and a CLOSED profit range
 * (open "$1M+" ranges have no upper bound to land inside), no plausibility flag.
 * @param {Array<{selftext:string, created_utc:number}>} posts relevant posts
 * @param {(showName:string) => object|null} matchShow
 */
function buildFitRows(posts, matchShow) {
  const rows = [];
  for (const post of posts) {
    const postDate = new Date((post.created_utc || 0) * 1000).toISOString().slice(0, 10);
    for (const r of extractWeeklyFinancialsFromPost(post.selftext || '')) {
      if (!r.gross || !isPlausibleWeeklyCost(r.costLow) || !r.profit || r.profit.low == null || r.profit.high == null) continue;
      if (r.flags && r.flags.length) continue;
      const show = matchShow(r.showName);
      if (!show) continue;
      const nut = (r.costLow + (r.costHigh || r.costLow)) / 2;
      const err = rangeError(ourWeeklyProfit(r.gross, nut, show), r.profit);
      rows.push({ postDate, showId: show.id, ratio: r.gross / nut, errPctNut: (100 * err) / nut });
    }
  }
  return rows;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function groupStats(rows) {
  const shows = new Set(rows.map((r) => r.showId)).size;
  if (rows.length < MIN_ROWS || shows < MIN_SHOWS) return { n: rows.length, suppressed: true };
  return {
    n: rows.length,
    shows,
    insidePct: Math.round((100 * rows.filter((r) => r.errPctNut === 0).length) / rows.length),
    medianSignedPctNut: Math.round(10 * median(rows.map((r) => r.errPctNut))) / 10,
  };
}

/** Aggregate the trailing WINDOW_DAYS of rows ending at the newest post. */
function summarizeFit(rows, generatedAt = new Date().toISOString().slice(0, 10)) {
  if (!rows.length) return { asOf: null, generatedAt, weeks: 0, overall: { n: 0, suppressed: true }, bands: {} };
  const asOf = rows.reduce((a, r) => (r.postDate > a ? r.postDate : a), rows[0].postDate);
  const cutoff = new Date(Date.parse(asOf) - WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const inWindow = rows.filter((r) => r.postDate > cutoff);
  const bands = {};
  for (const b of BANDS) {
    const lo = BANDS[BANDS.indexOf(b) - 1]?.max ?? 0;
    bands[b.key] = groupStats(inWindow.filter((r) => r.ratio >= lo && r.ratio < b.max));
  }
  return { asOf, generatedAt, windowDays: WINDOW_DAYS, weeks: new Set(inWindow.map((r) => r.postDate)).size, overall: groupStats(inWindow), bands };
}

/** Append (or replace the same-asOf entry), keeping the newest HISTORY_KEEP. */
function recordFit(history, summary) {
  const kept = (Array.isArray(history) ? history : []).filter((h) => h && h.asOf !== summary.asOf);
  return [...kept, summary].sort((a, b) => String(a.asOf).localeCompare(String(b.asOf))).slice(-HISTORY_KEEP);
}

function bandLine(summary) {
  const part = (label, g) => (g && !g.suppressed ? `${label} ${g.insidePct}% inside (n=${g.n})` : `${label} too few rows`);
  return [part('overall', summary.overall), ...BANDS.map((b) => part(b.label, summary.bands[b.key]))].join('; ');
}

/**
 * Health-check verdict. Advisory: never 'error'.
 * @param {{history?: Array}|null} file parsed data/audit/waltz-model-fit.json
 * @param {Date} [now]
 */
function fitCheckStatus(file, now = new Date()) {
  const history = file && Array.isArray(file.history) ? file.history : [];
  const latest = history[history.length - 1];
  if (!latest || !latest.asOf) {
    return { status: 'warn', message: 'No Boring Waltz fit summary yet (scrape-waltz-costs.yml writes it every Monday)' };
  }
  const days = (date) => Math.floor((now.getTime() - Date.parse(date)) / 864e5);
  const line = `${bandLine(latest)}; his posts to ${latest.asOf}, trailing ${latest.windowDays || WINDOW_DAYS} days`;
  if (days(latest.generatedAt || latest.asOf) > RUN_STALE_DAYS) {
    return { status: 'warn', message: `Fit summary not updated for ${days(latest.generatedAt || latest.asOf)} days (the Monday Waltz cost run may be failing): ${line}` };
  }
  if (days(latest.asOf) > POSTS_STALE_DAYS) {
    return { status: 'warn', message: `No new Boring Waltz post in ${days(latest.asOf)} days: ${line}` };
  }
  const prior = history.slice(0, -1).filter((h) => h.overall && !h.overall.suppressed);
  if (latest.overall && !latest.overall.suppressed && prior.length >= 3) {
    const base = median(prior.map((h) => h.overall.insidePct));
    if (base - latest.overall.insidePct >= DRIFT_POINTS) {
      return { status: 'warn', message: `Fit dropped ${Math.round(base - latest.overall.insidePct)} points below its usual ${Math.round(base)}%: ${line}` };
    }
  }
  return { status: 'pass', message: line };
}

module.exports = { buildFitRows, summarizeFit, recordFit, fitCheckStatus, ourWeeklyProfit, rangeError, MIN_ROWS, MIN_SHOWS };
