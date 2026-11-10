/**
 * review-forecast-pilot.js (BRO-7329): pure helpers for the quiet review-forecast pilot.
 * No fs, no network, no clock (callers pass `today`).
 *
 * The pilot appends one dated row per upcoming Broadway show per day to a PRIVATE
 * ledger (the repo is public, a committed forecast would be a published claim).
 * The frozen forecast for a show is the LAST row recorded strictly before its
 * opening night. Grading happens GRADE_AFTER_DAYS after opening.
 *
 * Model code is NOT here: features, ridge and leakage checks stay in
 * review-forecast.js. This file only decides who gets a row, what a row holds,
 * which rows may be appended, and how grades are scored.
 */
'use strict';

const RF = require('./review-forecast');

const PREVIEW_LOOKAHEAD_DAYS = 60; // a show is tracked once its first preview is this close
const REDDIT_LEADUP_DAYS = 60; // Reddit window starts this long before first preview
const GRADE_AFTER_DAYS = 14;

const iso = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
const addDays = (isoDate, n) => iso(RF.toDay(isoDate) + n);
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

/** Broadway play or musical, opening strictly after `today`, in previews or first preview within 60 days. */
function isPilotTarget(show, today) {
  if (!show || show.category !== 'broadway') return false;
  if (show.type !== 'play' && show.type !== 'musical') return false;
  if (show.cancelledBeforeOpening || show.status === 'closed') return false;
  const open = RF.toDay(show.openingDate);
  const t = RF.toDay(today);
  if (open == null || t == null || !(open > t)) return false;
  const prev = RF.toDay(show.previewsStartDate || show.previewDate);
  if (show.status === 'previews') return true;
  return prev != null && prev <= t + PREVIEW_LOOKAHEAD_DAYS;
}

/** A row may exist only if it is dated strictly before opening night. */
function canRecord(recordedAt, openingDate) {
  const r = RF.toDay(recordedAt);
  const o = RF.toDay(openingDate);
  return r != null && o != null && r < o;
}

/** The frozen forecast: the latest row for the show dated strictly before openingDate. */
function frozenForecastRow(rows, showId, openingDate) {
  let best = null;
  for (const r of rows) {
    if (r.showId !== showId || !canRecord(r.recordedAt, openingDate)) continue;
    if (!best || r.recordedAt > best.recordedAt) best = r;
  }
  return best;
}

/** Split candidate rows into those to append and those skipped (leakage or already recorded that day). */
function selectAppendable(existingRows, candidates) {
  const seen = new Set(existingRows.map((r) => `${r.showId}|${r.recordedAt}`));
  const append = []; const skipped = [];
  for (const c of candidates) {
    const key = `${c.showId}|${c.recordedAt}`;
    if (!canRecord(c.recordedAt, c.openingDate)) skipped.push({ row: c, why: 'recordedAt not before openingDate' });
    else if (seen.has(key)) skipped.push({ row: c, why: 'already recorded for this day' });
    else { seen.add(key); append.push(c); }
  }
  return { append, skipped };
}

/** audience-buzz entry -> {combined, designation, totalCount, sources}. Null-safe. */
function audienceSnapshot(entry) {
  if (!entry) return { combined: null, designation: null, totalCount: 0, sources: {} };
  const sources = {};
  let total = 0;
  for (const [name, s] of Object.entries(entry.sources || {})) {
    if (!s || typeof s.score !== 'number') continue;
    const count = s.reviewCount ?? s.count ?? 0;
    sources[name] = { score: s.score, count };
    total += count;
  }
  return { combined: typeof entry.combinedScore === 'number' ? entry.combinedScore : null, designation: entry.designation || null, totalCount: total, sources };
}

/**
 * Reddit aggregate for one show on one day. `posts` are raw Reddit post objects
 * (created_utc, num_comments, score, upvote_ratio). Window = [previewsStart - leadup, today].
 * Posts are split into `leadup` (before first preview) and `previews` buckets.
 * Posts created after the end of `today` UTC are dropped, so a re-run never sees the future.
 */
