/**
 * Write-topology invariant: when a review file's `url` moves to a DIFFERENT
 * canonical article, state derived from the OLD url must not survive the write.
 *
 * JCS Palladium opening week (2026-07-08..10, Notion 399637c5-416f-81fc): the
 * real Guardian/Telegraph/Standard/FT/Daily Mail reviews were discovered and
 * merged IN PLACE into outlet--critic files still carrying Hello Dolly state
 * from the URL each file used to hold — wrongShow/wrongProduction flags,
 * westEndTheatreExcerpt, aggregatorStars, llmScore — so every real review was
 * suppressed. Manual wrongShowReason flags made it worse: the replacement path
 * honors manual flags, so writers merged the new URL into the flagged file.
 * Flagging a file for its URL is really flagging the URL; the file identity
 * (outlet--critic) outlives the URL.
 *
 * Rule: a field is cleared only when its post-merge value is IDENTICAL to the
 * existing on-disk value — i.e. it provably rode along from the old-URL record.
 * A fresh value supplied by the incoming write always survives.
 *
 * Manual-clear fields (wrongShowManualClear, wrongProductionManualClear,
 * humanReview*, allow*) are never touched — a manual clear stays valid across
 * URL changes. A manual wrongShowReason, by contrast, means the OLD url was
 * wrong; a different-URL write is exactly the recovery case, so it clears.
 *
 * Date-based wrongProduction flags ('Pre-opening guard', 'Date guard',
 * 'Dateless show', 'Tour transfer') are preserved: they key on publishDate,
 * not URL, and the rebuild re-derives them each run — clearing here would just
 * oscillate with the rebuild (same carve-out as gather-reviews' replacement
 * branch).
 *
 * The clear is recorded in `_urlChangedClear` ({from, to, at, cleared}), which
 * review-write-guard.js protects and isIntentionalClear() honors, so the CI
 * push-restore machinery (push-review-texts/action.yml,
 * restore-protected-fields.js) does not resurrect the cleared fields from the
 * committed state on the next rebase.
 *
 * Called from the two write chokepoints:
 *   - safeWriteReview() (review-write-guard.js) — sweep-we-aggregators,
 *     review-file-writer (poller/ingest), collect-review-texts, etc.
 *   - mergeReviews() (review-normalization.js) — gather-reviews merge paths,
 *     which write raw fs.writeFileSync and never reach safeWriteReview.
 */

const { REPLACE_CLEAR_FIELDS } = require('./wrongprod-replacement-preserve');
const { EXCERPT_FIELDS } = require('./excerpt-fields');

// Everything derived from (or fetched via) the file's URL. REPLACE_CLEAR_FIELDS
// carries the wrong-flag / content-state / fetch-state families; the rest are
// the JCS gaps: aggregator excerpts+stars, LLM scores, and the old article's
// text + text metadata.
const URL_DERIVED_FIELDS = Array.from(new Set([
  ...REPLACE_CLEAR_FIELDS,
  ...EXCERPT_FIELDS,
  'aggregatorStars', 'aggregatorStarsSource',
  'llmScore', 'llmMetadata', 'ensembleData',
  'assignedScore', 'bucket', 'llmConfidence', 'scoreSource',
  'originalScore', 'originalScoreSource', 'originalScoreNormalized',
  'originalScoreType', 'originalRating',
  'fullText', 'textFetchedAt', 'textWordCount', 'textStatus', 'textQuality',
  'sourceMethod', 'isFullReview',
  'wrongFullText', 'wrongAttribution', 'showNotMentioned',
  'wrongProductionAutoCleared', 'wrongProductionAutoClearedAt',
  'urlPlaceholderSuspect',
  // Dedup pointers key on URL (duplicateOf) or on fullText fingerprint
  // (duplicateTextOf) — both are old-URL-derived. duplicateClearReason is set
  // alongside so the push-restore exception breadcrumb machinery honors it.
  'duplicateOf', 'duplicateReason', 'duplicateTextOf',
]));

