/**
 * Review Write Guard
 *
 * Prevents accidental destruction of scored/collected review data.
 * Any script that writes review JSON files should use safeWriteReview()
 * instead of raw fs.writeFileSync().
 *
 * Protected fields: assignedScore, llmScore, fullText, contentTier,
 * contentVerification, ensembleData, llmMetadata.
 *
 * Rules:
 * - If an existing file has a scored field and the new data doesn't,
 *   the scored field is preserved from the existing file.
 * - Set force=true to bypass (for intentional score clearing like rescoring).
 *
 * Used by:
 * - scripts/sweep-we-aggregators.js
 * - scripts/lib/review-file-writer.js (createOrMergeReviewFile, writeManualReview)
 * - scripts/ingest-manual-review.js (via review-file-writer)
 * - Any future script that writes to data/review-texts/
 *
 * NOT used by (bespoke preservation, keep in sync with PROTECTED_FIELDS):
 * - scripts/gather-reviews.js URL-replacement path (line ~3101). Imports
 *   PROTECTED_FIELDS and intersects with REPLACE_CLEAR_FIELDS to derive its
 *   own preserve list. If you add a field here that should be cleared on
 *   URL replacement, also add it to REPLACE_CLEAR_FIELDS there.
 * - scripts/collect-review-texts.js terminal-state gate updates (intentional
 *   narrow patches that don't touch PROTECTED_FIELDS; see Notion P1 card).
 */

const fs = require('fs');
const path = require('path');
const { parseRating } = require('./score-conversion-rules');

// Fields that represent collected/scored data and must not be silently erased.
// KEEP IN SYNC with .github/actions/push-review-texts/action.yml PROTECTED array.
const PROTECTED_FIELDS = [
  'assignedScore',
  'humanReviewScore',
  'adjudicatedScore',
  'adjudicationNote',
  'manualContentTier',
  'originalScore',
  'originalScoreSource',
  'originalScoreNormalized',
  'llmScore',
  'llmMetadata',
  'fullText',
  'contentTier',
  'contentTierReason',
  'contentVerification',
  'ensembleData',
  'tierReason',
  'showTitle',
  'textFetchedAt',
  'textWordCount',
  'textStatus',
  'sourceMethod',
  'isFullReview',
  'wrongFullText',
  'wrongShow',
  'wrongShowReason',
  'wrongProduction',
  'wrongProductionNote',
  'originalScoreCleared',
  'originalScoreClearedReason',
  'previousOriginalScore',
  'humanReviewNote',
  'humanReviewedWrongProduction',
  'humanReviewedWrongArticle',
  'wrongProductionManualClear',
  'wrongArticleManualClear',
  'wrongShowManualClear',
  'wrongProductionOverride',
  'wrongShowOverride',
  'wrongShowNote',
  'wrongShowAutoCleared',
  'wrongProductionAutoCleared',
  'wrongProductionAutoClearedAt',
  'wrongProductionReason',
  'wrongAttribution',
  'manualContentTier',
  'designation',
  'isCriticsPick',
  'duplicateOf',
  'duplicateReason',
  'publishDateVerified',
  'publishDateSource',
  // Opening-night manual-ingest overrides — rebuild guards read these to bypass
  // date, market, tour, film, and routing flags. Missing from this list means
  // a CI push that rebases our commits silently drops them and the review
  // gets re-flagged on the next rebuild. See Beaches 2026-04-22 postmortem.
  'allowEarlyDate',
  'allowLateDate',
  'allowCrossMarket',
  'allowTourSignal',
  'allowFilmSignal',
  'routedFromShowId',
  'urlVerified',
  'urlManualOverride',
  'urlManualOverrideNote',
  // SERP retry state — set by collect-review-texts.js + gather-reviews.js lifecycle guard.
  // Losing these on rebase causes the cooldown to reset, which means a single
  // rebase can re-trigger 13K stuck wrong_content files. See sprint-plan-serp-cost-reduction.md S1-T1.
  // NOTE: serpRetryCount/serpDiscoveryAbandoned are intentionally excluded — clearFailureFlags()
  // clears them on success. serpRetryAfter is still protected (controls backoff timing).
  'serpRetryAfter',
  'wrongShowRetryAt', // existing bug fix — was silently droppable on rebase
  // Bug #10: manually-set pull quotes must survive rebuilds and LLM overrides.
  'pullQuote',
  // Per-file protection array — unions with this global list in
  // getEffectiveProtectedFields(). Must self-protect so ingest-manual-review's
  // per-record locks can't be cleared by a rebase.
  'protectedFields',
  // NOTE: incompleteReason + incompleteDetail are intentionally NOT in this list.
  // They are derived fields that rebuild re-classifies every run. Having them here
  // caused stale 'wrong_content' flags to be preserved even after collect-review-texts.js
  // fetched correct content — blocking valid reviews from reviews.json.
  // clearFailureFlags() clears them explicitly on success paths. (Pattern Card #1,
  // Notion 346637c5-416f-8154-9500-f09fd49e5a2a, 2026-04-17)
];

