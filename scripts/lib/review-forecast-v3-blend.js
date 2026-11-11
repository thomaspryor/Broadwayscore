/**
 * review-forecast-v3-blend.js (BRO-7382): the v3 "earlier-run blend" SHADOW forecast the nightly pilot stores beside v1 and v2.
 * Pure: no fs, no network, no clock (callers pass dates and data). Pre-registered spec on the card:
 *   v3 = base (v2, or v1 when v2 fell back) blended with the earlier-run critic score at a walk-forward weight.
 *   Earlier-run score = mean of the earlier production's reviews dated on or before min(day before first preview, opening minus 3 days)
 *   (EA.earlierCutoff), own record first (EC.findEarlier + reviewsByShow), else the web-collected compact file. Shrunk toward the
 *   baseline mean mu by review count, k = EC_K. Weight = grid 0..1 step 0.1 minimizing MAE on the carrying rows of EARLIER seasons
 *   (0 when fewer than MIN_WEIGHT_ROWS). Applied only when such a score exists; otherwise v3 = base. Frozen at opening minus 3 days.
 * The weight rows (data/audit/review-forecast-v3-weight-rows.json, written by `backtest-review-forecast-v2.mjs --export-v3-rows=`)
 * hold one walk-forward v1 and v2 prediction per historical show, so the weight is fitted on the base actually used live.
 * PRIVATE: every v3 value is a forecast. Ledger only (see forecast-privacy-guard.js). All v3 field names carry a `v3` prefix so the
 * guard can flag them without matching generic names.
 */
'use strict';

const RF = require('./review-forecast.js');
const EA = require('./review-forecast-v2-earlier-audience.js');
const EC = require('./review-forecast-v2-earlier-critics.js');
const ER = require('./review-forecast-v2-earlier-run.js');

const { toDay } = RF;
const MODEL_VERSION = 'rf-v3-earlier-blend-2026-11-11';
const SHRINK_K = EC.EC_K;
const MIN_WEIGHT_ROWS = 10;
const GRID = Array.from({ length: 11 }, (_, i) => i / 10);
const clamp = (v) => Math.max(0, Math.min(100, v));
const r1 = (x) => Math.round(x * 10) / 10;

/** Keys of the v3 object on a ledger row (the privacy guard derives its field list from this). */
const V3_KEYS = ['v3Forecast', 'v3ForecastRaw', 'v3Lo80', 'v3Hi80', 'v3Base', 'v3Weight', 'v3EarlierScore', 'v3EarlierRaw', 'v3EarlierN',
  'v3EarlierSource', 'v3Origin', 'v3Applied', 'v3ModelVersion', 'v3FallbackReason', 'v3EarlierRef'];
/** Keys v3 adds to a grade row. */
const V3_GRADE_KEYS = ['forecastV3', 'missForecastV3', 'v3BaseSameRow', 'missV3BaseSameRow', 'v3RecordedAt', 'v3Applied', 'v3Origin', 'v3EarlierSource', 'v3EarlierN', 'v3Weight', 'v3Base', 'v3ModelVersion'];

/**
 * Per-show dated, scored, in-production reviews (wrongProduction / wrongShow / roundups excluded, as in the composite).
 * ONE implementation for the backtest and the nightly recorder so training and live cannot drift (BRO-7382 review).
 * `extra(review, show)` may add fields (the backtest adds tier weights). poolById: id -> {category,...}.
 */
function buildReviewsByShow(allReviews, poolById, extra = null) {
  const m = new Map();
  for (const r of allReviews) {
    if (r.assignedScore == null || !r.publishDate || !r.outletId || r.wrongProduction || r.wrongShow || r.isRoundupArticle) continue;
    const s = poolById[r.showId]; const day = toDay(r.publishDate); if (!s || day == null) continue;
    if (!m.has(r.showId)) m.set(r.showId, []);
    m.get(r.showId).push({ day, score: r.assignedScore, ...(extra ? extra(r, s) : {}) });
  }
  return m;
}

/** Origin label from the earlier production's market (own record) or the static route in show-origins (web-collected scores). */
function originLabel(ownCategory, originsRec) {
  if (ownCategory === 'off-broadway') return 'Off-Broadway';
  if (ownCategory === 'west-end' || ownCategory === 'off-west-end') return 'London';
  const path = originsRec && Array.isArray(originsRec.path) ? originsRec.path : [];
  if (path.includes('regional-us')) return 'out-of-town';
  if (path.includes('london')) return 'London';
  if (path.includes('off-broadway')) return 'Off-Broadway';
  return 'unknown';
}

/**
 * The target's earlier-run score, or null. target needs id, title, openingDate, previewsStartDate.
 * ctx = { pool, reviewsByShow, earlierRun (compact file .reviews), origins }. mu = the baseline (category) mean.
 * Returns { n, raw (plain mean), score (shrunk toward mu), source, origin, ref, newest } where newest is the latest review date used.
 */
