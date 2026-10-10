'use strict';

/**
 * time-to-publish-sla.js — how long does a review take to go from published by
 * the outlet to live on broadwayscorecard.com? (Notion card: Structural #11,
 * task #388.)
 *
 * WHY THIS EXISTS
 * ---------------
 * 2026-04-15 (Fear of 13): BWSC was the LAST of the aggregators to have the
 * reviews up — three hours of manual work. DTLI and BWW Review Roundup publish
 * straight off outlet feeds; we discover, fetch, score, rebuild and deploy. If
 * we are slower than the aggregators the whole value proposition leaks, so
 * time-to-publish needs a number, a target, and something that fails when the
 * number drifts.
 *
 * WHAT WE CAN HONESTLY MEASURE
 * ----------------------------
 * The card's target is "90% of opening-night reviews live within 15 minutes of
 * OUTLET publication". Outlet publication time is the part we mostly do not
 * have: of 42,131 review-text files, only 2,016 (4.8%) carry a publishDate with
 * a time component, and those are small blogs (front-row-center, theater-life,
 * nysr) rather than the T1 outlets we actually race. 32,667 are date-only and
 * 7,448 have none. Measuring a 15-minute SLA against a date-only stamp would be
 * inventing precision we do not have.
 *
 * So each review is classified by BASIS:
 *
 *   basis 'published'      — a precise outlet timestamp exists. publishedToLive
 *                            is a true measurement.
 *   basis 'poller-bounded' — no precise timestamp. publishedToLive is an UPPER
 *                            BOUND: pipeline time (first-seen → live) plus the
 *                            full poller interval, because the worst case is
 *                            that the review published one second after the
 *                            previous poll. Never optimistic; a 'poller-bounded'
 *                            record that passes the 15-minute target really did
 *                            beat 15 minutes.
 *
 * Both bases are evaluated against the SLA. The upper bound is what makes the
 * gate meaningful without a publication clock we do not own.
 *
 * VACUITY
 * -------
 * A validator that passes because it evaluated nothing is the failure class
 * behind cards #1075 / #1094. evaluateTimeToPublishSla() therefore returns
 * verdict 'insufficient-data' (pass:false) below minSample rather than a silent
 * pass, and reports `evaluated` so callers can see the sample it judged.
 *
 * Pure functions only — no fs, no process, no clock except an injected `now`.
 * Tested by tests/unit/time-to-publish-sla.test.mjs (CLAUDE.md rule 15 — the
 * test require()s these functions rather than restating them).
 */

const MS_MIN = 60 * 1000;

/**
 * Worst-case discovery blindness, in minutes: a review published one second
 * after a poll waits a full interval before we can see it.
 *
 * SOURCED, NOT GUESSED: opening-night-poller.yml has no cron at all ("NO CRON —
 * only dispatched by update-show-status.yml when a show transitions to open",
 * line 18). During an opening the re-poll cadence is the orchestrator's loop —
 * `POLL_INTERVAL=${{ inputs.poll_interval_minutes || 10 }}` then
 * `sleep $((POLL_INTERVAL * 60))` (opening-night-orchestrator.yml:459,682). So
 * the default interval is 10 minutes, operator-overridable per dispatch.
 *
 * A run launched with a different poll_interval_minutes should pass
 * discoveryWindowMinutes to match; leaving this at the default would then
 * understate the bound.
 */
const DEFAULT_DISCOVERY_WINDOW_MIN = 10;

/** Card target: 90% of opening-night reviews live within 15 minutes. */
const DEFAULT_TARGET_MINUTES = 15;
const DEFAULT_TARGET_PCT = 90;

/**
 * Below this many evaluated reviews the verdict is 'insufficient-data', never
 * 'pass'. Five is the smallest sample where a 90% target is even expressible
 * (4/5 = 80% fails, 5/5 = 100% passes) — under it the percentage is noise.
 */
const DEFAULT_MIN_SAMPLE = 5;

/** Stage names, in pipeline order. */
const PER_REVIEW_STAGES = ['review-first-seen', 'review-text-collected', 'scored'];

/**
 * Parse an outlet publishDate into a precise ISO instant, or null when the
 * value carries no time-of-day.
 *
 * Date-only values ("2026-04-15", "April 15, 2026") return null on purpose:
 * midnight is not a publication time, and treating it as one would report a
 * review that went live at 09:00 as 9 hours late.
 *
 * A bare "YYYY-MM-DDTHH:MM:SS" with no zone is read as UTC so the result is
 * deterministic wherever this runs — but deterministic is not the same as
 * correct, and most of these come from US blogs whose real offset is 4–8 hours
 * away. `assumedZone` says so, and computeReviewLatencies keeps those records
 * in a separate basis rather than passing them off as measured.
 *
 * @param {string|null|undefined} publishDate
 * @returns {{at: string, assumedZone: boolean}|null} null if not precise
 */
