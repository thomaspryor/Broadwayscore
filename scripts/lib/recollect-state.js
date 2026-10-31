'use strict';
/**
 * Attempt ledger for recollect-for-scores.js (BRO-5675).
 *
 * The weekly cron walked each outlet's backlog in fixed directory order and
 * never recorded fetch errors, so the same dead URLs ran first every week
 * (culturesauce: 70 of 70 errors, ~16 min/week) and the tail behind them, and
 * every outlet after the 120-min timeout, never ran. Same shape as
 * recover-explicit-ratings.js's recover-ratings-state.json: one audit file of
 * {key: {lastAttemptAt, lastError}}, least-recently-attempted first, and an
 * errored URL backs off for ERROR_BACKOFF_DAYS instead of retrying weekly.
 * Bookkeeping lives here, not in the private review files.
 */

const fs = require('fs');

const ERROR_BACKOFF_DAYS = 28;
const DAY_MS = 86_400_000;

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** True while an errored target is inside its backoff window. */
function inErrorBackoff(entry, now = Date.now()) {
  if (!entry || !entry.lastError) return false;
  const at = Date.parse(entry.lastAttemptAt);
  return Number.isFinite(at) && now - at < ERROR_BACKOFF_DAYS * DAY_MS;
}

/**
 * Drop targets in error backoff, then order never-attempted first and the
 * rest oldest attempt first. Stable within ties, so directory order breaks them.
 * @param {{key:string}[]} targets
 */
function orderTargets(targets, state, now = Date.now()) {
  const lastAt = t => {
    const ms = Date.parse(state[t.key] && state[t.key].lastAttemptAt);
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  return targets
    .filter(t => !inErrorBackoff(state[t.key], now))
    .map((t, i) => ({ t, i, at: lastAt(t) }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map(x => x.t);
}

function recordAttempt(state, key, error, now = Date.now()) {
  state[key] = { lastAttemptAt: new Date(now).toISOString() };
  if (error) state[key].lastError = String(error).slice(0, 200);
}

/**
 * Drop this outlet's entries that are no longer targets (scored, marked
 * no-score, renamed), so the ledger tracks the backlog, not history.
 * `marker` is the "/<outlet>--" part of a "<dir>/<outlet>--<critic>.json" key.
 */
function pruneState(state, marker, liveKeys) {
  const live = new Set(liveKeys);
  for (const key of Object.keys(state)) {
    if (key.includes(marker) && !live.has(key)) delete state[key];
  }
}

module.exports = { ERROR_BACKOFF_DAYS, loadState, saveState, inErrorBackoff, orderTargets, recordAttempt, pruneState };