/**
 * Safely write a review JSON file, preserving any existing scored/collected data.
 *
 * @param {string} filePath - Absolute path to the review JSON file
 * @param {object} newData - The data to write
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Skip protection (for intentional overwrites like rescoring)
 * @param {boolean} [options.merge=true] - If true, merge with existing; if false, replace (still protected)
 * @returns {{ wrote: boolean, preserved: string[] }} Which protected fields were preserved
 */
function safeWriteReview(filePath, newData, options = {}) {
  const { force = false, merge = true } = options;
  const preserved = [];

  // Bug #25: When force=true, log protected fields that would be lost so CI logs show it.
  if (force && fs.existsSync(filePath)) {
    let existingForAudit;
    try { existingForAudit = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
    if (existingForAudit) {
      const effectiveFields = getEffectiveProtectedFields(existingForAudit);
      const overriding = effectiveFields.filter(k => {
        const existingVal = existingForAudit[k];
        const newVal = newData[k];
        const existingIsReal = existingVal !== undefined && existingVal !== null
          && !(typeof existingVal === 'string' && existingVal.length === 0)
          && !(Array.isArray(existingVal) && existingVal.length === 0);
        const incomingIsEmpty = newVal === undefined || newVal === null
          || (typeof newVal === 'string' && newVal.length === 0)
          || (Array.isArray(newVal) && newVal.length === 0);
        return existingIsReal && incomingIsEmpty;
      });
      if (overriding.length > 0) {
        console.warn(`[review-write-guard] FORCE write to ${path.basename(filePath)} — overriding: ${overriding.join(', ')}`);
      }
    }
  }

  if (!force && fs.existsSync(filePath)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      existing = null;
    }

    if (existing) {
      const effectiveFields = getEffectiveProtectedFields(existing);
      for (const field of effectiveFields) {
        const existingVal = existing[field];
        const newVal = newData[field];
        // Preserve existing non-empty when incoming is any form of empty.
        // Previously only undefined/null were treated as empty — the poller
        // writes stubs with fullText='' (empty string) which passed the
        // check and CLOBBERED scored reviews. See 2026-04-17 Proof opening
        // P0 incident (card 345637c5-416f-81df).
        const existingIsReal = existingVal !== undefined && existingVal !== null
          && !(typeof existingVal === 'string' && existingVal.length === 0)
          && !(Array.isArray(existingVal) && existingVal.length === 0);
        const incomingIsEmpty = newVal === undefined || newVal === null
          || (typeof newVal === 'string' && newVal.length === 0)
          || (Array.isArray(newVal) && newVal.length === 0);
        if (existingIsReal && incomingIsEmpty) {
          newData[field] = existingVal;
          preserved.push(field);
        }
      }

      // If merge mode, also keep any existing fields not in newData
      if (merge) {
        for (const [key, val] of Object.entries(existing)) {
          if (newData[key] === undefined) {
            newData[key] = val;
          }
        }
      }
    }
  }

  // Pattern Card #7: schema validation — originalScore must be a string, not a bare integer.
  // A bare number like 5 is ambiguous (5/100 or 5 stars?). The canonical form is always a
  // string ("5/5", "★★★★★", "5 stars"). Log a warning but don't block the write.
  if (newData.originalScore != null && typeof newData.originalScore === 'number') {
    const caller = new Error().stack.split('\n')[2]?.trim() || 'unknown';
    console.warn(`[review-write-guard] originalScore is a number (${newData.originalScore}) in ${path.basename(filePath)} — should be a string. Caller: ${caller}`);
  }

  // Schmigadoon 2026 bug #6 guard: assignedScore must be null or a finite number.
  // Schema drift shipped "2/4 stars" (string) to reviews.json because some ingest
  // path wrote the raw rating string into the numeric slot. Coerce known rating
  // patterns via the shared parseRating() helper; null + log anything unparseable.
  const coercion = coerceAssignedScore(newData, filePath);
  if (coercion.changed) {
    console.warn(`[review-write-guard] assignedScore coerced in ${path.basename(filePath)}: ${JSON.stringify(coercion.from)} → ${coercion.to} (${coercion.reason})`);
  }

  // Pattern Card #4: URL collision detection — warn before writing a file whose URL
  // already exists in another file in the same show directory.
  if (!force && newData.url) {
    const collider = checkUrlCollision(filePath, newData);
    if (collider) {
      console.warn(`[review-write-guard] URL collision: ${path.basename(filePath)} shares URL with ${collider} — marking as duplicate`);
      newData.duplicateOf = collider;
      newData.duplicateReason = 'url-collision-detected-at-write';
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(newData, null, 2) + '\n');
  return { wrote: true, preserved };
}

/**
 * Check if writing newData would destroy scored data in an existing file.
 * Returns list of fields that would be lost. Empty array = safe to write.
 *
 * @param {string} filePath - Path to existing review file
 * @param {object} newData - Proposed new data
 * @returns {string[]} Fields that would be lost
 */
function checkForDataLoss(filePath, newData) {
  if (!fs.existsSync(filePath)) return [];
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }

  const effectiveFields = getEffectiveProtectedFields(existing);
  const losses = [];
  for (const field of effectiveFields) {
    if (existing[field] !== undefined && existing[field] !== null && (newData[field] === undefined || newData[field] === null)) {
      losses.push(field);
    }
  }
  return losses;
}

