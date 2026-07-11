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
 * Manual 'Tour transfer' wrongProduction flags are preserved. The automatic
 * date guards ('Pre-opening guard' etc.) are NOT: they were computed from the
 * old article's publishDate, which this invariant also clears; the rebuild
 * re-derives them fresh from the new URL's date.
 *
 * The clear is recorded in `_urlChangedClear` ({from, to, at, cleared}), which
 * review-write-guard.js protects and isIntentionalClear() honors, so the CI
 * push-restore machinery (push-review-texts/action.yml,
 * restore-protected-fields.js) does not resurrect the cleared fields from the
 * committed state on the next rebase.
 *
 * Called from the three write chokepoints:
 *   - safeWriteReview() (review-write-guard.js) — sweep-we-aggregators,
 *     review-file-writer (poller/ingest), collect-review-texts, etc.
 *   - mergeReviews() (review-normalization.js) — gather-reviews merge paths,
 *     which write raw fs.writeFileSync and never reach safeWriteReview.
 *   - gather-reviews.js wrongShow/wrongProd URL-replacement branch (~3320) —
 *     builds a fresh `replacement` record, so its clears happen by OMISSION;
 *     the invariant records those in the breadcrumb (see below) so the CI
 *     push-restore doesn't resurrect them.
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
  'wrongFullText', 'wrongAttribution', 'wrongArticle', 'showNotMentioned',
  'isRoundupArticle', 'isCombinedReview',
  'wrongProductionAutoCleared', 'wrongProductionAutoClearedAt',
  'urlPlaceholderSuspect',
  // The old ARTICLE's publish date. Leaving it makes the fix defeat itself:
  // the rebuild's date guards re-flag the cleared file from the stale date,
  // and the Tour-transfer carve-out below would then preserve that flag across
  // any later correction. Cleared here (when carried over), re-derived by
  // collect-review-texts from the new URL's page.
  'publishDate', 'publishDateVerified', 'publishDateSource',
  // Dedup pointers key on URL (duplicateOf) or on fullText fingerprint
  // (duplicateTextOf) — both are old-URL-derived. duplicateClearReason is set
  // alongside so the push-restore exception breadcrumb machinery honors it.
  'duplicateOf', 'duplicateReason', 'duplicateTextOf',
]));

// wrongProductionNote prefixes preserved across URL changes. The MANUAL
// 'Tour transfer' family ALWAYS survives. The automatic date guards survive
// only while their publishDate basis survives (see applyUrlChangeInvariant):
// clearing a date guard while a publishDate remains on the record creates an
// early-dated-but-unflagged state that reds the validate-data
// [wrong-production-by-date] CI gate until the next rebuild re-derives the
// flag (observed pre-existing on care-west-end-2026, 2026-07-11). When the
// date clears too, the state is consistent (dateless + unflagged) and the
// rebuild re-derives everything from the new URL's real date.
const MANUAL_WP_PREFIXES = ['Tour transfer'];
const AUTO_DATE_WP_PREFIXES = ['Pre-opening guard', 'Date guard', 'Dateless show'];
// Kept for external references/tests: prefixes that can survive a URL change.
const DATE_BASED_WP_PREFIXES = [...MANUAL_WP_PREFIXES, ...AUTO_DATE_WP_PREFIXES];

const WP_FIELDS = new Set(['wrongProduction', 'wrongProductionNote', 'wrongProductionReason']);

