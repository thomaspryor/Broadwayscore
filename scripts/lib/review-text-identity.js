/**
 * review-text-identity.js — "are these two review files the SAME article?"
 * decisions for same-outlet twins (a URL-bearing "Unknown"-byline file and a
 * URL-less named-critic file for the same review).
 *
 * Context (2026-09-24): Theatre Record ingest created URL-less named files
 * (e.g. how-the-other-half-loves-west-end-2026/british-theatre--vera-liber.json,
 * url null) beside an existing URL-bearing unknown-byline twin
 * (british-theatre--unknown.json, url https://www.britishtheatreguide.info/...).
 * The rebuild's unknown-critic dedup then dropped the Unknown twin and the
 * site showed the review with no link (27 reviews.json rows / 22 shows).
 *
 * Identity signal = a shared verbatim prose passage (16-word shingles, reusing
 * aggregator-outlet-byline-audit.js's shingler, which strips quoted
 * dialogue/lyrics and page chrome first). The two copies usually differ at the
 * edges (outlet page header vs Theatre Record's clean body), so prefix
 * fingerprints (computeContentFingerprint) do not work here.
 *
 * Pure — no I/O. Callers pass parsed JSON / precomputed booleans.
 */

const { wordShingles, normalizeForShingles } = require('./aggregator-outlet-byline-audit');
const { isExclusionFlagged } = require('./merge-review-fields');

const DEFAULT_MIN_SHARED_SHINGLES = 2;

/**
 * True when texts `a` and `b` share at least `minShared` verbatim 16-word
 * passages. Missing/short text on either side → false (unverifiable).
 */
function textsShareVerbatimPassage(a, b, minShared = DEFAULT_MIN_SHARED_SHINGLES) {
  if (!a || !b) return false;
  const normB = normalizeForShingles(b);
  if (normB.length < 200) return false;
  let shared = 0;
  for (const shingle of wordShingles(a)) {
    if (normB.includes(shingle)) {
      shared++;
      if (shared >= minShared) return true;
    }
  }
  return false;
}

function isUnknownCritic(name) {
  const n = String(name || '').trim().toLowerCase();
  return !n || n === 'unknown' || n === 'unnamed';
}

/**
 * Ingest-side decision (extract-theatre-record.js): where should an incoming
 * Theatre Record review for outlet+critic be written?
 *
 * @param {object} p
 * @param {string} p.exactPath        - path of outlet--critic.json for the incoming critic
 * @param {boolean} p.exactExists      - whether exactPath exists
 * @param {{path:string,data:object|null}|null} p.variant - findExistingReviewFile() result
 * @param {string} p.incomingCritic   - TR critic name (may be 'Unknown')
 * @param {string} p.incomingText     - TR fullText
 * @returns {{action:'merge'|'create', path:string, fillCritic:boolean, reason:string}}
 */
function resolveTheatreRecordWriteTarget({ exactPath, exactExists, variant, incomingCritic, incomingText }) {
  if (exactExists) {
    return { action: 'merge', path: exactPath, fillCritic: false, reason: 'exact-filename' };
  }
  if (!variant || !variant.path || !variant.data) {
    return { action: 'create', path: exactPath, fillCritic: false, reason: 'no-existing-variant' };
  }
  const data = variant.data;
  if (isExclusionFlagged(data)) {
    return { action: 'create', path: exactPath, fillCritic: false, reason: 'variant-exclusion-flagged' };
  }
  const variantUnknown = isUnknownCritic(data.criticName);
  const incomingUnknown = isUnknownCritic(incomingCritic);
  if (!variantUnknown || incomingUnknown) {
    // Same named critic under a variant slug (accent/alias), or both unknown:
    // findExistingReviewFile already confirmed critic compatibility.
    return { action: 'merge', path: variant.path, fillCritic: false, reason: 'same-critic-variant' };
  }
  // Variant is an Unknown-byline file and incoming names a real critic: only
  // claim it when the text proves it is the same article — otherwise a
  // different (still-unattributed) review at the same outlet would be
  // relabelled with this critic's name.
  if (textsShareVerbatimPassage(incomingText, data.fullText)) {
    return { action: 'merge', path: variant.path, fillCritic: true, reason: 'unknown-variant-same-text' };
  }
  return { action: 'create', path: exactPath, fillCritic: false, reason: 'unknown-variant-text-unverified' };
}

