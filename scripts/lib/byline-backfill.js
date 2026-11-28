'use strict';
/**
 * Shared helpers for byline backfills that move a review file onto its real
 * critic's filename (<outletId>--<criticSlug>.json). Extracted from
 * backfill-theaterlife-bylines.js so the Chicago backfill (BRO-6518,
 * backfill-tic-bylines.js) reuses the same duplicate test and rename path
 * instead of a copy (CLAUDE.md §15).
 */
const { computeContentFingerprint } = require('./content-quality');
const { foldDiacritics } = require('./title-match');
const { normalizeUrl } = require('./review-normalization');
const { safeRenameReview } = require('./review-write-guard');

function wordSet(t) {
  return new Set(foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3));
}

// Asymmetric containment: fraction of the SMALLER text's words present in the
// larger. Robust to a byline-header prefix that offsets a positional fingerprint.
function containmentOf(A, B) {
  if (!A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let hits = 0;
  for (const w of small) if (big.has(w)) hits++;
  return hits / small.size;
}

function sameReview(a, b) {
  // Same URL (normalized) → same underlying review.
  const ua = a.url ? normalizeUrl(a.url) : null;
  const ub = b.url ? normalizeUrl(b.url) : null;
  if (ua && ub && ua === ub) return true;
  // Same content fingerprint (identical text).
  const fa = computeContentFingerprint(a.fullText || '', 500);
  const fb = computeContentFingerprint(b.fullText || '', 500);
  if (fa && fb && fa === fb) return true;
  // Near-identical body. Require both texts to carry real substance (>=40
  // distinct long words) before trusting containment: a short stub is trivially
  // "contained" in a full review even when they are different pieces, and this
  // branch feeds a destructive dedup. Short pairs fall through to CONFLICT.
  const A = wordSet(a.fullText), B = wordSet(b.fullText);
  if (Math.min(A.size, B.size) >= 40 && containmentOf(A, B) >= 0.85) return true;
  return false;
}

// A review carries more signal than another if its body is materially longer,
// or it is scored while the other is not.
function richness(d) {
  return { len: (d.fullText || '').length, scored: d.assignedScore != null || !!d.llmScore };
}

// Write `data` under the correct-critic filename, stamping the corrected
// criticName + provenance and clearing stale byline-mismatch flags (mirrors the
// canonical override in collect-review-texts.js). fullTextWrongAuthor matters
// most: review-guards.js excludes a review when it is true, so a stale value
// would silently drop the newly-correct review from the rebuild.
function renameOntoCritic(srcPath, dstPath, data, critic, { source, priorCritic }) {
  const newData = { ...data, criticName: critic, criticEnrichedFrom: source, _priorCriticName: priorCritic };
  delete newData.misattributedFullText;
  delete newData.extractedByline;
  delete newData.expectedCritic;
  delete newData.fullTextWrongAuthor;
  delete newData.fullTextWrongAuthorAt;
  delete newData._authorMismatch;
  return safeRenameReview(srcPath, dstPath, { newData });
}

module.exports = { wordSet, containmentOf, sameReview, richness, renameOntoCritic };
