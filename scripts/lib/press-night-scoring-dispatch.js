'use strict';
/**
 * press-night-scoring-dispatch.js — which shows need a scoring run the moment
 * a review-texts push lands (BRO-6886).
 *
 * Clifford Odets' Waiting for Lefty, 2026-11-02: gather-reviews.yml's
 * outlet-serp job found the New York Theatre Guide review at 04:07Z and pushed
 * it at 04:12Z. NYTG prints no stars, so the review needs an LLM score before
 * the rebuild will publish it. gather-reviews only dispatches scoring from its
 * follow-up job, which waits for the whole gather matrix (that run ended
 * 06:07Z). Scoring started at 04:26Z only because the verify-all-scored.js
 * safety net happened to run in an unrelated rebuild; the review went live at
 * 05:02Z, after the midnight deadline.
 *
 * Fix: push-review-texts (every producer of review texts) hands the files it
 * just pushed to scripts/score-new-press-night-reviews.js, which dispatches a
 * show-scoped scoring run for urgent shows with a new unscored review.
 *
 * Rules, in order:
 *   - only files this push changed (no time heuristics; a file the scorer
 *     failed on re-triggers only when something changes it again)
 *   - only urgent shows: scoring-lane.js urgentScoringShowIds, the scorer's
 *     own "never batch this" predicate, so the two cannot drift
 *   - only files rebuild would include, that have no score rebuild would use,
 *     and that the scorer would actually pick up (verify-all-scored.js's three
 *     predicates, reused as-is)
 *   - at most MAX_RUNS_PER_HOUR scoring runs per show in the last hour (a
 *     file the scorer keeps failing on, re-pushed by rebuilds, must not loop).
 *     Duplicate dispatches below the cap are absorbed by the per-show lane
 *     (one running, one pending), so no "already waiting" check: a waiting
 *     run can be a dry run or another lane, and skipping on it would be silent.
 */

const path = require('path');
const { urgentScoringShowIds } = require('./scoring-lane');

/**
 * Show ids named by an llm-ensemble-score.yml run title
 * ("LLM Ensemble Score Reviews — a,b"). Exact ids, never substrings.
 */
function showIdsFromRunTitle(title) {
  if (typeof title !== 'string') return [];
  const i = title.indexOf(' — ');
  if (i < 0) return [];
  return title.slice(i + 3).split(',').map((s) => s.trim()).filter(Boolean);
}

const MAX_RUNS_PER_HOUR = 4;

/**
 * Parse a changed-path list into { showId, file } pairs. Paths are relative to
 * the review-texts repo root ("show-id/outlet--critic.json"); anything else
 * (failed-fetches.json, nested or top-level files) is ignored.
 */
function parseChangedFiles(lines) {
  const out = [];
  const seen = new Set();
  for (const raw of lines || []) {
    const p = String(raw || '').trim();
    if (!p.endsWith('.json')) continue;
    const parts = p.split('/');
    if (parts.length !== 2) continue;
    const [showId, file] = parts;
    if (!showId || !file || file === 'failed-fetches.json') continue;
    const key = `${showId}/${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ showId, file });
  }
  return out;
}

/**
 * @param {object} p
 * @param {Array<{showId:string,file:string}>} p.changed  parseChangedFiles output
 * @param {Array} p.shows             shows.json `.shows`
 * @param {Date}  [p.now]
 * @param {object} [p.evidence]       review-evidence map (scoring-lane input)
 * @param {(showId:string, file:string) => object|null} p.readReview
 * @param {string} p.reviewTextsDir   absolute dir, for sibling-aware predicates
 * @param {object} p.predicates       { isScoreableSurvivor, hasValidScore, isDispatchActionable }
 * @returns {Array<{showId:string, files:string[]}>} shows needing a scoring run
 */
function selectShowsNeedingScoring({ changed, shows, now = new Date(), evidence = null, readReview, reviewTextsDir, predicates }) {
  const { isScoreableSurvivor, hasValidScore, isDispatchActionable } = predicates;
  const urgent = urgentScoringShowIds(shows, { now, evidence });
  const byId = new Map((shows || []).map((s) => [s.id, s]));
  const result = new Map();
  for (const { showId, file } of changed) {
    if (!urgent.has(showId)) continue;
    const show = byId.get(showId);
    if (!show) continue;
    const data = readReview(showId, file);
    if (!data || typeof data !== 'object') continue; // deleted or unreadable
    const filePath = path.join(reviewTextsDir, showId, file);
    if (!isScoreableSurvivor(data, show, filePath).eligible) continue;
    if (hasValidScore(data, show)) continue;
    if (!isDispatchActionable(data, show, filePath).actionable) continue;
    if (!result.has(showId)) result.set(showId, []);
    result.get(showId).push(file);
  }
  return [...result.entries()].map(([showId, files]) => ({ showId, files }));
}

/**
 * Split selected shows into those to dispatch and those over the hourly cap.
 * `runs` are llm-ensemble-score.yml runs (GitHub API shape: display_title,
 * created_at); only runs naming the show count.
 */
function capRecentDispatches(selected, runs, { now = new Date(), windowMs = 60 * 60 * 1000, max = MAX_RUNS_PER_HOUR } = {}) {
  const since = now.getTime() - windowMs;
  const recent = new Map();
  for (const r of runs || []) {
    const t = Date.parse(r && r.created_at);
    if (!Number.isFinite(t) || t < since) continue;
    for (const id of showIdsFromRunTitle(r.display_title || r.name)) recent.set(id, (recent.get(id) || 0) + 1);
  }
  return {
    dispatch: selected.filter((s) => (recent.get(s.showId) || 0) < max),
    capped: selected.filter((s) => (recent.get(s.showId) || 0) >= max),
  };
}

module.exports = {
  showIdsFromRunTitle,
  parseChangedFiles,
  selectShowsNeedingScoring,
  capRecentDispatches,
  MAX_RUNS_PER_HOUR,
};
