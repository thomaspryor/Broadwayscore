// Pure decision functions for reconcile-recoupment-claims.js.
// Tested by tests/unit/recoupment-reconcile-gate.test.mjs.

const { TRUSTED_RECOUPMENT_HOSTS } = require('./trusted-recoupment-domains');

const MAX_VERIFY_ATTEMPTS = 2;

// Same contract as commercial-apply-gate.js's RECOUPED_DATE_RE — validate-
// data.js only accepts YYYY or YYYY-MM (validate-data.js:2835-2840). The
// shared classifier prompt (recoupment-classify.js) asks for YYYY-MM-DD,
// so a raw verdict.recoupedDate would fail validation the moment it's
// written. Truncate a full date down to month precision; reject anything
// else unparseable rather than writing a value that breaks the pipeline.
function normalizeRecoupedDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const fullDate = /^(\d{4}-\d{2})-\d{2}$/.exec(trimmed);
  if (fullDate) return fullDate[1];
  if (/^\d{4}(-\d{2})?$/.test(trimmed)) return trimmed;
  return null;
}

// A pending recouped-claim entry is a stale duplicate when commercial.json
// already carries recouped:true for the same slug AND that existing entry
// carries an actual sources[].url citation — i.e. some prior pipeline
// (Friday scraper, deep-research, manual apply) already resolved and
// machine-verifiably cited this claim, and the pending copy is just
// leftover. As of 2026-07-20 this uses the SAME bar as
// audit-commercial-data.js's isUnsourcedRecouped (a real, extractable URL in
// recoupedSource or sources[].url; see scripts/lib/commercial-citation-guards.js)
// — previously that check also accepted plain-text prose as "sourced", which
// this reconciler deliberately did not; the gap has since closed.
//
// pendingEntry is optional but strongly recommended: if the pending claim
// carries its own recoupedDate and it names a DIFFERENT year than the
// existing entry, this is not a confident duplicate — it may be a
// correction (wrong date, or even a different production sharing the
// slug) — so don't silently discard it. Fall through to independent
// SERP verification instead, which will confirm or correct the date.
function isStaleDuplicate(existingCommercialEntry, pendingEntry) {
  if (!existingCommercialEntry) return false;
  if (existingCommercialEntry.recouped !== true) return false;
  const hasSourceUrl = Array.isArray(existingCommercialEntry.sources) &&
    existingCommercialEntry.sources.some(s => s && typeof s.url === 'string' && s.url.trim().length > 0);
  if (!hasSourceUrl) return false;

  const pendingYear = pendingEntry?.recoupedDate ? String(pendingEntry.recoupedDate).slice(0, 4) : null;
  const existingYear = existingCommercialEntry.recoupedDate ? String(existingCommercialEntry.recoupedDate).slice(0, 4) : null;
  if (pendingYear && existingYear && pendingYear !== existingYear) return false;

  return true;
}

// Entries with verifyAttempts already at the cap are left alone — genuinely
// unverifiable claims should stop burning SERP/LLM budget every run and sit
// for human review (the manual queue then contains ONLY these).
function shouldAttemptVerification(entry, maxAttempts = MAX_VERIFY_ATTEMPTS) {
  const attempts = entry.verifyAttempts || 0;
  return attempts < maxAttempts;
}

// A fetched-and-classified article confirms a claim when it's an exact
// production match, high confidence, its host is one we trust to auto-apply
// from (same bar as the Friday scraper / RSS poller hot path), AND it
// carries a date that survives normalizeRecoupedDate — mirrors
// commercial-apply-gate.js's isAutoApplyableClaim, which also refuses to
// auto-apply a claim with no clean parseable date rather than writing
// recouped:true with a missing/invalid recoupedDate (validate-data.js hard-
// rejects that combination).
function isConfirmingVerdict(verdict, host) {
  if (!verdict) return false;
  if (verdict.recouped !== true) return false;
  if (verdict.productionMatch !== 'exact') return false;
  if (verdict.confidence !== 'high') return false;
  if (!host || !TRUSTED_RECOUPMENT_HOSTS.has(host)) return false;
  if (!normalizeRecoupedDate(verdict.recoupedDate)) return false;
  return true;
}

// Build the pending-entry-shaped overlay to feed into
// commercial-apply-gate.buildCommercialEntry(overlay, existing, {isClaimAutoApply:true, ...})
// once a verdict confirms the claim. Mirrors the shape scrape-recoupment-
// announcements.js / poll-trade-press-rss.js already write, so the shared
// gate's merge logic (preserve designation/cap/notes, dedupe sources) applies
// unmodified. Caller must have already checked isConfirmingVerdict (which
// guarantees normalizeRecoupedDate(verdict.recoupedDate) is non-null).
function buildVerifiedOverlay(entry, verdict, articleUrl, host) {
  return {
    recouped: true,
    _recoupedClaim: true,
    recoupedDate: normalizeRecoupedDate(verdict.recoupedDate),
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
  normalizeRecoupedDate,
  isStaleDuplicate,
  shouldAttemptVerification,
  isConfirmingVerdict,
  buildVerifiedOverlay,
};