function parsePrecisePublishTime(publishDate) {
  if (!publishDate || typeof publishDate !== 'string') return null;
  const raw = publishDate.trim();
  if (!raw || raw === 'null' || raw === 'undefined') return null;
  // Require an explicit HH:MM somewhere — that is what "precise" means here.
  if (!/\d{1,2}:\d{2}/.test(raw)) return null;
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw);
  const normalized = hasZone ? raw : `${raw.replace(' ', 'T')}Z`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  return { at: d.toISOString(), assumedZone: !hasZone };
}

/**
 * Index stage-latency entries into the shapes the latency math needs.
 *
 * Show-level events (no reviewKey) are the terminals: a `rebuilt` folds a
 * show's reviews into reviews.json, a `deployed-live` puts that build on prod.
 *
 * `globalRebuilds` collects the showId-less run-level `rebuilt` line that
 * rebuild-all-reviews emits once per run, but it is NOT a per-show terminal —
 * see computeReviewLatencies. Same rule as scripts/lib/opening-night-sla.js:
 * per-show lines only ever existed for shows with ≥1 review in reviews.json,
 * so treating the run-level line as coverage would mark a show's stuck first
 * review "live" when nothing of that show was ever rebuilt.
 *
 * @param {object[]} entries parsed stage-latency.jsonl rows
 */
function indexPipelineEvents(entries) {
  const perReview = new Map();
  const showRebuilds = new Map(); // showId -> sorted ISO[]
  const globalRebuilds = [];
  const globalDeploys = [];

  for (const e of entries || []) {
    if (!e || !e.stage || !e.at) continue;

    if (!e.reviewKey) {
      if (e.stage === 'rebuilt') {
        if (e.showId) {
          if (!showRebuilds.has(e.showId)) showRebuilds.set(e.showId, []);
          showRebuilds.get(e.showId).push(e.at);
        } else {
          globalRebuilds.push(e.at);
        }
      } else if (e.stage === 'deployed-live') {
        globalDeploys.push(e.at);
      }
      continue;
    }

    if (!e.showId) continue;
    const k = `${e.showId}||${e.reviewKey}`;
    if (!perReview.has(k)) {
      perReview.set(k, { showId: e.showId, reviewKey: e.reviewKey, stages: {} });
    }
    const rv = perReview.get(k);
    // Earliest wins: a stage can be re-emitted (retries, re-collection) and the
    // first occurrence is when the pipeline actually reached it.
    if (!rv.stages[e.stage] || e.at < rv.stages[e.stage]) rv.stages[e.stage] = e.at;
  }

  const sortAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  for (const list of showRebuilds.values()) list.sort(sortAsc);
  globalRebuilds.sort(sortAsc);
  globalDeploys.sort(sortAsc);

  return { perReview, showRebuilds, globalRebuilds, globalDeploys };
}

/** First element of a sorted ISO list at or after `iso`, else null. */
function firstAtOrAfter(sortedIsoList, iso) {
  if (!sortedIsoList || !sortedIsoList.length || !iso) return null;
  for (const v of sortedIsoList) if (v >= iso) return v;
  return null;
}

/** Earliest of two possibly-null ISO strings. */
function earliest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * Build one latency record per tracked review.
 *
 * Chain: review-first-seen → (collected) → scored → rebuilt → deployed-live.
 * `rebuiltAt` is the first rebuild (show-level or global) at or after the
 * review reached scoring — or after first-seen when scoring never stamped,
 * since scoring instrumentation is incomplete on some paths. `liveAt` is the
 * first deploy at or after that rebuild; a per-key 'deployed-live' wins when
 * one exists.
 *
 * @param {object[]} entries stage-latency rows
 * @param {object}   [opts]
 * @param {Map<string,string>|object} [opts.publishTimes]
 *        reviewKey (or "showId||reviewKey") → precise ISO publication instant.
 *        Only supply entries that really are precise; see parsePrecisePublishTime.
 * @param {number}   [opts.discoveryWindowMinutes=15]
 * @returns {object[]} records
 */
