'use strict';

/**
 * cron-stale-streak.js — consecutive-day staleness tracking for
 * check-cron-health.yml (card #647, root cause (b)).
 *
 * The 2026-07-30 audit's second finding: cron-health DETECTS staleness but its
 * only action is a cooldown-suppressed notification. data/audit/cron-health-
 * state.json listed "Opening Night Orchestrator" as stale with
 * `"redispatched": []` — it knew, and did nothing. The self-heal path fires one
 * redispatch per streak and then pages once; after that the entry falls into
 * the "chronic stale" bucket, which is Discord-only (a warning, and
 * notify-failure is deliberately a no-op for warnings). A cron can therefore
 * sit stale indefinitely with no further action of any kind.
 *
 * What the state file was missing to fix that is a single number: how many
 * consecutive daily checks an entry has been stale. The stale SET was already
 * persisted; the streak was not, so "stale again today" and "stale for eleven
 * days" looked identical. This module adds that count and decides when an entry
 * has been broken long enough to stop being a digest line and become work.
 *
 * Pure — no I/O, no clock — so the escalation boundary is unit-testable.
 */

/** Consecutive daily checks stale before an entry escalates from digest to work. */
const DEFAULT_ESCALATE_AFTER_DAYS = 3;

/**
 * Advance the per-cron stale streaks by one check.
 *
 * A name present in `currentStale` increments; a name absent resets to zero by
 * being dropped entirely (a recovered cron must not carry its old streak into
 * a future, unrelated outage — that would escalate the next one instantly).
 *
 * `escalate` uses >= rather than ==, so an entry that stays broken keeps being
 * eligible. Repeat suppression is the alert router's job (conditionKey +
 * cooldown), not this function's: making it fire exactly once on day 3 would
 * mean a cron that breaks, gets a card, and is still broken a month later has
 * nothing tracking it — the same silence in a different place.
 *
 * @param {object|null} prevState prior cron-health-state.json contents
 * @param {string[]} currentStale friendly names stale at THIS check
 * @param {{escalateAfterDays?: number}} [opts]
 * @returns {{staleStreak: Object<string, number>, escalate: string[], recovered: string[]}}
 */
function updateStaleStreaks(prevState, currentStale, opts = {}) {
  const escalateAfterDays = opts.escalateAfterDays || DEFAULT_ESCALATE_AFTER_DAYS;
  const prevStreak = (prevState && prevState.staleStreak) || {};
  const stale = [...new Set((currentStale || []).map((n) => String(n).trim()).filter(Boolean))].sort();

  const staleStreak = {};
  const escalate = [];
  for (const name of stale) {
    // A prior state file written before this field existed has no streak for
    // anything. Seeding from the old `stale` array would be a guess about how
    // long it had been stale; starting at 1 costs at most escalateAfterDays
    // of delay once, on the first run after deploy, and never over-escalates.
    const streak = (Number(prevStreak[name]) || 0) + 1;
    staleStreak[name] = streak;
    if (streak >= escalateAfterDays) escalate.push(name);
  }

  const recovered = Object.keys(prevStreak).filter((name) => !staleStreak[name]).sort();
  return { staleStreak, escalate, recovered };
}

module.exports = { DEFAULT_ESCALATE_AFTER_DAYS, updateStaleStreaks };