function _noteStartsWith(existing, prefixes) {
  const note = existing && existing.wrongProductionNote;
  return typeof note === 'string' && prefixes.some((p) => note.startsWith(p));
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

// Format-insensitive publishDate equality ('2023-10-12' vs 'October 12, 2023'
// are the SAME carried-over date — string deep-equal would treat the re-format
// as a fresh value and keep the stale date under the new URL).
function _publishDayKey(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return null;
  // Verbose dates parse as LOCAL midnight; shifting +12h before taking the
  // UTC day lands inside the intended calendar day for any offset within ±12h.
  return new Date(ms + 12 * 3600 * 1000).toISOString().slice(0, 10);
}

function _publishDatesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = _publishDayKey(a);
  const kb = _publishDayKey(b);
  return !!ka && !!kb && ka === kb;
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
  // A garbage INCOMING url must never trigger a full state wipe — only a real,
  // fetchable replacement article counts as a URL change.
  if (newUrl.includes('undefined') || !/^https?:\/\//i.test(newUrl)) return false;
  // Lazy require — review-normalization lazy-requires this module back.
  const { normalizeUrl } = require('./review-normalization');
  return normalizeUrl(existingUrl) !== normalizeUrl(newUrl);
}

/**
 * Enforce the invariant on a post-merge record. Mutates `merged` in place.
 *
 * CONTRACT: `merged` must be the COMPLETE record that will be written to disk
 * (fully merged, or a fully-materialized replacement) — never a sparse patch.
 * Omission-recording treats any URL-derived field absent from `merged` but
 * present on `existing` as an intentional clear and breadcrumbs it, which
 * would suppress legitimate restores if `merged` were a partial record.
 *
 * @param {object} existing - The on-disk record BEFORE the write
 * @param {object} merged - The record about to be written (already merged)
 * @param {object} [opts]
 * @param {string} [opts.fileLabel] - For log context
 * @param {Set<string>} [opts.preserveFields] - Fields exempt from clearing.
 *   Used by gather-reviews' replacement branch to honor its aggregator-signal
 *   contract (computeReplacementPreserve AGGREGATOR_FIELDS: show-keyed roundup
 *   data, independent of the file's URL).
 * @returns {{ changed: boolean, cleared: string[] }}
 */
function applyUrlChangeInvariant(existing, merged, { fileLabel = '?', preserveFields = null } = {}) {
  if (!existing || !merged) return { changed: false, cleared: [] };
  if (!urlCanonicallyChanged(existing.url, merged.url)) {
    return { changed: false, cleared: [] };
  }

  // Decide the publishDate's fate FIRST — the automatic date-guard flags are
  // coupled to it. A date clears when it's carried over from the old record
  // (format-insensitive: an aggregator re-supplying 'October 12, 2023' for a
  // stored '2023-10-12' is the same stale date) or dropped by omission.
  const publishDateWillClear = merged.publishDate === undefined
    ? existing.publishDate !== undefined
    : _publishDatesEqual(merged.publishDate, existing.publishDate);
  // Preserve WP fields for: manual 'Tour transfer' flags (always), and
  // automatic date guards whose publishDate basis SURVIVES (a genuinely new
  // date arrived) — the rebuild re-evaluates the guard against that date and
  // auto-clears it if in-window. Clearing the flag while a date remains would
  // red the validate-data [wrong-production-by-date] gate until the rebuild.
  const preserveDateBasedWp = _noteStartsWith(existing, MANUAL_WP_PREFIXES)
    || (_noteStartsWith(existing, AUTO_DATE_WP_PREFIXES) && !publishDateWillClear);
  const cleared = [];
  for (const field of URL_DERIVED_FIELDS) {
    if (preserveFields && preserveFields.has(field)) continue;
    if (preserveDateBasedWp && WP_FIELDS.has(field)) continue;
    if (field === 'publishDate') {
      if (!publishDateWillClear) continue;
      if (merged.publishDate !== undefined) {
        delete merged.publishDate;
        cleared.push('publishDate');
      } else if (existing.publishDate !== undefined) {
        cleared.push('publishDate'); // omission
      }
      continue;
    }
    if (merged[field] === undefined) {
      // Cleared BY OMISSION: the old record had this URL-derived field and the
      // replacement-style write dropped it. Nothing to delete, but it must go
      // in the breadcrumb — otherwise the push-restore sees an emptied
      // PROTECTED field with no intentional-clear signal and resurrects the
      // committed value (exactly the JCS resurrection failure mode).
      if (existing[field] !== undefined) cleared.push(field);
      continue;
    }
    // Only clear values that provably came from the old-URL record; a fresh
    // value supplied by the incoming write differs and survives.
    if (!_valuesEqual(merged[field], existing[field])) continue;
    delete merged[field];
    cleared.push(field);
  }

  // Chain-carry a prior breadcrumb: across A→B→C hops, hop 2's own clear list
  // may be empty (everything already cleared at hop 1) — but the era gate in
  // isIntentionalClear keys on breadcrumb.to, so a stale {to: B} breadcrumb
  // stops being honored once the file is at url C and the push-restore would
  // resurrect hop 1's fields. Carry the prior cleared[] into the new era when
  // the prior breadcrumb chains (prior.to == the url we're moving away from).
  let priorCleared = [];
  // Read the prior breadcrumb from `merged` OR `existing`: gather-reviews'
  // replacement branch builds a fresh record that never carries the old
  // _urlChangedClear forward, and hop-1's cleared fields are absent from BOTH
  // sides there (so omission-recording can't see them either) — only the
  // existing record's breadcrumb preserves the chain (ship-check 2026-07-11).
  const prior = merged._urlChangedClear || existing._urlChangedClear;
  if (prior && Array.isArray(prior.cleared) && prior.to) {
    try {
      const { normalizeUrl } = require('./review-normalization');
      if (normalizeUrl(String(prior.to)) === normalizeUrl(existing.url)) {
        priorCleared = prior.cleared;
      }
    } catch { /* unparseable prior — drop it */ }
  }
  const allCleared = Array.from(new Set([...priorCleared, ...cleared]));
  if (allCleared.length === 0) return { changed: false, cleared };

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
    cleared: allCleared,
  };

  if (cleared.length > 0) {
    console.warn(`[url-changed] ${fileLabel}: cleared old-URL-derived fields (${cleared.join(', ')}) — url ${existing.url} → ${merged.url}`);
  }
  return { changed: true, cleared };
}

module.exports = {
  applyUrlChangeInvariant,
  urlCanonicallyChanged,
  URL_DERIVED_FIELDS,
  DATE_BASED_WP_PREFIXES,
};