function redditAggregate(posts, { previewsStartDate, today, leadupDays = REDDIT_LEADUP_DAYS }) {
  const prev = RF.toDay(previewsStartDate);
  const t = RF.toDay(today);
  if (prev == null || t == null) return { available: false, reason: 'no previewsStartDate' };
  const start = prev - leadupDays;
  const end = t + 1; // exclusive, end of today UTC
  const bucket = () => ({ posts: 0, comments: 0, scoreSum: 0, ratioSum: 0, ratioN: 0 });
  const lead = bucket(); const prv = bucket();
  const seen = new Set();
  for (const p of posts) {
    if (!p || !p.created_utc) continue;
    if (p.id != null) { if (seen.has(p.id)) continue; seen.add(p.id); }
    const d = p.created_utc / 86400;
    if (d < start || d >= end) continue;
    const b = d < prev ? lead : prv;
    b.posts += 1; b.comments += p.num_comments || 0; b.scoreSum += p.score || 0;
    if (typeof p.upvote_ratio === 'number') { b.ratioSum += p.upvote_ratio; b.ratioN += 1; }
  }
  const fin = (b) => ({ postCount: b.posts, commentCount: b.comments, meanPostScore: b.posts ? r1(b.scoreSum / b.posts) : null, meanUpvoteRatio: b.ratioN ? Math.round((b.ratioSum / b.ratioN) * 100) / 100 : null });
  return { available: true, windowStart: iso(start), windowEnd: today, leadupDays, leadup: fin(lead), previews: fin(prv) };
}

/**
 * Full-sample ridge fit plus a nested leave-one-season-out 80% band, using the real
 * review-forecast.js ridge. rows = [{season, x, mu, y}]. Returns null if < minRows.
 */
function fitForecaster(rows, { minRows = 150 } = {}) {
  if (rows.length < minRows) return null;
  const toTrain = (rs) => rs.map((r) => ({ x: r.x, y: r.y - r.mu }));
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const model = RF.fitRidge(toTrain(rows), RF.FEATURE_NAMES);
  const resid = [];
  for (const s of [...new Set(rows.map((r) => r.season))]) {
    const tr = rows.filter((r) => r.season !== s); const te = rows.filter((r) => r.season === s);
    if (tr.length < 60) continue;
    const m = RF.fitRidge(toTrain(tr), RF.FEATURE_NAMES);
    for (const r of te) resid.push(r.y - clamp(r.mu + RF.predictRidge(m, r.x)));
  }
  resid.sort((a, b) => a - b);
  const q10 = RF.quantile(resid, 0.1); const q90 = RF.quantile(resid, 0.9);
  return {
    n: rows.length,
    predict(f) {
      const p = clamp(f.mu + RF.predictRidge(model, f.x));
      return { forecast: p, lo80: clamp(p + q10), hi80: clamp(p + q90) };
    },
  };
}

function isGradeDue(openingDate, today) {
  const o = RF.toDay(openingDate); const t = RF.toDay(today);
  return o != null && t != null && t - o >= GRADE_AFTER_DAYS;
}

/**
 * One grade row, or null when not gradable yet (not due, no critic score, no frozen row).
 * `frozen` = frozenForecastRow(...). Errors are absolute misses against criticScore.
 */
function buildGradeRow({ showId, openingDate, today, frozen, criticScore }) {
  if (!isGradeDue(openingDate, today) || criticScore == null || !frozen) return null;
  const miss = (v) => (typeof v === 'number' ? r1(Math.abs(criticScore - v)) : null);
  const audience = frozen.audience ? frozen.audience.combined : null;
  return {
    showId, gradedAt: today, openingDate, criticScore, frozenRecordedAt: frozen.recordedAt,
    forecast: frozen.forecast, categoryMean: frozen.categoryMean, previewAudience: audience,
    missForecast: miss(frozen.forecast), missCategoryMean: miss(frozen.categoryMean), missPreviewAudience: miss(audience),
    inRange80: typeof frozen.lo80 === 'number' ? criticScore >= frozen.lo80 && criticScore <= frozen.hi80 : null,
  };
}

/** Running scoreboard over grade rows: n, mean absolute miss per method, range hit rate. */
function scoreboard(grades) {
  const avg = (k) => { const v = grades.map((g) => g[k]).filter((x) => typeof x === 'number'); return v.length ? { n: v.length, mae: r1(RF.mean(v)) } : { n: 0, mae: null }; };
  const hits = grades.map((g) => g.inRange80).filter((x) => typeof x === 'boolean');
  return {
    shows: grades.length,
    forecast: avg('missForecast'), categoryMean: avg('missCategoryMean'), previewAudience: avg('missPreviewAudience'),
    range80HitRate: hits.length ? Math.round((hits.filter(Boolean).length / hits.length) * 100) / 100 : null,
  };
}

module.exports = {
  PREVIEW_LOOKAHEAD_DAYS, REDDIT_LEADUP_DAYS, GRADE_AFTER_DAYS,
  isPilotTarget, canRecord, frozenForecastRow, selectAppendable, audienceSnapshot,
  redditAggregate, fitForecaster, isGradeDue, buildGradeRow, scoreboard, addDays,
};
