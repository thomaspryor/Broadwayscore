/**
 * js-outlet-giveup — per-show, per-outlet suppression for the poller's
 * JS-rendered (ScrapingBee render_js, 5 credits/attempt) site-search tier.
 *
 * BRO-2941: missingJsIds (opening-night-poller.js) re-renders EVERY still-missing
 * requiresJs outlet on EVERY poll tick, forever — an outlet with no market/applies
 * restriction (vulture, hollywood-reporter, deadline, timeout, ew, telegraph-search)
 * fires for shows it will never cover (e.g. THR on an Off-Broadway transfer), and
 * data/audit/poller-backoff shows shows sitting at consecutiveNoOp 50-85 with no
 * per-outlet cap — each tick still pays the full JS-render outlet set.
 *
 * Pure per-outlet counter: DEFAULT_GIVEUP_THRESHOLD consecutive "attempted, still
 * not found" ticks suppresses that (show, effectiveOutletId) pair from future JS
 * render attempts. Any tick where the outlet IS found resets its counter (it won't
 * be attempted again anyway, since found outlets are already excluded upstream).
 * Deliberately NOT tied to the show-level consecutiveNoOp backoff — a late find on
 * one outlet (e.g. a T1 review 2 days out) says nothing about whether Telegraph is
 * ever going to cover an Off-Broadway show, so give-up state persists independently
 * until the outlet is found or --force-serp bypasses it.
 */
'use strict';

const DEFAULT_GIVEUP_THRESHOLD = 10;

/** Whether (show, effectiveOutletId) has hit the give-up threshold and should be skipped. */
function isOutletGivenUp(misses, effectiveId, threshold = DEFAULT_GIVEUP_THRESHOLD) {
  return ((misses && misses[effectiveId]) || 0) >= threshold;
}

/**
 * Recompute the per-outlet miss map after one poll tick.
 * @param {Object<string, number>} misses - previous tick's miss counts, keyed by effective outlet id
 * @param {string[]} attemptedEffectiveIds - effective ids of outlets rendered this tick
 * @param {Set<string>} foundEffectiveIds - effective ids of outlets found this tick (lowercased)
 * @returns {Object<string, number>} next miss map — found outlets reset (deleted), others increment
 */
function updateOutletMisses(misses, attemptedEffectiveIds, foundEffectiveIds) {
  const next = { ...(misses || {}) };
  for (const id of attemptedEffectiveIds) {
    if (foundEffectiveIds.has(id)) {
      delete next[id];
    } else {
      next[id] = (next[id] || 0) + 1;
    }
  }
  return next;
}

module.exports = { DEFAULT_GIVEUP_THRESHOLD, isOutletGivenUp, updateOutletMisses };
