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

const { WIRE_SERVICE_OUTLETS, normalizeOutlet, resolveOutletFromUrl } = require('./review-normalization');

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

// Archival / republication hosts a review legitimately lives on under its
// own outlet's id: newspapers.com OCR scans of historical reviews and
// Wayback Machine mirrors. (Wire-service syndication is exempted by outlet
// id, and aggregator hosts never resolve to a different registered outlet
// on the live corpus — 0 of 44 mismatches on 2026-09-28.)
const HOST_MISMATCH_EXEMPT_HOSTS = ['newspapers.com', 'web.archive.org', 'archive.org', 'archive.ph', 'archive.today'];

/**
 * Audit advisory (2026 data audit S7-T6, BRO-4204): does the review URL's
 * host belong to a DIFFERENT registered outlet than the row's outletId?
 *
 * The outlet id on a review file comes from the aggregator's label, not
 * from the URL host, so a Time Out review can be filed as NYT
 * (every-brilliant-thing-2026 / Adam Feldman, 2026-03). Unlike
 * explainOutletDomainMismatch above — the scoped EXCLUSION for the
 * submit-review-form ingest path — this is never a gate: rebuild-all-reviews
 * stamps `outletHostMismatch: true` on the emitted reviews.json row and
 * prints one advisory line, and the audit consumes the field. It fires
 * whenever the host resolves to another registered outlet; `tiersDiffer`
 * says whether the mismatch also borrows tier weight (the Feldman case is
 * T1 → T1, still an attribution error on the live site).
 *
 * Exempt: wire services (AP/Reuters/Bloomberg/UPI syndicate on partner
 * hosts by design), newspapers.com / web.archive.org provenance, and
 * dual-hosted brands — an outlet whose own registry `domain`/`domainAliases`
 * claim the host is never a mismatch, which is what keeps timeout-london on
 * timeout.com/newyork (and telegraph vs sunday-telegraph) quiet.
 *
 * Host → outlet resolution delegates to review-normalization.js's
 * resolveOutletFromUrl (the canonical domain index with its collision
 * rules); tiers and domain ownership are read off the registry the caller
 * passes, so tests run against the real data/outlet-registry.json.
 *
 * @param {{ outletId?: string, url?: string }} row
 * @param {object} registry - loaded outlet-registry.json ({ outlets: {...} })
 * @returns {{ mismatch: boolean, tiersDiffer: boolean, host: string|null,
 *   outletId: string|null, outletTier: number|null, hostOutletId: string|null,
 *   hostOutletTier: number|null, reason: string }}
 */
function classifyOutletHostMismatch({ outletId, url } = {}, registry) {
  const out = {
    mismatch: false, tiersDiffer: false, host: null,
    outletId: null, outletTier: null, hostOutletId: null, hostOutletTier: null, reason: 'unvalidatable',
  };
  if (!url || !outletId || !registry || !registry.outlets) return out;
  const host = extractHost(url);
  if (!host) return { ...out, reason: 'unparseable-url' };
  out.host = host;
  if (HOST_MISMATCH_EXEMPT_HOSTS.some((d) => hostMatchesDomain(host, d))) return { ...out, reason: 'archival-host' };
  const lower = String(outletId).toLowerCase();
  const canonicalId = registry.outlets[lower] ? lower : normalizeOutlet(outletId);
  const outlet = canonicalId ? registry.outlets[canonicalId] : null;
  if (!outlet) return { ...out, reason: 'outlet-not-registered' };
  out.outletId = canonicalId;
  out.outletTier = outlet.tier || 3;
  if (WIRE_SERVICE_OUTLETS.has(canonicalId)) return { ...out, reason: 'wire-service' };
  if (getOutletDomains(outlet).some((d) => hostMatchesDomain(host, d))) return { ...out, reason: 'outlet-owns-host' };
  const resolved = resolveOutletFromUrl(url);
  const hostOutletId = resolved && resolved.outletId ? String(resolved.outletId) : null;
  if (!hostOutletId) return { ...out, reason: 'host-not-registered' };
  if (hostOutletId === canonicalId) return { ...out, reason: 'same-outlet' };
  const hostOutlet = registry.outlets[hostOutletId];
  if (!hostOutlet) return { ...out, reason: 'host-outlet-not-in-registry' };
  out.hostOutletId = hostOutletId;
  out.hostOutletTier = hostOutlet.tier || 3;
  out.mismatch = true;
  out.tiersDiffer = out.outletTier !== out.hostOutletTier;
  out.reason = `URL host "${host}" belongs to registered outlet "${hostOutletId}" (T${out.hostOutletTier}), not "${canonicalId}" (T${out.outletTier})${out.tiersDiffer ? ' — tiers differ' : ''}`;
  return out;
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
  HOST_MISMATCH_EXEMPT_HOSTS,
  classifyOutletHostMismatch,
};