/**
 * Returns the effective set of protected fields for a given existing file's data.
 * Unions the global PROTECTED_FIELDS with any per-file protectedFields array.
 * 'protectedFields' itself is always included so it can't be cleared unless force=true.
 *
 * @param {object|null} existingData - Parsed JSON from the existing file (or null)
 * @returns {string[]}
 */
function getEffectiveProtectedFields(existingData) {
  const perFile = (existingData && Array.isArray(existingData.protectedFields))
    ? existingData.protectedFields
    : [];
  const all = new Set([...PROTECTED_FIELDS, ...perFile, 'protectedFields']);
  return Array.from(all);
}

/**
 * Check if the URL in newData is already used by a different review file in
 * the same show directory. Returns the conflicting filename, or null if no collision.
 *
 * Pattern Card #6: URL collisions cause duplicate content when two passes of
 * gather-reviews assign the same URL to different filenames for the same show.
 * Call this before safeWriteReview when creating new files to detect the issue
 * early rather than letting it propagate to reviews.json.
 *
 * @param {string} filePath - The file being written (used to determine show directory)
 * @param {object} newData - The data to write (must have a .url field to be checked)
 * @returns {string|null} Conflicting filename (basename only), or null if no collision
 */
function checkUrlCollision(filePath, newData) {
  if (!newData || !newData.url || typeof newData.url !== 'string') return null;
  const dir = path.dirname(filePath);
  const thisFile = path.basename(filePath);
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json' && f !== thisFile);
  } catch {
    return null;
  }
  const normNew = _normalizeUrlForCollision(newData.url);
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (data.url && typeof data.url === 'string' && _normalizeUrlForCollision(data.url) === normNew) {
        return f;
      }
    } catch { /* skip unreadable */ }
  }
  return null;
}

