/**
 * outlet-domain-validation.js — does a review's URL host actually belong to
 * its recorded outletId?
 *
 * Task #1926 (paranormal-activity-2026 incident, 2026-08-26): submit-review-
 * form / audit-aggregator-gap ingest can end up writing a review-texts file
 * whose outletId is a registered T1/T2 outlet but whose url is on a totally
 * different host (a critic's personal Substack, in the real incident). The
 * write path stamps `domainUnvalidated`/`domainUnvalidatedReason` at write
 * time, but that stamp goes STALE the moment a later merge changes outletId
 * without re-running domain validation — the real specimen file's
 * domainUnvalidatedReason still names the ORIGINAL host-derived outletId
 * ("newyorknotebook"), not the "vulture" it was later merged onto. Gating on
 * the stored flag would miss exactly that case.
 *
 * So explainOutletDomainMismatch() below recomputes the match FRESH from
 * data.url + data.outletId + the registry every time, rather than trusting
 * any stored flag. That's strictly safer and closes the staleness gap
 * architecturally instead of only for this one incident.
 *
 * SCOPE — deliberately narrow (adversarial review, 2026-08-26): a naive
 * "URL host must match the outlet's registered domain" rule is unsafe for
 * this corpus. A full-corpus scan (36,806 outletId+url review-texts files)
 * found 722 currently-includable files across 78 outlets that would be
 * WRONGLY excluded by a blanket check — wire services (AP/Reuters/Bloomberg/
 * UPI legitimately syndicate on arbitrary partner domains — see
 * WIRE_SERVICE_OUTLETS in review-normalization.js), aggregator-sourced score
 * stubs (bww-roundup/dtli/show-score/westendtheatre/playbill-verdict/
 * theatre-record/stagedoor/serp-discovery — review-file-writer.js's own
 * aggregatorScoreStub/aggregatorSourceExempt carve-outs), and historical
 * archival provenance (newspapers-com-ocr scans, web.archive.org mirrors).
 * None of those are the bug this card is about.
 *
 * The exact same scan, scoped to `data.source === 'submit-review-form'` (the
 * literal stamp BOTH the /submit-review form AND audit-aggregator-gap's
 * auto-ingest write — see scripts/ingest-review-from-url.js line ~336 —
 * regardless of which one drove the write), found ZERO false positives and
 * caught not just the known specimen but a second, previously-undetected
 * live instance of the same critic/outlet-borrowing pattern (punch-2025/
 * vulture--sandy-macdonald.json). That's the deliberate scope below: this
 * only ever fires on the single-URL ingest path the card is about, not a
 * retroactive re-audit of decades of archival/aggregator sourcing.
 *
 * Pure — no fs/network. Callers pass in the loaded outlet-registry.json
 * object (see scripts/lib/review-normalization.js loadOutletRegistry()).
 */

'use strict';

const { WIRE_SERVICE_OUTLETS, normalizeOutlet } = require('./review-normalization');

// The only source this check applies to — see the SCOPE note above. Widen
// this set only after running the same corpus-wide false-positive scan this
// card ran (scripts/lib/outlet-domain-validation.js git history / task #1926
// notes) against the new source — do not assume a new single-URL-ingest path
// is automatically safe to add.
const VALIDATED_INGEST_SOURCES = new Set(['submit-review-form']);

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

function normalizeDomain(domain) {
  return String(domain || '').toLowerCase().replace(/^www\./, '');
}

/**
 * All domains registered for an outlet (domain + domainAliases), lowercased
 * and deduped. Empty array means the outlet has nothing to validate against.
 */
function getOutletDomains(outlet) {
  if (!outlet) return [];
  const domains = [];
  if (outlet.domain) domains.push(normalizeDomain(outlet.domain));
  if (Array.isArray(outlet.domainAliases)) {
    for (const d of outlet.domainAliases) {
      if (d) domains.push(normalizeDomain(d));
    }
  }
  return [...new Set(domains.filter(Boolean))];
}

/**
 * Subdomain-aware EXACT match: host === domain, or host is a subdomain of
 * domain (amp.nytimes.com matches nytimes.com). Deliberately NOT a loose
 * substring match (scraper.js's domainMatchesExpected uses
 * `actual.includes(expected) || expected.includes(actual)`, which would
 * wrongly match e.g. "notvulture.com" against "vulture.com") — this function
 * exists specifically to catch outlet-identity borrowing, so false negatives
 * (missing a real subdomain relationship) are far cheaper than false
 * positives (waving through a borrowed tier).
 */
