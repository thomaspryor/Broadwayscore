'use strict';

/**
 * Per-run host+tier failure memo for fetchPage() (BRO-4296).
 *
 * domain-tier-skip.json is regenerated weekly, so a paid tier that dies on a
 * host mid-week keeps being tried on every URL. On the 2026-09-28 School Girls
 * opening each talkinbroadway.com fetch spent ~45s on Scrapingdog 400/stealth
 * 500 before Bright Data answered, and 8 URLs ate 9 of the poller's 10
 * per-show minutes.
 *
 * A tier failure counts only when the tier actually made a call, came back
 * with nothing usable, AND a later tier in the same fetchPage call got the
 * page. A URL that fails on every tier is a bad URL (a guessed TB link that
 * 404s), not a dead tier; counting those would latch every tier off the host
 * and strand its real URLs. The tier that succeeded resets, so a host always
 * keeps a working tier.
 *
 * Only paid tiers latch. Skipping Playwright or cookie fetches would move
 * volume onto paid tiers. Scrapingdog misses are not billed and it is ~17x
 * cheaper than Bright Data, so latching it on a host where it works half the
 * time would raise cost: it needs more misses, and never latches on a host
 * where it already succeeded this run.
 */

const DEFAULT_RULES = {
  scrapingdog: { threshold: 3, requireNoSuccess: true },
  brightdata: { threshold: 2, requireNoSuccess: false },
  scrapingbee: { threshold: 2, requireNoSuccess: false },
};

/**
 * @param {{rules?: Record<string, {threshold: number, requireNoSuccess: boolean}>}} [opts]
 */
function createRunMemo(opts = {}) {
  const rules = opts.rules || DEFAULT_RULES;
  // host -> tier -> { consecutive, successes, latched }
  const state = new Map();

  function entry(host, tier) {
    let byTier = state.get(host);
    if (!byTier) { byTier = new Map(); state.set(host, byTier); }
    let e = byTier.get(tier);
    if (!e) { e = { consecutive: 0, successes: 0, latched: false }; byTier.set(tier, e); }
    return e;
  }

  /** Tiers latched off for this host for the rest of the process. */
  function skippedTiers(host) {
    const out = new Set();
    const byTier = host && state.get(host);
    if (!byTier) return out;
    for (const [tier, e] of byTier) if (e.latched) out.add(tier);
    return out;
  }

  /**
   * Record one fetchPage call's chain.
   * @param {string} host - normalized hostname (no www.)
   * @param {Array<{tier: string, attempted: boolean, ok: boolean}>} outcomes in chain order
   * @returns {Array<{tier: string, failures: number}>} tiers that latched on this call
   */
  function recordOutcome(host, outcomes) {
    if (!host || !Array.isArray(outcomes)) return [];
    const winner = outcomes.findIndex(o => o.ok);
    const latchedNow = [];
    outcomes.forEach((o, i) => {
      const rule = rules[o.tier];
      if (!rule) return;
      const e = entry(host, o.tier);
      if (o.ok) {
        e.consecutive = 0;
        e.successes++;
        return;
      }
      // Skipped (budget/quota/latch) or no later tier won: no evidence about this tier.
      if (!o.attempted || winner === -1 || winner < i) return;
      e.consecutive++;
      if (e.latched) return;
      if (e.consecutive >= rule.threshold && !(rule.requireNoSuccess && e.successes > 0)) {
        e.latched = true;
        latchedNow.push({ tier: o.tier, failures: e.consecutive });
      }
    });
    return latchedNow;
  }

  return { skippedTiers, recordOutcome };
}

module.exports = { createRunMemo, DEFAULT_RULES };