/** Normalize a URL for collision comparison: lowercase domain, strip trailing slash and utm_* params. */
function _normalizeUrlForCollision(url) {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_|^fbclid/.test(key)) u.searchParams.delete(key);
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

/**
 * Coerce a non-numeric assignedScore into a number, or null it if unparseable.
 *
 * Schmigadoon 2026 shipped the NY Post review with assignedScore="2/4 stars"
 * (string) because schema drift let a raw rating string land in the numeric
 * slot. validate-data.js catches this post-rebuild, but the gate is too late —
 * the bad value had already gone to subscribers. Block it at write time.
 *
 * Recognized patterns (via shared parseRating()): "N/N stars", "N stars",
 * "B+" / letter grades, sentiment words, bare numeric strings. Anything else
 * becomes null + flag, and the caller's stderr shows the coercion.
 *
 * @param {object} data The review-text JSON object (mutated in place).
 * @param {string} [filePath] Optional, only used for log context.
 * @returns {{ changed: boolean, from?: any, to: number|null, reason?: string }}
 */
function coerceAssignedScore(data, filePath) {
  const val = data.assignedScore;
  // Already the right shape (null, undefined, or finite number) — no-op.
  if (val === null || val === undefined) return { changed: false, to: val ?? null };
  if (typeof val === 'number' && Number.isFinite(val)) return { changed: false, to: val };

  const original = val;

  // First preference: originalScoreNormalized is the authoritative 0-100 form
  // that setExtractedScore() already wrote from the extractor's normalizedScore.
  // If it's present and sane, trust it.
  if (
    typeof data.originalScoreNormalized === 'number' &&
    Number.isFinite(data.originalScoreNormalized) &&
    data.originalScoreNormalized >= 0 &&
    data.originalScoreNormalized <= 100
  ) {
    data.assignedScore = data.originalScoreNormalized;
    data._assignedScoreCoercedFrom = original;
    data._assignedScoreCoercedAt = new Date().toISOString();
    return {
      changed: true,
      from: original,
      to: data.originalScoreNormalized,
      reason: 'from-originalScoreNormalized',
    };
  }

  // Second preference: string form that parseRating() understands (stars, grades, etc.).
  if (typeof val === 'string') {
    const parsed = parseRating(val);
    if (
      parsed &&
      !parsed.unparseable &&
      typeof parsed.expected === 'number' &&
      Number.isFinite(parsed.expected)
    ) {
      data.assignedScore = parsed.expected;
      data._assignedScoreCoercedFrom = original;
      data._assignedScoreCoercedAt = new Date().toISOString();
      return {
        changed: true,
        from: original,
        to: parsed.expected,
        reason: `parsed-as-${parsed.type}`,
      };
    }
  }

  // Unrecoverable: null the score and flag for human review so the bad value
  // can't propagate to reviews.json. Rebuild will skip this review.
  data.assignedScore = null;
  data._assignedScoreCoercionFailed = true;
  data._assignedScoreCoercedFrom = original;
  data._assignedScoreCoercedAt = new Date().toISOString();
  data.needsReview = true;
  return { changed: true, from: original, to: null, reason: 'unparseable' };
}

module.exports = { safeWriteReview, checkForDataLoss, getEffectiveProtectedFields, checkUrlCollision, coerceAssignedScore, PROTECTED_FIELDS };
