/**
 * Score-extractor pre-pass — text-only score extraction with the same gate
 * the /ingest UI applies (src/app/api/admin/ingest-review/route.ts:228-335).
 *
 * Why this exists
 * ---------------
 * Lost Boys 2026-04-26 Issue #8 (memory/lost-boys-2026-opening-night-postmortem.md):
 * orchestrator auto-discovery (BWW Review Roundup, Playbill Verdict, DTLI
 * scrapers) creates stub files with fullText but no llmScore — the LLM
 * ensemble has budget caps and contentTier gates that silently skip them. By
 * the time rebuild runs, the file has fullText but no score, so it never
 * renders on the live page.
 *
 * The /ingest UI flow already runs this pass when an operator pastes a review
 * (Issue #6 fix, commit 818d4c1021 + 77e7ac2e96 + 0b0dc46a1a). This module
 * brings the same pass to scripts/collect-review-texts.js so the orchestrator
 * path gets the same defense-in-depth.
 *
 * Gate (mirrors /ingest exactly)
 * ------------------------------
 *   - file has no humanReviewScore
 *   - file has no originalScore (any source — never clobber prior extractions)
 *   - fullText is at least minTextLength chars
 *   - extractor returns 1-100 score from a trusted source
 *
 * Trusted source = OUTLET_VERIFIED_SOURCES set OR 'unicode-stars-fallthrough'
 * (the KNOWN_STAR_OUTLETS anchored fallback, positionally safe — first/last
 * 15% of text only). Generic text-pattern / og-description / wp-api-title
 * sources are excluded because they have no positional anchor when html='' is
 * passed and can FP on quoted critic mentions or page chrome.
 *
 * The previous local STRONG_EXTRACTOR_SOURCES list at /ingest missed ~19
 * outlet-anchored sources (Codex ship-check 2026-04-27 P1). Importing
 * OUTLET_VERIFIED_SOURCES from the canonical extractor module keeps both
 * call-sites in sync as new outlet extractors are added.
 *
 * Pure / no side effects — caller mutates `data` using the returned values.
 *
 * Returns null when the gate declines or the extractor returns nothing
 * trustworthy. Returns an object with the field updates to apply when the
 * gate passes.
 */

const { extractScore, OUTLET_VERIFIED_SOURCES } = require('./score-extractors');

function isTrustedExtractorSource(source) {
  if (!source) return false;
  if (OUTLET_VERIFIED_SOURCES.has(source)) return true;
  // KNOWN_STAR_OUTLETS anchored fallthrough — first/last 15% of text only,
  // positionally safe. Match /ingest's whitelist.
  if (source === 'unicode-stars-fallthrough') return true;
  return false;
}

/**
 * @param {object} data
 *     The review-text JSON object (read-only here — caller mutates).
 * @param {object} opts
 * @param {string} opts.fullText
 *     The fetched/cleaned review body text.
 * @param {string} opts.outletId
 *     Canonical outlet id (lowercase). Required.
 * @param {number} [opts.minTextLength=100]
 *     Below this many chars we don't even try (no extractor reliably works
 *     on tiny excerpts).
 * @returns {{
 *   originalScore: string,
 *   originalScoreSource: string,
 *   originalScoreNormalized: number,
 *   humanReviewScore: number,
 *   sourceLabel: string,
 * } | null}
 */
function runScoreExtractorPrePass(data, opts) {
  const { fullText, outletId, minTextLength = 100 } = opts || {};
  if (!outletId) return null;
  const text = (fullText || '').toString();
  if (text.length < minTextLength) return null;

  const hasHuman =
    typeof data.humanReviewScore === 'number' &&
    data.humanReviewScore >= 1 &&
    data.humanReviewScore <= 100;
  const hasOriginal =
    typeof data.originalScore === 'string' &&
    data.originalScore.trim().length > 0;
  if (hasHuman || hasOriginal) return null;

  let extracted;
  try {
    extracted = extractScore('', text, outletId);
  } catch {
    // Extractor errors must never block the surrounding write. Fall through.
    return null;
  }
  if (!extracted) return null;

  if (
    !Number.isFinite(extracted.normalizedScore) ||
    extracted.normalizedScore < 1 ||
    extracted.normalizedScore > 100 ||
    !isTrustedExtractorSource(extracted.source)
  ) {
    return null;
  }

  return {
    originalScore: extracted.originalScore,
    originalScoreSource: extracted.source,
    originalScoreNormalized: extracted.normalizedScore,
    humanReviewScore: extracted.normalizedScore,
    sourceLabel: extracted.source,
  };
}

module.exports = { runScoreExtractorPrePass, isTrustedExtractorSource };
