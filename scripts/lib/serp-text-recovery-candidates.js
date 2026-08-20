'use strict';

const THIN_TIERS = new Set(['truncated', 'excerpt', 'stub']);

/**
 * outletIds (lowercased) whose OUTLET_DOMAINS entry is `domain` OR one of
 * `domain`'s registered aliases (data/outlet-registry.json's domainAliases
 * field, e.g. AP's apnews.com/abcnews.go.com pair) — the same alias group
 * buildSiteClause() searches. Without this, an urlless candidate for an
 * outlet published on the alias TLD is invisible to a --domain run
 * targeting the primary domain (or vice versa), even though a URL-bearing
 * file for that same outlet on that domain would be recoverable via the
 * existing-url path. Pure + exported for unit testing (ship-check finding,
 * BRO-141).
 *
 * @param {string|null} domain
 * @param {object} outletDomains - OUTLET_DOMAINS (outletId -> primary domain)
 * @param {object} domainAliases - REGISTRY_DOMAIN_ALIASES (domain -> Set<domain>)
 * @returns {Set<string>}
 */
function buildDomainOutletIds(domain, outletDomains, domainAliases) {
  if (!domain) return new Set();
  const aliasSet = (domainAliases && domainAliases[domain]) || new Set();
  const targetDomains = new Set([domain, ...aliasSet]);
  return new Set(
    Object.keys(outletDomains).filter(id => targetDomains.has(outletDomains[id]))
  );
}

/**
 * Pure per-file gate for scripts/recover-serp-text.js's loadCandidates() loop:
 * does this review-text file qualify as a SERP-recovery candidate for the
 * given --domain/--outlet target?
 *
 * Extracted (BRO-141) so the urlless-file domain reverse-lookup — generalized
 * beyond Telegraph (task #894) to every outlet resolvable via OUTLET_DOMAINS —
 * is unit-testable without touching the real review-texts tree (CLAUDE.md
 * rule 15: extract to scripts/lib/, require() in both the script and the test).
 *
 * @param {object} data - parsed review-text file JSON
 * @param {object} target
 * @param {string|null} target.domain - --domain value (mutually exclusive with outlet)
 * @param {string|null} target.outlet - --outlet value
 * @param {boolean} target.hasSerpKeys - whether a SERP provider key is configured
 * @param {Set<string>} [target.domainOutletIds] - outletIds (lowercased) whose
 *   OUTLET_DOMAINS entry equals target.domain; required when target.domain is
 *   set and target.outlet is not (used to vet urlless candidates).
 * @param {object} [exhausted] - map of url -> exhausted entry
 * @returns {{ qualifies: boolean, skipReason: string|null }} skipReason is one of
 *   'no_url' | 'bad_url' | 'wrong_domain' | 'complete' | 'not_thin' | 'flagged' | 'exhausted' | null
 */
function evaluateCandidate(data, target, exhausted) {
  if (!data.url && (target.outlet || !target.hasSerpKeys)) {
    return { qualifies: false, skipReason: 'no_url' };
  }

  if (target.outlet) {
    if ((data.outletId || '') !== target.outlet) {
      return { qualifies: false, skipReason: 'wrong_domain' };
    }
  } else if (data.url) {
    let domain;
    try { domain = new URL(data.url).hostname.replace(/^www\./, ''); }
    catch { return { qualifies: false, skipReason: 'bad_url' }; }
    if (domain !== target.domain) return { qualifies: false, skipReason: 'wrong_domain' };
  } else {
    // No url to check a domain against — fall back to the outletId ->
    // domain reverse lookup (OUTLET_DOMAINS), the same signal
    // discoverCorrectUrl() will use to resolve a search domain from scratch.
    if (!(target.domainOutletIds || new Set()).has((data.outletId || '').toLowerCase())) {
      return { qualifies: false, skipReason: 'wrong_domain' };
    }
  }

  if (data.contentTier === 'complete') return { qualifies: false, skipReason: 'complete' };
  if (!THIN_TIERS.has(data.contentTier)) return { qualifies: false, skipReason: 'not_thin' };
  if (data.wrongShow || data.wrongProduction || data.wrongAttribution || data.isRoundupArticle) {
    return { qualifies: false, skipReason: 'flagged' };
  }
  if (exhausted && data.url && exhausted[data.url]) return { qualifies: false, skipReason: 'exhausted' };

  return { qualifies: true, skipReason: null };
}