function computeReviewLatencies(entries, { publishTimes = null, discoveryWindowMinutes = DEFAULT_DISCOVERY_WINDOW_MIN } = {}) {
  const { perReview, showRebuilds, globalRebuilds, globalDeploys } = indexPipelineEvents(entries);
  const lookup = publishTimes instanceof Map
    ? publishTimes
    : new Map(Object.entries(publishTimes || {}));
  const discoveryMs = Math.max(0, discoveryWindowMinutes) * MS_MIN;

  const records = [];

  for (const [key, rv] of perReview) {
    const firstSeenAt = rv.stages['review-first-seen'];
    if (!firstSeenAt) continue; // not a tracked review, just a stray stamp

    const scoredAt = rv.stages['scored'] || null;
    const collectedAt = rv.stages['review-text-collected'] || null;

    const readyAt = scoredAt || firstSeenAt;
    // THIS SHOW's rebuilds only. The run-level (showId-less) line says a
    // rebuild happened, not that it covered this show — crediting it here
    // would report a review as live that was never folded in, and would
    // contradict opening-night-sla.js, which still (correctly) pages for it.
    const rebuiltAt = firstAtOrAfter(showRebuilds.get(rv.showId), readyAt);

    const perKeyLive = rv.stages['deployed-live'] || null;
    const liveAt = perKeyLive || (rebuiltAt ? firstAtOrAfter(globalDeploys, rebuiltAt) : null);

    // Clock skew between CI runners can invert a pair; a negative duration is
    // not evidence of speed, so drop it rather than bank an impossible win.
    const span = (from, to) => {
      if (!from || !to) return null;
      const ms = new Date(to) - new Date(from);
      return ms >= 0 ? ms : null;
    };

    const pipelineMs = span(firstSeenAt, liveAt);
    // publishTimes may hold either a bare ISO string or {at, assumedZone}
    // (what parsePrecisePublishTime returns). Accept both.
    const rawPublished = lookup.get(key) || lookup.get(rv.reviewKey) || null;
    const publishedAt = rawPublished && typeof rawPublished === 'object' ? rawPublished.at : rawPublished;
    const assumedZone = !!(rawPublished && typeof rawPublished === 'object' && rawPublished.assumedZone);

    let publishedToLiveMs = null;
    let basis = null;
    if (publishedAt && liveAt) {
      publishedToLiveMs = span(publishedAt, liveAt);
      // A zoneless outlet stamp read as UTC can be hours off. Kept, but in its
      // own basis so a reader never mistakes it for a measured number.
      basis = publishedToLiveMs === null ? null : (assumedZone ? 'published-assumed-tz' : 'published');
    }
    if (publishedToLiveMs === null && pipelineMs !== null) {
      // No usable publication clock: report the worst case rather than nothing.
      publishedToLiveMs = pipelineMs + discoveryMs;
      basis = 'poller-bounded';
    }

    records.push({
      showId: rv.showId,
      reviewKey: rv.reviewKey,
      outletId: String(rv.reviewKey).split(':')[0] || 'unknown',
      publishedAt,
      publishedAtAssumedZone: publishedAt ? assumedZone : false,
      firstSeenAt,
      collectedAt,
      scoredAt,
      rebuiltAt,
      liveAt,
      pipelineMs,
      publishedToLiveMs,
      basis,
      // Where the review sits when it never reached live — the actionable bit
      // for a stuck review, and null once it is live.
      stuckAtStage: liveAt
        ? null
        : (rebuiltAt ? 'rebuilt' : (scoredAt ? 'scored' : (collectedAt ? 'review-text-collected' : 'review-first-seen'))),
    });
  }

  records.sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : 0));
  return records;
}

function percentile(sortedNums, pct) {
  if (!sortedNums.length) return null;
  const idx = Math.ceil((pct / 100) * sortedNums.length) - 1;
  return sortedNums[Math.min(sortedNums.length - 1, Math.max(0, idx))];
}

/**
 * Judge a set of latency records against the SLA.
 *
 * Only records that actually reached live (publishedToLiveMs !== null) are
 * evaluated — a review still in flight is the opening-night SLA's job
 * (scripts/lib/opening-night-sla.js pages at 60 min), not this one's, and
 * counting it as a breach here would double-alert on the same incident. It is
 * still reported as `inFlight` so a caller can see the pipeline is not empty.
 *
 * @returns {{verdict:'pass'|'fail'|'insufficient-data', pass:boolean, evaluated:number,
 *            inFlight:number, compliant:number, compliancePct:number|null,
 *            p50Ms:number|null, p90Ms:number|null, targetMinutes:number,
 *            targetPct:number, breaches:object[], byBasis:object}}
 */