/**
 * Merge Theatre Record fields into an existing review file (pure — returns a
 * new object). Outlet-sourced data (url, score, text) always wins; TR only
 * fills gaps. With fillCritic, an Unknown/empty criticName takes the TR byline
 * (the rebuild's stale --unknown cleanup renames the file afterwards).
 */
function mergeTheatreRecordIntoExisting(existing, reviewData, { fillCritic = false } = {}) {
  const merged = { ...existing };
  if (!merged.fullText && reviewData.fullText) merged.fullText = reviewData.fullText;
  if (!merged.textWordCount && reviewData.textWordCount) merged.textWordCount = reviewData.textWordCount;
  if (!merged.contentTier || merged.contentTier === 'stub' || merged.contentTier === 'excerpt' || merged.contentTier === 'invalid') {
    merged.contentTier = reviewData.contentTier;
    merged.contentTierReason = reviewData.contentTierReason;
  }
  if (!merged.publishDate && reviewData.publishDate) merged.publishDate = reviewData.publishDate;
  if (fillCritic && isUnknownCritic(merged.criticName) && !isUnknownCritic(reviewData.criticName)) {
    merged.criticName = reviewData.criticName;
  }
  merged.theatreRecordUrl = reviewData.theatreRecordUrl;
  if (!merged.source) merged.source = 'theatre-record';
  merged.sources = Array.isArray(merged.sources) ? [...merged.sources] : [merged.source];
  if (!merged.sources.includes('theatre-record')) merged.sources.push('theatre-record');
  return merged;
}

/**
 * Rebuild-side decision (rebuild-all-reviews.js skippedUnknownCriticDedup):
 * the Unknown-byline file is being dropped because a named critic already
 * holds this outlet's slot. Should its URL be carried onto the kept entry?
 *
 * Only the URL moves — never score, text or flags.
 *
 * @param {object} dropped
 * @param {string|null} dropped.url
 * @param {string} [dropped.fullText]
 * @param {object} dropped.data              - parsed JSON (for exclusion flags)
 * @param {boolean} dropped.urlOwnedByOutlet  - URL host belongs to this outlet (not a roundup/aggregator URL)
 * @param {boolean} dropped.urlAlreadyKept    - URL already backs another kept entry in this show
 * @param {Array<{url:string|null, fullText?:string}>} keptCandidates - kept named entries at the same outlet
 * @returns {{carry:boolean, index?:number, url?:string, reason:string}}
 */
function decideUnknownTwinUrlCarry(dropped, keptCandidates) {
  if (!dropped || !dropped.url) return { carry: false, reason: 'dropped-has-no-url' };
  if (isExclusionFlagged(dropped.data)) return { carry: false, reason: 'dropped-exclusion-flagged' };
  if (!dropped.urlOwnedByOutlet) return { carry: false, reason: 'url-not-outlet-domain' };
  if (dropped.urlAlreadyKept) return { carry: false, reason: 'url-already-kept' };
  const matches = [];
  (keptCandidates || []).forEach((c, i) => {
    if (c && !c.url && textsShareVerbatimPassage(dropped.fullText, c.fullText)) matches.push(i);
  });
  if (matches.length === 0) return { carry: false, reason: 'no-urlless-same-text-twin' };
  if (matches.length > 1) return { carry: false, reason: 'ambiguous-multiple-twins' };
  return { carry: true, index: matches[0], url: dropped.url, reason: 'same-text-urlless-twin' };
}

module.exports = {
  textsShareVerbatimPassage,
  isUnknownCritic,
  resolveTheatreRecordWriteTarget,
  mergeTheatreRecordIntoExisting,
  decideUnknownTwinUrlCarry,
  DEFAULT_MIN_SHARED_SHINGLES,
};
