/**
 * review-forecast-v2-shadow.js (BRO-7357): the v2 SHADOW forecast the nightly pilot stores beside v1.
 * Pure: no fs writes, no network, no clock (callers pass dates). Model = Show Score "mean plus n" from the
 * BRO-7347 backtest: v1 features + audScore + audCount in the same ridge/residual frame, coefficients frozen
 * in review-forecast-v2-model.json (written by `backtest-review-forecast-v2.mjs --freeze=`).
 *
 * Input: the Show Score score and review count already captured nightly in audience-buzz (no new fetch),
 * used only when the capture is dated at or before opening minus LAG_DAYS (same freeze rule as every v2 input).
 * No usable score means v2 equals v1 and inputsPresent says so. Never called for a show that has opened.
 *
 * Training range guard: the backtest's dated member counts stop at TRAIN_COUNT_MAX (12-page cap), while live
 * counts can be several hundred (they can include earlier productions). The count is clamped to that range
 * before shrinking and the row records countClamped.
 * PRIVATE: these values are forecasts. They go only to the private ledger (see forecast-privacy-guard.js).
 */
'use strict';

const RF = require('./review-forecast.js');
const MODEL = require('./review-forecast-v2-model.json');

const SHRINK_K = MODEL.shrinkK;
const SHRINK_CENTER = MODEL.shrinkCenter;
const AUD_COUNT_CENTER = Math.log(60);
const TRAIN_COUNT_MAX = 96;
const MODEL_VERSION = MODEL.modelVersion;
const clamp = (v) => Math.max(0, Math.min(100, v));
const r1 = (x) => Math.round(x * 10) / 10;

/** Keys of the v2 object (the privacy guard derives its field list from this). */
const V2_KEYS = ['forecast', 'forecastRaw', 'lo80', 'hi80', 'inputsPresent', 'modelVersion', 'showScore', 'fallbackReason', 'showScoreMixedProductions'];

/**
 * showScoreMixedProductions: can the live Show Score page aggregate include an EARLIER production's reviews?
 * The v2 model was fit on member reviews dated from 14 days before first preview (earlier-run reviews excluded),
 * so a shared page is a train/live mismatch. Evidence (BRO-7347 sweep, 249 shows): pages whose slug ends
 * "-broadway" are Broadway-specific (3 of 114 had any earlier-run review, 1 material); other pages
 * (shared with an Off-Broadway or West End run) had 44 of 135, 22 with earlier reviews >= 20% of the total.
 * Returns false (Broadway-specific page) or 'unknown' (shared page possible, or no page mapped). Never true:
 * nothing at record time proves a mixture, and v2 falls back to v1 for anything that is not false.
 */
function showScoreMixedProductions(pageUrl) {
  return typeof pageUrl === 'string' && /\/[^/?#]+-broadway\/?$/.test(pageUrl) ? false : 'unknown';
}

/**
 * showScore = { score, count, capturedAt:'YYYY-MM-DD' } or null. v1 = { forecast, forecastRaw, lo80, hi80 }.
 * recordedAt = the ledger day. Returns the v2 object stored on the row.
 */
function buildV2Shadow({ features, v1, showScore, openingDate, recordedAt, pageUrl = null }) {
  const mixed = showScoreMixedProductions(pageUrl);
  const cutoff = RF.toDay(openingDate) - RF.LAG_DAYS;
  const rec = RF.toDay(recordedAt);
  const cap = showScore && showScore.capturedAt ? RF.toDay(showScore.capturedAt) : null;
  let reason = null;
  if (!showScore || typeof showScore.score !== 'number' || !(showScore.count > 0)) reason = 'no Show Score score and count captured';
  else if (cap == null) reason = 'Show Score capture date missing';
  else if (rec == null || rec > cutoff) reason = 'recorded after opening minus 3 days';
  else if (cap > cutoff) reason = 'Show Score capture after opening minus 3 days';
  else if (mixed !== false) reason = 'Show Score page is not Broadway-specific, earlier productions may be mixed in (model trained without them)';
  if (reason) {
    return { forecast: v1.forecast, forecastRaw: v1.forecastRaw, lo80: v1.lo80, hi80: v1.hi80, inputsPresent: ['v1'], modelVersion: MODEL_VERSION, showScore: null, fallbackReason: reason, showScoreMixedProductions: mixed };
  }
  const n = Math.min(showScore.count, TRAIN_COUNT_MAX);
  const shrunk = (n * showScore.score + SHRINK_K * SHRINK_CENTER) / (n + SHRINK_K);
  const x = { ...features.x, audScore: shrunk - SHRINK_CENTER, audCount: Math.log(n + 1) - AUD_COUNT_CENTER };
  const p = clamp(features.mu + RF.predictRidge(MODEL.model, x));
  return {
    forecast: Math.round(p), forecastRaw: r1(p), lo80: Math.round(clamp(p + MODEL.residualQ10)), hi80: Math.round(clamp(p + MODEL.residualQ90)),
    inputsPresent: ['v1', 'showScore'], modelVersion: MODEL_VERSION, fallbackReason: null, showScoreMixedProductions: mixed,
    showScore: { score: showScore.score, count: showScore.count, capturedAt: showScore.capturedAt, countClamped: showScore.count > TRAIN_COUNT_MAX },
  };
}

/** Ledger audience snapshot -> {score,count,capturedAt} for Show Score, capture date from audience-buzz lastUpdated. */
function showScoreInput(buzzEntry) {
  const s = buzzEntry && buzzEntry.sources && buzzEntry.sources.showScore;
  if (!s || typeof s.score !== 'number') return null;
  const t = s.lastUpdated ? String(s.lastUpdated).slice(0, 10) : null;
  return { score: s.score, count: s.reviewCount ?? s.count ?? 0, capturedAt: t && RF.toDay(t) != null ? t : null };
}

/**
 * Frozen v2 row: the latest row recorded at or before opening minus LAG_DAYS whose v2 used Show Score;
 * else null (the caller then grades the v1 frozen row as the fallback).
 */
function frozenV2Row(rows, showId, openingDate) {
  const cutoff = RF.toDay(openingDate) - RF.LAG_DAYS;
  let best = null;
  for (const r of rows) {
    if (r.showId !== showId || !r.v2 || !r.v2.inputsPresent || !r.v2.inputsPresent.includes('showScore')) continue;
    if (RF.toDay(r.recordedAt) > cutoff) continue;
    if (!best || r.recordedAt > best.recordedAt) best = r;
  }
  return best;
}

module.exports = { MODEL_VERSION, TRAIN_COUNT_MAX, V2_KEYS, showScoreMixedProductions, buildV2Shadow, showScoreInput, frozenV2Row };
