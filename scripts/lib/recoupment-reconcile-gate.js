// Pure decision functions for reconcile-recoupment-claims.js.
// Tested by tests/unit/recoupment-reconcile-gate.test.mjs.

const { TRUSTED_RECOUPMENT_HOSTS } = require('./trusted-recoupment-domains');

const MAX_VERIFY_ATTEMPTS = 2;

// A pending recouped-claim entry is a stale duplicate when commercial.json
// already carries recouped:true for the same slug AND that existing entry
// carries an actual sources[].url citation (not just prose in
// recoupedSource) — i.e. some prior pipeline (Friday scraper, deep-research,
// manual apply) already resolved and machine-verifiably cited this claim,
// and the pending copy is just leftover. Deliberately stricter than
// audit-commercial-data.js's isUnsourcedRecouped (which also accepts prose
// recoupedSource as "sourced") — closing a pending entry with no new
// verification should require the same bar the reconciler itself writes
// (a fetched, trusted-host URL), not take someone else's prose on faith.
function isStaleDuplicate(existingCommercialEntry) {
  if (!existingCommercialEntry) return false;
  if (existingCommercialEntry.recouped !== true) return false;
  return Array.isArray(existingCommercialEntry.sources) &&
    existingCommercialEntry.sources.some(s => s && typeof s.url === 'string' && s.url.trim().length > 0);
}

// Entries with verifyAttempts already at the cap are left alone — genuinely
// unverifiable claims should stop burning SERP/LLM budget every run and sit
// for human review (the manual queue then contains ONLY these).
function shouldAttemptVerification(entry, maxAttempts = MAX_VERIFY_ATTEMPTS) {
  const attempts = entry.verifyAttempts || 0;
  return attempts < maxAttempts;
}

// A fetched-and-classified article confirms a claim when it's an exact
// production match, high confidence, and its host is one we trust to auto-
// apply from (same bar as the Friday scraper / RSS poller hot path).
function isConfirmingVerdict(verdict, host) {
  if (!verdict) return false;
  if (verdict.recouped !== true) return false;
  if (verdict.productionMatch !== 'exact') return false;
  if (verdict.confidence !== 'high') return false;
  if (!host || !TRUSTED_RECOUPMENT_HOSTS.has(host)) return false;
  return true;
}

// Build the pending-entry-shaped overlay to feed into
// commercial-apply-gate.buildCommercialEntry(overlay, existing, {isClaimAutoApply:true, ...})
// once a verdict confirms the claim. Mirrors the shape scrape-recoupment-
// announcements.js / poll-trade-press-rss.js already write, so the shared
// gate's merge logic (preserve designation/cap/notes, dedupe sources) applies
// unmodified.
function buildVerifiedOverlay(entry, verdict, articleUrl, host) {
  return {
    recouped: true,
    _recoupedClaim: true,
    recoupedDate: verdict.recoupedDate || null,
    recoupedSource: articleUrl,
    confidence: verdict.confidence,
    evidence: verdict.evidence || null,
    sourceHost: host,
    detectedBy: 'recoupment-reconciler',
    sources: [{ type: 'trade', url: articleUrl, date: verdict.articleDate || null }],
  };
}

module.exports = {
  MAX_VERIFY_ATTEMPTS,
  isStaleDuplicate,
  shouldAttemptVerification,
  isConfirmingVerdict,
  buildVerifiedOverlay,
};