function evaluateTimeToPublishSla(records, {
  targetMinutes = DEFAULT_TARGET_MINUTES,
  targetPct = DEFAULT_TARGET_PCT,
  minSample = DEFAULT_MIN_SAMPLE,
} = {}) {
  const all = records || [];
  const live = all.filter(r => r && r.publishedToLiveMs !== null && r.publishedToLiveMs !== undefined);
  const inFlight = all.length - live.length;
  const thresholdMs = targetMinutes * MS_MIN;

  const compliantRecords = live.filter(r => r.publishedToLiveMs <= thresholdMs);
  const breaches = live
    .filter(r => r.publishedToLiveMs > thresholdMs)
    .sort((a, b) => b.publishedToLiveMs - a.publishedToLiveMs);

  const sorted = live.map(r => r.publishedToLiveMs).sort((a, b) => a - b);
  const compliancePct = live.length ? (compliantRecords.length / live.length) * 100 : null;

  const byBasis = {};
  for (const r of live) {
    const b = r.basis || 'unknown';
    if (!byBasis[b]) byBasis[b] = { evaluated: 0, compliant: 0 };
    byBasis[b].evaluated += 1;
    if (r.publishedToLiveMs <= thresholdMs) byBasis[b].compliant += 1;
  }

  let verdict;
  if (live.length < minSample) verdict = 'insufficient-data';
  else if (compliancePct >= targetPct) verdict = 'pass';
  else verdict = 'fail';

  return {
    verdict,
    pass: verdict === 'pass',
    evaluated: live.length,
    inFlight,
    compliant: compliantRecords.length,
    compliancePct: compliancePct === null ? null : Math.round(compliancePct * 10) / 10,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    targetMinutes,
    targetPct,
    minSample,
    breaches: breaches.slice(0, 20),
    byBasis,
  };
}

/**
 * The date windows of the most recent opening weekends, newest first.
 *
 * "Opening weekend" = the show's openingDate plus the following `daysAfter`
 * days: reviews for a Wednesday opening keep landing through the weekend, and
 * a few arrive the night before (Talkin' Broadway publishes up to 24h early),
 * hence `daysBefore`.
 *
 * @param {object[]} shows shows.json entries ({id, openingDate, ...})
 * @param {object}   opts
 * @param {Date}     opts.now
 * @param {number}   [opts.count=2]      how many recent openings to include
 * @param {number}   [opts.daysBefore=1]
 * @param {number}   [opts.daysAfter=4]
 * @returns {{showId:string, openingDate:string, from:string, to:string}[]}
 */
function selectRecentOpeningWindows(shows, { now, count = 2, daysBefore = 1, daysAfter = 4 } = {}) {
  const nowIso = new Date(now).toISOString();
  const candidates = (shows || [])
    .filter(s => s && s.id && typeof s.openingDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s.openingDate))
    .filter(s => s.openingDate <= nowIso.slice(0, 10))
    .sort((a, b) => (a.openingDate < b.openingDate ? 1 : a.openingDate > b.openingDate ? -1 : 0));

  const windows = [];
  for (const s of candidates) {
    if (windows.length >= count) break;
    const opening = new Date(`${s.openingDate.slice(0, 10)}T00:00:00Z`);
    const from = new Date(opening.getTime() - daysBefore * 24 * 60 * MS_MIN).toISOString();
    // INCLUSIVE of the whole last day. Ending at midnight of openingDate+N cut
    // out nearly all of day N — for a Wednesday opening with daysAfter=4 that
    // silently dropped the entire Sunday, which is exactly when the weekend
    // stragglers land.
    const to = new Date(opening.getTime() + (daysAfter + 1) * 24 * 60 * MS_MIN - 1).toISOString();
    windows.push({ showId: s.id, openingDate: s.openingDate.slice(0, 10), from, to });
  }
  return windows;
}

/**
 * Keep only records belonging to one of `windows` — same show, first seen
 * inside the window. Used to scope the SLA to opening-night traffic instead of
 * judging it on backfills and historical recovery sweeps, which are not racing
 * anybody.
 */
function filterToOpeningWindows(records, windows) {
  const byShow = new Map();
  for (const w of windows || []) {
    if (!byShow.has(w.showId)) byShow.set(w.showId, []);
    byShow.get(w.showId).push(w);
  }
  return (records || []).filter(r => {
    const ws = byShow.get(r.showId);
    if (!ws) return false;
    return ws.some(w => r.firstSeenAt >= w.from && r.firstSeenAt <= w.to);
  });
}

module.exports = {
  parsePrecisePublishTime,
  indexPipelineEvents,
  computeReviewLatencies,
  evaluateTimeToPublishSla,
  selectRecentOpeningWindows,
  filterToOpeningWindows,
  firstAtOrAfter,
  percentile,
  MS_MIN,
  DEFAULT_DISCOVERY_WINDOW_MIN,
  DEFAULT_TARGET_MINUTES,
  DEFAULT_TARGET_PCT,
  DEFAULT_MIN_SAMPLE,
  PER_REVIEW_STAGES,
};
