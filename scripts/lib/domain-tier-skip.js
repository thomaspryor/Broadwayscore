/**
 * Shared read/write helpers for scripts/config/domain-tier-skip.json
 * (Scraping v2 Sprint 1 T10).
 *
 * Schema (current): { [domain]: { [tierId]: { skip: true, reason: string, addedAt: string } } }
 * Schema (legacy, pre-T10): { [domain]: string[] } — a bare array of skipped tier IDs.
 * getSkippedTiers() reads both so a not-yet-regenerated file (or a domain
 * entry regenerate-tier-configs.js hasn't touched since the migration) still
 * works — it's the read path every fetchPage() call goes through.
 *
 * Why the provenance fields: the plain array shape had no way to tell "this
 * skip was added yesterday from a real failure streak" from "this skip has
 * sat unreviewed for 8 months" — the missing provenance is why the didthey-
 * likeit.com / theatre.reviews ScrapingDog skips went stale (added before SD
 * was even a supported tier, never revisited once it launched).
 */

/**
 * Pure: skipped tier IDs for a domain, from either schema shape.
 * @param {object} config - parsed domain-tier-skip.json
 * @param {string} hostname - already-normalized (no www.) domain
 * @returns {Set<string>}
 */
function getSkippedTiers(config, hostname) {
  const entry = config && config[hostname];
  if (!entry) return new Set();
  if (Array.isArray(entry)) return new Set(entry); // legacy shape
  return new Set(Object.keys(entry).filter(tierId => entry[tierId] && entry[tierId].skip === true));
}

/**
 * Pure: build the new-shape skip config from raw failure stats, preserving
 * each entry's original addedAt across regenerations (only a first-seen
 * domain+tier skip gets stamped with `now`).
 * @param {object} stats - { [domain]: { [tierId]: { successes, failures } } }
 * @param {object} existingConfig - previous domain-tier-skip.json content (either shape)
 * @param {object} opts
 * @param {number} opts.skipThreshold - min failures (with 0 successes) to skip
 * @param {string} opts.now - ISO date string for newly-added entries
 * @returns {object} new-shape config, keys sorted for stable diffs
 */
function buildSkipConfig(stats, existingConfig, { skipThreshold, now }) {
  const out = {};
  for (const domain of Object.keys(stats).sort()) {
    const tiers = stats[domain];
    const existingEntry = existingConfig && existingConfig[domain];
    for (const tierId of Object.keys(tiers).sort()) {
      const s = tiers[tierId];
      if (s.failures >= skipThreshold && s.successes === 0) {
        if (!out[domain]) out[domain] = {};
        const priorAddedAt = existingEntry && !Array.isArray(existingEntry) && existingEntry[tierId]
          ? existingEntry[tierId].addedAt
          : null;
        out[domain][tierId] = {
          skip: true,
          reason: `${s.failures} failures, 0 successes`,
          addedAt: priorAddedAt || now,
        };
      }
    }
  }
  return out;
}

module.exports = { getSkippedTiers, buildSkipConfig };
