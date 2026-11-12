/**
 * score-call-forecasts.js (BRO-7350): ledger -> Supabase sync rows. Pure; the caller reads files.
 * One row per open show: the frozen forecast (last ledger row strictly before opening).
 * NEVER log a row: the Actions log is public and the forecast is private until a reader calls.
 */
'use strict';
const P = require('./review-forecast-pilot');

/** shows = shows.json array; ledgerRows = all ledger rows; reviewCounts = {showId: n reviews}. */
function buildSyncRows({ shows, ledgerRows, today, reviewCounts = {} }) {
  const out = [];
  for (const s of shows) {
    if (!P.isPilotTarget(s, today)) continue;
    const row = P.frozenForecastRow(ledgerRows, s.id, s.openingDate);
    if (!row || typeof row.forecast !== 'number') continue;
    out.push({
      p_show_id: s.id, p_opening: s.openingDate, p_forecast: Math.round(row.forecast),
      p_lo: typeof row.lo80 === 'number' ? Math.round(row.lo80) : null,
      p_hi: typeof row.hi80 === 'number' ? Math.round(row.hi80) : null,
      p_reviews_live: (reviewCounts[s.id] || 0) > 0, p_enabled: true,
    });
  }
  return out;
}

/** data/reviews.json is { _meta, reviews: [ {showId, ...} ] }. Throws on any other shape so a format change is loud, not a silent "no reviews live". */
function countReviewsByShow(json) {
  const list = json && json.reviews;
  if (!Array.isArray(list)) throw new Error('reviews.json: expected { reviews: [] }');
  const counts = {};
  for (const r of list) if (r && typeof r.showId === 'string') counts[r.showId] = (counts[r.showId] || 0) + 1;
  if (!Object.keys(counts).length) throw new Error('reviews.json: no showId on any review');
  return counts;
}

/** Today's date (YYYY-MM-DD) in New York. Openings are NY calendar dates; UTC would flip the day at 7-8pm ET. */
function nyToday(now = new Date()) {
  // formatToParts, not format(): the assembled order must not depend on the runtime's locale data.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = { buildSyncRows, countReviewsByShow, nyToday };
