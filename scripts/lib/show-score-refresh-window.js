// BRO-7372: which shows the daily Show Score refresh re-fetches.
// Rule (a), the original: open/previews shows whose openingDate is within [now-lookback, now+lookAhead].
// Rule (b): Off-Broadway critics often publish during previews, well before the official opening
// (the ripple, the wave that carried me home: opens 2026-11-18, three critic reviews 2026-11-10).
// Show Score already listed one, but our snapshot stayed at 0 critics until the opening window
// began. So a show opening within the next earlyAheadDays whose reviews on file include one dated
// since its previews began (the wave has started) is refreshed too.
const DAY_MS = 86400000;
const { toDateMs } = require('./date-utils'); // handles ordinal dates like ISO (BRO-2836)
const MONTH_ONLY_RE = /^\d{4}-\d{2}$/; // a month-only publishDate proves nothing

function selectRefreshShows(shows, reviews, { nowMs = Date.now(), lookbackDays = 2, lookAheadDays = 2, earlyAheadDays = 14 } = {}) {
  const cutoff = nowMs - lookbackDays * DAY_MS;
  const lookAhead = nowMs + lookAheadDays * DAY_MS;
  const earlyLimit = nowMs + earlyAheadDays * DAY_MS;
  const latestReview = new Map();
  for (const r of reviews || []) {
    if (!r || !r.showId || MONTH_ONLY_RE.test(String(r.publishDate || ''))) continue;
    const t = toDateMs(r.publishDate);
    if (Number.isFinite(t) && t > (latestReview.get(r.showId) ?? -Infinity)) latestReview.set(r.showId, t);
  }
  return (shows || []).filter((s) => {
    if (!s.openingDate || (s.status !== 'open' && s.status !== 'previews')) return false;
    const open = Date.parse(s.openingDate);
    if (!Number.isFinite(open)) return false;
    if (open >= cutoff && open <= lookAhead) return true; // rule (a)
    if (open <= lookAhead || open > earlyLimit) return false;
    const since = Date.parse(s.previewsStartDate || '');
    const last = latestReview.get(s.id);
    return last !== undefined && last >= (Number.isFinite(since) ? since : nowMs - earlyAheadDays * DAY_MS); // rule (b)
  }).map((s) => s.id);
}
module.exports = { selectRefreshShows };