function hostMatchesDomain(host, domain) {
  const h = normalizeHost(host);
  const d = normalizeDomain(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith('.' + d);
}

function extractHost(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * Does a review URL's host belong to outletId per the registry?
 *
 * @param {string} url
 * @param {string} outletId
 * @param {object} registry - loaded outlet-registry.json ({ outlets: {...} })
 * @returns {boolean|null}
 *   true  — host matches one of the outlet's registered domains
 *   false — outlet has ≥1 registered domain and NONE match (a genuine mismatch)
 *   null  — can't determine: missing url/outletId/registry, outlet not
 *           registered, outlet has no registered domain, or unparseable URL
 */
function hostMatchesOutletDomain(url, outletId, registry) {
  if (!url || !outletId || !registry) return null;
  // Canonicalize alias-form outletIds before lookup (e.g. "nymag" — the
  // registry keys outlets by their canonical id "vulture", not every alias).
  // Without this, an alias-spelled outletId misses the registry entirely and
  // returns null (unvalidatable) instead of being checked — adversarial
  // review finding: outletId "nymag" + a personal URL would otherwise sail
  // through this gate untested.
  const canonicalId = (registry.outlets && registry.outlets[String(outletId).toLowerCase()])
    ? String(outletId).toLowerCase()
    : normalizeOutlet(outletId);
  const outlet = registry.outlets && registry.outlets[canonicalId];
  if (!outlet) return null;
  const domains = getOutletDomains(outlet);
  if (domains.length === 0) return null;
  const host = extractHost(url);
  if (!host) return null;
  return domains.some((d) => hostMatchesDomain(host, d));
}

/**
 * Escape hatch: an operator can legitimize a review that genuinely doesn't
 * live on the outlet's own registered domain (a verified syndication/repost)
 * by setting allowUnvalidatedDomain + a reason AND carrying the full
 * manual-protection field set (memory/feedback_manual_review_protection_fields.md
 * — the same fields ingest-manual-review.js stamps for a verified manual
 * review). Missing any one of them means some OTHER rebuild guard would still
 * silently re-flag the file, so this requires all of them together, same as
 * the existing wrongProduction manual-clear convention.
 */
function hasOutletDomainEscapeHatch(data) {
  if (!data) return false;
  if (data.allowUnvalidatedDomain !== true) return false;
  if (typeof data.allowUnvalidatedDomainReason !== 'string' || !data.allowUnvalidatedDomainReason.trim()) return false;
  const cv = data.contentVerification || {};
  return (
    data.humanReviewScore != null &&
    data.manualContentTier === 'complete' &&
    data.wrongProduction === false &&
    data.wrongProductionManualClear === true &&
    data.allowEarlyDate === true &&
    data.wrongShow === false &&
    cv.wrongProduction === false &&
    cv.wrongArticle === false
  );
}

/**
 * Rebuild-exclusion-facing check, called from review-guards.js explainExclusion().
 *
 * @param {object} data - review-texts file contents
 * @param {object} registry - loaded outlet-registry.json
 * @returns {string|null} an exclusion reason when data's URL host doesn't
 *   match its outletId's registered domain and the escape hatch isn't fully
 *   satisfied; null when the file should NOT be excluded on domain grounds
 *   (host matches, can't be validated, or explicitly legitimized).
 */
function explainOutletDomainMismatch(data, registry) {
  if (!data || !data.url || !data.outletId) return null;
  // SCOPE (see file header): only the single-URL ingest path this card is
  // about. Every other source in the corpus has a legitimate reason to carry
  // a URL that doesn't live on the outlet's own domain.
  if (!VALIDATED_INGEST_SOURCES.has(data.source)) return null;
  // Wire services syndicate on arbitrary partner domains by design (AP
  // reviews live on huffpost.com, sfgate.com, …) — same exemption
  // isCrossOutletUrl() already applies (review-normalization.js).
  const normalizedOutletId = normalizeOutlet(data.outletId) || String(data.outletId).toLowerCase();
  if (WIRE_SERVICE_OUTLETS.has(normalizedOutletId)) return null;
  if (hasOutletDomainEscapeHatch(data)) return null;
  const matches = hostMatchesOutletDomain(data.url, data.outletId, registry);
  if (matches !== false) return null; // true (matches) or null (unvalidatable)
  const host = extractHost(data.url);
  return `URL host "${host}" does not match registered outlet "${data.outletId}"'s domain — likely outlet misattribution (borrowed tier weight)`;
}

module.exports = {
  normalizeHost,
  normalizeDomain,
  getOutletDomains,
  hostMatchesDomain,
  extractHost,
  hostMatchesOutletDomain,
  hasOutletDomainEscapeHatch,
  explainOutletDomainMismatch,
};