// wrongProductionNote prefixes that mark DATE-based flags — independent of the
// URL, re-derived by the rebuild each run. Keep them (and their reason/note)
// across URL changes. Mirrors gather-reviews.js existingIsDateBasedWrongProd.
const DATE_BASED_WP_PREFIXES = [
  'Pre-opening guard', 'Date guard', 'Dateless show', 'Tour transfer',
];

const WP_FIELDS = new Set(['wrongProduction', 'wrongProductionNote', 'wrongProductionReason']);

function _isDateBasedWrongProduction(existing) {
  const note = existing && existing.wrongProductionNote;
  return typeof note === 'string'
    && DATE_BASED_WP_PREFIXES.some((p) => note.startsWith(p));
}

function _valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * True when the write moves the record to a different canonical URL.
 * Normalization-only differences (protocol, www, trailing slash, tracking
 * params, AMP suffix) are NOT a URL change.
 */
function urlCanonicallyChanged(existingUrl, newUrl) {
  if (!existingUrl || !newUrl) return false;
  if (typeof existingUrl !== 'string' || typeof newUrl !== 'string') return false;
  if (existingUrl.includes('undefined')) return false; // broken-URL repair, not a change
  // Lazy require — review-normalization lazy-requires this module back.
  const { normalizeUrl } = require('./review-normalization');
  return normalizeUrl(existingUrl) !== normalizeUrl(newUrl);
}

/**
 * Enforce the invariant on a post-merge record. Mutates `merged` in place.
 *
 * @param {object} existing - The on-disk record BEFORE the write
 * @param {object} merged - The record about to be written (already merged)
 * @param {object} [opts]
 * @param {string} [opts.fileLabel] - For log context
 * @returns {{ changed: boolean, cleared: string[] }}
 */
function applyUrlChangeInvariant(existing, merged, { fileLabel = '?' } = {}) {
  if (!existing || !merged) return { changed: false, cleared: [] };
  if (!urlCanonicallyChanged(existing.url, merged.url)) {
    return { changed: false, cleared: [] };
  }

  const preserveDateBasedWp = _isDateBasedWrongProduction(existing);
  const cleared = [];
  for (const field of URL_DERIVED_FIELDS) {
    if (merged[field] === undefined) continue;
    if (preserveDateBasedWp && WP_FIELDS.has(field)) continue;
    // Only clear values that provably came from the old-URL record; a fresh
    // value supplied by the incoming write differs and survives.
    if (!_valuesEqual(merged[field], existing[field])) continue;
    delete merged[field];
    cleared.push(field);
  }

  if (cleared.length === 0) return { changed: false, cleared };

  if (cleared.includes('duplicateOf') || cleared.includes('duplicateTextOf')) {
    merged.duplicateClearReason = `auto-cleared at write: url changed ${existing.url} → ${merged.url}`;
  }
  // The old article's text is gone (or was never valid for this URL) — signal
  // the collector to fetch the new URL. needsRefetch + urlCorrectedFrom is the
  // pair collect-review-texts.js reads to bypass wrong-content cooldowns.
  if (!merged.fullText) {
    merged.needsRefetch = true;
    if (!merged.urlCorrectedFrom) merged.urlCorrectedFrom = existing.url;
  }

  // Durable breadcrumb: protected in PROTECTED_FIELDS and honored by
  // isIntentionalClear(), so CI rebase-restores don't resurrect cleared fields.
  merged._urlChangedClear = {
    from: existing.url,
    to: merged.url,
    at: new Date().toISOString(),
    cleared,
  };

  console.warn(`[url-changed] ${fileLabel}: cleared old-URL-derived fields (${cleared.join(', ')}) — url ${existing.url} → ${merged.url}`);
  return { changed: true, cleared };
}

module.exports = {
  applyUrlChangeInvariant,
  urlCanonicallyChanged,
  URL_DERIVED_FIELDS,
  DATE_BASED_WP_PREFIXES,
};
