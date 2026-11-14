'use strict';

// Stored vs fresh recoupment model values (BRO-5004, BRO-4989).
//
// commercial.json keeps the model output from its last run
// (merge-model-recoupment.js: daily in commercial-stale-closures.yml at 08:00
// UTC, plus Friday, Saturday, and after an approved fix or a Waltz cost scrape). Any other writer that changes a model input in between
// leaves the stored values on the old input until the next run. That is how
// the-great-gatsby showed 83.1% while a fresh run gave 64.4%: its stored
// break-even (912,195) is exactly what the model gives at the old $850k weekly
// cost, and a same-day fix raised the cost to $900k after that run.
// commercial-write-guard rescales the break-even on a cost change (BRO-4985)
// but not the recoupment range, so only a re-run shows the drift.
//
// liveModelRun mirrors merge-model-recoupment.js's tier choice and calls;
// modelDrift compares one record's stored values with a fresh run.

const { calculateRecoupment, calculateLifetimeRecoupment } = require('./recoupment-model');
const { classifyTier } = require('./model-return-v2');
const { optsWithCapEstimate, makeCapEstimator } = require('./cap-comparables');

/**
 * The live model for one record, exactly as merge-model-recoupment.js runs it.
 * @returns {{ tier: string, result: object|null }} tier is the modelMethod a
 *   run would store: a model error falls back to 'ai-estimated' (result null),
 *   as it does there.
 */
function liveModelRun(show, comm, lookup, opts = {}) {
  const slug = show.slug || show.id;
  const allTime = lookup.getGrossesAllTime(slug, show.id);
  opts = optsWithCapEstimate(opts, show, comm); // shadow, BRO-5849
  const tier = classifyTier(show, comm, allTime, opts);
  let result = null;
  // opts carries the shadow flags and the live comparables estimator (BRO-5849).
  if (tier === 'weekly-model') result = calculateRecoupment(show, comm, allTime, lookup.getWeeklyData(slug, show.id), opts);
  else if (tier === 'simplified-lifetime') result = calculateLifetimeRecoupment(show, comm, allTime, opts);
  if (result && result.error) return { tier: 'ai-estimated', result: null };
  return { tier, result };
}

// A run on the same inputs reproduces the stored central to the decimal
// stored; 0.5 points allows for the clock (a running show gains a week).
const SAME_DAY_TOLERANCE = 0.5;
// Between runs a new week of grosses moves a running show a little. Flag a
// move a reader would notice: 5 points and 10% of the stored value.
const DRIFT_POINTS = 5;
const DRIFT_RELATIVE = 0.10;

/**
 * @param {object} comm - commercial.json record (stored model fields)
 * @param {{ tier: string, result: object|null }} fresh - liveModelRun output
 * @param {string} today - YYYY-MM-DD
 * @returns {null | { kind: 'same-day'|'drift'|'method', stored: number|null, fresh: number|null, detail: string }}
 *   same-day: run today on these inputs and still differs (the run did not stick);
 *   drift: inputs moved since the last run by more than a reader would ignore;
 *   method: the stored tier differs from the one a run would use now.
 */
function modelDrift(comm, fresh, today) {
  if (!comm || !comm.modelLastRun || !fresh) return null;
  if (comm.modelMethod && comm.modelMethod !== fresh.tier) {
    return { kind: 'method', stored: null, fresh: null, detail: `stored ${comm.modelMethod}, a run now uses ${fresh.tier}` };
  }
  if (!fresh.result) return null;
  const stored = Array.isArray(comm.modelRecoupmentPct) ? comm.modelRecoupmentPct[1] : null;
  const now = fresh.result.recoupmentPctCentral;
  if (typeof stored !== 'number' || typeof now !== 'number') return null;
  const diff = Math.abs(now - stored);
  if (comm.modelLastRun === today) {
    return diff > SAME_DAY_TOLERANCE
      ? { kind: 'same-day', stored, fresh: now, detail: `run ${today} stored ${stored}%, same inputs give ${now}%` }
      : null;
  }
  if (diff >= DRIFT_POINTS && diff >= DRIFT_RELATIVE * Math.max(Math.abs(stored), 1)) {
    const cost = comm.modelCostBasis != null && comm.weeklyRunningCost !== comm.modelCostBasis
      ? `; weekly cost ${comm.modelCostBasis} -> ${comm.weeklyRunningCost}` : '';
    return { kind: 'drift', stored, fresh: now, detail: `last run ${comm.modelLastRun} stored ${stored}%, now ${now}%${cost}` };
  }
  return null;
}

/**
 * Every commercial.json record against a fresh run, matched to shows.json the
 * way merge-model-recoupment.js matches them (unmatched records are skipped).
 * Shared by scripts/check-model-drift.js and health-check.js.
 * @returns {{ checked: number, flagged: object[], summary: { checked, sameDay, drift, method } }}
 */
function scanModelDrift(shows, commercialShows, lookup, today) {
  const by = {};
  for (const s of shows) { if (s.slug) by[s.slug] = s; if (s.id) by[s.id] = s; }
  // Same inputs as merge-model-recoupment.js, which runs the comparables fallback live (BRO-5849).
  const runOpts = { capComparables: true, capEstimator: makeCapEstimator(shows, commercialShows) };
  let checked = 0;
  const flagged = [];
  for (const [key, comm] of Object.entries(commercialShows)) {
    const show = by[key] || by[comm.slug] || by[key.replace(/-\d{4}$/, '')];
    if (!show || !comm.modelLastRun) continue;
    checked++;
    const d = modelDrift(comm, liveModelRun(show, comm, lookup, runOpts), today);
    if (d) flagged.push({ slug: key, ...d });
  }
  const count = (k) => flagged.filter((f) => f.kind === k).length;
  return { checked, flagged, summary: { checked, sameDay: count('same-day'), drift: count('drift'), method: count('method') } };
}

module.exports = { liveModelRun, modelDrift, scanModelDrift, SAME_DAY_TOLERANCE, DRIFT_POINTS, DRIFT_RELATIVE };
