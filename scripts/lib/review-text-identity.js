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
 * Identity signal = substantial verbatim prose coverage (see
 * textsShareVerbatimPassage). The two copies usually differ at the edges
 * (outlet page header vs Theatre Record's clean body), so prefix fingerprints
 * (computeContentFingerprint) do not work here.
 *
 * Pure — no I/O. Callers pass parsed JSON / precomputed booleans.
 */

const { stripQuotedSpans, stripBoilerplate, normalizeForShingles, isCastListLike } = require('./aggregator-outlet-byline-audit');
const { isExclusionFlagged } = require('./merge-review-fields');
const { criticIsCompatibleMergeTarget } = require('./review-normalization');

const SHINGLE_WORDS = 16;
const MIN_SHARED_WINDOWS = 3;
const MIN_COVERAGE = 0.3;
// Back-compat export name.
const DEFAULT_MIN_SHARED_SHINGLES = MIN_SHARED_WINDOWS;

// Symmetric normalization: BOTH texts get quoted dialogue/lyrics and page
// chrome stripped, then are lowercased and reduced to alphanumeric word
// tokens (punctuation differences between an outlet page and Theatre Record's
// transcription must not break a match). Keeps the raw token so the cast-list
// density check can still see commas.
function identityTokens(text) {
  // Fold diacritics first so 'Misérables' tokenizes whole, not as 'misrables'.
  const cleaned = require('./title-match').foldDiacritics(normalizeForShingles(stripBoilerplate(stripQuotedSpans(text)))).toLowerCase();
  const out = [];
  for (const raw of cleaned.split(' ')) {
    const w = raw.replace(/[^a-z0-9]+/g, '');
    if (w) out.push({ w, raw });
  }
  return out;
}

/**
 * "Same article?" — true when a SUBSTANTIAL share of the shorter text is
 * reproduced verbatim in the longer one.
 *
 * Method: the shorter text is cut into NON-overlapping 16-word windows (one
 * shared 20-word sentence can count at most once — the old stride-4 shingler
 * let a single passage score 2 "matches"); every 16-word window (stride 1) of
 * the longer text goes into a set. Same article ⇔ at least `minShared` (3)
 * windows match AND they cover ≥ `minCoverage` (30%) of the shorter text's
 * windows. Quoted spans are stripped from BOTH sides, so a review quoting
 * another (or two reviews quoting the same lyric) does not match; a shared
 * synopsis/press-release paragraph inside two otherwise different reviews
 * stays well under 30% coverage. Cast-list-like windows (3+ commas) are
 * ignored. Missing/short text (< minShared windows) → false (unverifiable).
 */
function textsShareVerbatimPassage(a, b, { minShared = MIN_SHARED_WINDOWS, minCoverage = MIN_COVERAGE } = {}) {
  if (!a || !b) return false;
  const ta = identityTokens(a);
  const tb = identityTokens(b);
  const [shortT, longT] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (shortT.length < SHINGLE_WORDS * minShared) return false;
  const longSet = new Set();
  for (let i = 0; i + SHINGLE_WORDS <= longT.length; i++) {
    longSet.add(longT.slice(i, i + SHINGLE_WORDS).map(t => t.w).join(' '));
  }
  let windows = 0;
  let shared = 0;
  for (let i = 0; i + SHINGLE_WORDS <= shortT.length; i += SHINGLE_WORDS) {
    const win = shortT.slice(i, i + SHINGLE_WORDS);
    if (isCastListLike(win.map(t => t.raw).join(' '))) continue;
    windows++;
    if (longSet.has(win.map(t => t.w).join(' '))) shared++;
  }
  if (windows === 0) return false;
  return shared >= minShared && shared / windows >= minCoverage;
}

function isUnknownCritic(name) {
  const n = String(name || '').trim().toLowerCase();
  return !n || n === 'unknown' || n === 'unnamed';
}

// Both name a real person and they are NOT the same one (normalized / alias).
function namedCriticsDiffer(a, b) {
  if (isUnknownCritic(a) || isUnknownCritic(b)) return false;
  return !criticIsCompatibleMergeTarget(String(a), String(b));
}

/**
 * Ingest-side decision (extract-theatre-record.js): where should an incoming
 * Theatre Record review for outlet+critic be written?
 *
 * The STORED criticName is always revalidated — a filename slug can lag it
 * (an "--unknown" file whose byline was filled by an earlier Unknown→Alice
 * merge keeps its filename until the rebuild renames it). A file whose stored
 * byline names a DIFFERENT real critic is never a merge target.
 *
 * @param {object} p
 * @param {string} p.exactPath        - path of outlet--critic.json for the incoming critic
 * @param {boolean} p.exactExists      - whether exactPath exists
 * @param {object|null} [p.exactData]  - parsed JSON at exactPath (when it exists)
 * @param {{path:string,data:object|null}|null} p.variant - findExistingReviewFile() result
 * @param {string} p.incomingCritic   - TR critic name (may be 'Unknown')
 * @param {string} p.incomingText     - TR fullText
 * @returns {{action:'merge'|'create'|'skip', path:string, fillCritic:boolean, reason:string}}
 */
function resolveTheatreRecordWriteTarget({ exactPath, exactExists, exactData = null, variant, incomingCritic, incomingText }) {
  if (exactExists) {
    const stored = exactData ? exactData.criticName : null;
    if (exactData && namedCriticsDiffer(incomingCritic, stored)) {
      return { action: 'skip', path: exactPath, fillCritic: false, reason: 'exact-filename-different-stored-critic' };
    }
    if (exactData && isUnknownCritic(incomingCritic) && !isUnknownCritic(stored)
        && !textsShareVerbatimPassage(incomingText, exactData.fullText)) {
      // An "--unknown" filename now holding a named critic's review; an
      // unattributed TR review may be a different article at that outlet.
      return { action: 'skip', path: exactPath, fillCritic: false, reason: 'exact-filename-named-stored-critic-text-unverified' };
    }
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
  if (!variantUnknown && !incomingUnknown) {
    // Same named critic under a variant slug (accent/alias) — confirmed on the
    // STORED byline, never on the filename match alone.
    if (namedCriticsDiffer(incomingCritic, data.criticName)) {
      return { action: 'create', path: exactPath, fillCritic: false, reason: 'variant-different-stored-critic' };
    }
    return { action: 'merge', path: variant.path, fillCritic: false, reason: 'same-critic-variant' };
  }
  if (variantUnknown && incomingUnknown) {
    return { action: 'merge', path: variant.path, fillCritic: false, reason: 'both-unknown-variant' };
  }
  // Exactly one side is unattributed: only claim the variant when the text
  // proves it is the same article — otherwise a different review at the same
  // outlet would be merged into / relabelled.
  if (textsShareVerbatimPassage(incomingText, data.fullText)) {
    return variantUnknown
      ? { action: 'merge', path: variant.path, fillCritic: true, reason: 'unknown-variant-same-text' }
      : { action: 'merge', path: variant.path, fillCritic: false, reason: 'named-variant-same-text' };
  }
  return {
    action: 'create',
    path: exactPath,
    fillCritic: false,
    reason: variantUnknown ? 'unknown-variant-text-unverified' : 'named-variant-text-unverified',
  };
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

// Guards shared by both rebuild carry paths. Only the URL ever moves.
function urlCarryPreconditions(dropped) {
  if (!dropped || !dropped.url) return 'dropped-has-no-url';
  if (isExclusionFlagged(dropped.data)) return 'dropped-exclusion-flagged';
  if (!dropped.urlOwnedByOutlet) return 'url-not-outlet-domain';
  if (dropped.urlAlreadyKept) return 'url-already-kept';
  return null;
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
  const blocked = urlCarryPreconditions(dropped);
  if (blocked) return { carry: false, reason: blocked };
  const matches = [];
  (keptCandidates || []).forEach((c, i) => {
    if (c && !c.url && textsShareVerbatimPassage(dropped.fullText, c.fullText)) matches.push(i);
  });
  if (matches.length === 0) return { carry: false, reason: 'no-urlless-same-text-twin' };
  if (matches.length > 1) return { carry: false, reason: 'ambiguous-multiple-twins' };
  return { carry: true, index: matches[0], url: dropped.url, reason: 'same-text-urlless-twin' };
}

/**
 * Rebuild-side decision for the EARLIER exit — the within-show full-text
 * duplicate (identical fingerprint) drop. When the URL-less named copy was
 * processed first and kept, the identical URL-bearing copy is dropped there
 * and never reaches the unknown-critic dedup's carry. Same guards as
 * decideUnknownTwinUrlCarry, plus: the kept entry must be the very file the
 * fingerprint matched, and it must be the ONLY URL-less kept named entry at
 * the outlet.
 *
 * @param {object} dropped                - as decideUnknownTwinUrlCarry
 * @param {Array<{url:string|null, fullText?:string, file:string}>} keptCandidates - kept named entries at the dropped file's outlet
 * @param {string} matchedFile            - file whose fingerprint the dropped file duplicated
 * @returns {{carry:boolean, index?:number, url?:string, reason:string}}
 */
function decideDuplicateTwinUrlCarry(dropped, keptCandidates, matchedFile) {
  const blocked = urlCarryPreconditions(dropped);
  if (blocked) return { carry: false, reason: blocked };
  const urlless = [];
  (keptCandidates || []).forEach((c, i) => { if (c && !c.url) urlless.push(i); });
  if (urlless.length === 0) return { carry: false, reason: 'no-urlless-kept-entry' };
  if (urlless.length > 1) return { carry: false, reason: 'ambiguous-multiple-urlless' };
  const idx = urlless[0];
  const target = keptCandidates[idx];
  if (!matchedFile || target.file !== matchedFile) return { carry: false, reason: 'urlless-entry-not-fingerprint-match' };
  if (!textsShareVerbatimPassage(dropped.fullText, target.fullText)) return { carry: false, reason: 'text-unverified' };
  return { carry: true, index: idx, url: dropped.url, reason: 'identical-text-urlless-twin' };
}

module.exports = {
  textsShareVerbatimPassage,
  isUnknownCritic,
  namedCriticsDiffer,
  resolveTheatreRecordWriteTarget,
  mergeTheatreRecordIntoExisting,
  decideUnknownTwinUrlCarry,
  decideDuplicateTwinUrlCarry,
  DEFAULT_MIN_SHARED_SHINGLES,
  MIN_SHARED_WINDOWS,
  MIN_COVERAGE,
};