// Domains/outlets already swept to a measured, reproducible zero-recovery
// rate (Notion card 3b1637c5-416f-8163-a707-e156f5e1efc3, measured
// 2026-08-16: 192 combined candidates across these 5 pools, 0 recovered —
// old/niche sites with near-zero Google indexing, or paywalled). Re-running
// them burns real SERP provider spend for no yield; this is a DATA finding,
// not a code bug, so it belongs in a checked-in guard rather than operator
// memory. Keyed on the exact --domain/--outlet CLI value (ap was swept via
// --outlet mode, the rest via --domain).
const PROVEN_ZERO_SWEEP_DOMAINS = new Set([
  'lightingandsoundamerica.com', // 0/108
  'wolfentertainmentguide.com',  // 0/28
  'dailymail.co.uk',             // 0/19
  'thetimes.co.uk',              // 0/12 (also paywalled — see OTP tasks #919/#924)
]);
const PROVEN_ZERO_SWEEP_OUTLETS = new Set([
  'ap', // 0/18 via --outlet mode
]);

/**
 * Is this --domain/--outlet target a pool already measured to a
 * reproducible zero-recovery rate? Callers should refuse to run (or require
 * an explicit override) rather than silently re-burning SERP spend on a
 * pool with no measured yield. Pure + exported for unit testing.
 *
 * A --domain target is ALSO guarded when it resolves — directly or through
 * a registered domain alias — to a proven-zero domain OR outlet. Two alias
 * paths, both closed here (what-else pass, BRO-141, found the second one
 * live in this same file/session — 55 registry outlets carry domainAliases,
 * including two of PROVEN_ZERO_SWEEP_DOMAINS' own entries: daily-mail's
 * dailymail.co.uk/dailymail.com and times-uk's thetimes.co.uk/thetimes.com):
 *   1. `ap` was measured via --outlet=ap, but buildDomainOutletIds()'s alias
 *      expansion means --domain=apnews.com or --domain=abcnews.go.com now
 *      reach the exact same AP-attributed pool (ship-check finding).
 *   2. --domain=dailymail.co.uk is guarded directly, but its own alias
 *      --domain=dailymail.com was NOT, before this fix.
 * outletDomains/domainAliases are optional so existing callers that only
 * care about the static lists still work; pass
 * OUTLET_DOMAINS/REGISTRY_DOMAIN_ALIASES to get the full check.
 *
 * @param {object} target
 * @param {string|null} target.domain
 * @param {string|null} target.outlet
 * @param {object} [outletDomains] - OUTLET_DOMAINS (outletId -> primary domain)
 * @param {object} [domainAliases] - REGISTRY_DOMAIN_ALIASES (domain -> Set<domain>)
 * @returns {boolean}
 */
function isProvenZeroSweep(target, outletDomains, domainAliases) {
  if (target.outlet) return PROVEN_ZERO_SWEEP_OUTLETS.has(target.outlet);
  if (!target.domain) return false;
  if (PROVEN_ZERO_SWEEP_DOMAINS.has(target.domain)) return true;
  if (!domainAliases) return false;
  // Path 2: does target.domain alias a domain that's directly in the list?
  for (const provenDomain of PROVEN_ZERO_SWEEP_DOMAINS) {
    const aliasSet = domainAliases[provenDomain] || new Set();
    if (aliasSet.has(target.domain)) return true;
  }
  if (!outletDomains) return false;
  // Path 1: does target.domain (or its alias) resolve to a proven-zero outlet?
  for (const outletId of PROVEN_ZERO_SWEEP_OUTLETS) {
    const primary = outletDomains[outletId];
    if (!primary) continue;
    if (target.domain === primary) return true;
    const aliasSet = domainAliases[primary] || new Set();
    if (aliasSet.has(target.domain)) return true;
  }
  return false;
}

module.exports = {
  evaluateCandidate,
  buildDomainOutletIds,
  isProvenZeroSweep,
  PROVEN_ZERO_SWEEP_DOMAINS,
  PROVEN_ZERO_SWEEP_OUTLETS,
  THIN_TIERS,
};