function earlierRunScore(target, ctx, mu) {
  if (mu == null) return null;
  const cutoffIso = EA.earlierCutoff(target); const cut = toDay(cutoffIso);
  const shrink = (n, mean) => (n * mean + SHRINK_K * mu) / (n + SHRINK_K);
  const own = EC.findEarlier(target, ctx, cutoffIso);
  if (own) {
    const rv = ((ctx.reviewsByShow && ctx.reviewsByShow.get(own.id)) || []).filter((r) => r.day <= cut);
    if (rv.length) {
      const raw = RF.mean(rv.map((r) => r.score));
      return { n: rv.length, raw, score: shrink(rv.length, raw), source: 'own-record', origin: originLabel(own.category, null), ref: own.id,
        newest: new Date(Math.max(...rv.map((r) => r.day)) * 86400000).toISOString().slice(0, 10) };
    }
  }
  const kept = [];
  for (const [score, date] of (ctx.earlierRun && ctx.earlierRun[target.id]) || []) {
    const d = ER.latestDay(date);
    if (d == null || toDay(d) == null || toDay(d) > cut) continue; // undated or too late: never used
    kept.push({ score, date: d });
  }
  if (!kept.length) return null;
  const raw = RF.mean(kept.map((k) => k.score));
  return { n: kept.length, raw, score: shrink(kept.length, raw), source: 'web-compact', origin: originLabel(null, ctx.origins && ctx.origins[target.id]), ref: null, newest: kept.map((k) => k.date).sort().pop() };
}

/** Throws if the earlier score used a review dated after the target's earlier-run cutoff. */
function assertNoLeakageV3(target, earlier) {
  if (earlier && earlier.newest > EA.earlierCutoff(target)) throw new Error(`LEAKAGE(v3) for ${target.id}: review dated ${earlier.newest} is after ${EA.earlierCutoff(target)}`);
  return true;
}

/**
 * Walk-forward weight. rows = [{season, y, baseV1, baseV2, ec}] (carrying rows only). baseKind 'v1' | 'v2'.
 * v2 base fits only rows where the audience input changed the base (baseV1 !== baseV2), matching live use. Uses only rows of seasons before `season`; 0 when fewer than MIN_WEIGHT_ROWS. Ties go to the smaller weight.
 */
function chooseWeight(rows, season, baseKind) {
  const key = baseKind === 'v2' ? 'baseV2' : 'baseV1';
  const use = rows.filter((r) => r.season < season && (baseKind !== 'v2' || r.baseV1 !== r.baseV2) && typeof r[key] === 'number' && typeof r.ec === 'number' && typeof r.y === 'number');
  if (use.length < MIN_WEIGHT_ROWS) return { weight: 0, n: use.length };
  let best = null;
  for (const w of GRID) {
    const mae = RF.mean(use.map((r) => Math.abs(r.y - ((1 - w) * r[key] + w * r.ec))));
    if (!best || mae < best.mae - 1e-12) best = { weight: w, mae };
  }
  return { weight: best.weight, n: use.length };
}

/**
 * The v3 object stored on a ledger row. v2 = the row's v2 object (its forecastRaw equals v1 when v2 fell back).
 * earlier = earlierRunScore(...) or null. weightRows = parsed weight-rows file rows.
 */
function buildV3Shadow({ v2, earlier, weightRows, openingDate, recordedAt }) {
  const usedShowScore = !!(v2.inputsPresent && v2.inputsPresent.includes('showScore'));
  const baseKind = usedShowScore ? 'v2' : 'v1';
  const cutoff = toDay(openingDate) - RF.LAG_DAYS; const rec = toDay(recordedAt);
  const passthrough = (reason) => ({
    v3Forecast: v2.forecast, v3ForecastRaw: v2.forecastRaw, v3Lo80: v2.lo80, v3Hi80: v2.hi80, v3Base: baseKind, v3Weight: null,
    v3EarlierScore: null, v3EarlierRaw: null, v3EarlierN: 0, v3EarlierSource: null, v3Origin: null, v3EarlierRef: null,
    v3Applied: false, v3ModelVersion: MODEL_VERSION, v3FallbackReason: reason,
  });
  if (!earlier) return passthrough('no earlier-run score dated by the cutoff');
  if (rec == null || rec > cutoff) return passthrough('recorded after opening minus 3 days');
  if (!weightRows || !weightRows.length) return passthrough('no weight rows available'); // weight 0 from missing data would dilute the graded set
  const { weight } = chooseWeight(weightRows || [], RF.seasonStartYear(openingDate), baseKind);
  const p = clamp((1 - weight) * v2.forecastRaw + weight * earlier.score);
  const delta = p - v2.forecastRaw;
  return {
    v3Forecast: Math.round(p), v3ForecastRaw: r1(p), v3Lo80: Math.round(clamp(v2.lo80 + delta)), v3Hi80: Math.round(clamp(v2.hi80 + delta)),
    v3Base: baseKind, v3Weight: weight, v3EarlierScore: r1(earlier.score), v3EarlierRaw: r1(earlier.raw), v3EarlierN: earlier.n,
    v3EarlierSource: earlier.source, v3Origin: earlier.origin, v3EarlierRef: earlier.ref,
    v3Applied: true, v3ModelVersion: MODEL_VERSION, v3FallbackReason: null,
  };
}

/** Frozen v3 row: the latest row recorded at or before opening minus LAG_DAYS whose v3 was applied; else null. */
function frozenV3Row(rows, showId, openingDate) {
  const cutoff = toDay(openingDate) - RF.LAG_DAYS;
  let best = null;
  for (const r of rows) {
    if (r.showId !== showId || !r.v3 || r.v3.v3Applied !== true || toDay(r.recordedAt) > cutoff) continue;
    if (!best || r.recordedAt > best.recordedAt) best = r;
  }
  return best;
}

module.exports = { MODEL_VERSION, SHRINK_K, MIN_WEIGHT_ROWS, GRID, V3_KEYS, V3_GRADE_KEYS, buildReviewsByShow, originLabel, earlierRunScore, assertNoLeakageV3, chooseWeight, buildV3Shadow, frozenV3Row };
