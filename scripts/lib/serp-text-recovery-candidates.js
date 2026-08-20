'use strict';

const THIN_TIERS = new Set(['truncated', 'excerpt', 'stub']);

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

module.exports = { evaluateCandidate, THIN_TIERS };
