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
      // True 50% band when the ledger row has one; omitted lets sync_score_call_show derive it (the only derivation).
      // Keys are left out (not null) when absent, so a loader running before the 20261113 migration still matches the old function.
      ...(typeof row.lo50 === 'number' && typeof row.hi50 === 'number' ? { p_lo50: Math.round(row.lo50), p_hi50: Math.round(row.hi50) } : {}),
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

/** Shows whose reviews_live flag must be explicitly cleared: only rows the sync computed as having no live reviews. */
function clearTargets(rows) {
  return rows.filter((r) => r && r.p_reviews_live === false).map((r) => r.p_show_id);
}

/**
 * BRO-7857: shows whose predictions must close because a review is about to go live. Every Broadway play or
 * musical with at least one review whose opening is no more than LOOKBACK_DAYS ago (older rows are past the
 * server backstop already). A show with a review before opening (a stray row) closes too; to reopen it, remove the
 * row, and the nightly sync's explicit clear (pre-opening shows only) then clears the flag. Ids only, sorted.
 */
// Past opening + grace + 1 the server backstop has closed the show anyway (src/lib/score-call.js CALL_GRACE_DAYS).
const LIVE_LOOKBACK_DAYS = require('../../src/lib/score-call.js').CALL_GRACE_DAYS + 2;
function reviewsLiveTargets({ shows, reviewCounts, today }) {
  const t = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`bad today: ${today}`);
  const out = [];
  for (const s of shows) {
    if (!s || s.category !== 'broadway' || (s.type !== 'play' && s.type !== 'musical')) continue;
    if (!((reviewCounts[s.id] || 0) > 0)) continue;
    const o = typeof s.openingDate === 'string' ? Date.parse(`${s.openingDate.slice(0, 10)}T00:00:00Z`) : NaN;
    if (!Number.isFinite(o) || o < t - LIVE_LOOKBACK_DAYS * 86400000) continue;
    out.push(s.id);
  }
  return out.sort();
}

/** Today's date (YYYY-MM-DD) in New York: one copy, shared with the site (src/lib/score-call.js). */
const { nyToday } = require('../../src/lib/score-call.js');

module.exports = { buildSyncRows, countReviewsByShow, nyToday, clearTargets, reviewsLiveTargets, LIVE_LOOKBACK_DAYS };
