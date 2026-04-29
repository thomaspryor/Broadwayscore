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
const { validateTemporalAttribution } = require('./temporal-byline-guard');

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
  'allowTourSignalReason',
  'allowFilmSignal',
  'routedFromShowId',
  'urlVerified',
  'urlManualOverride',
  'urlManualOverrideNote',
  // Additional override flags added in Rocky Horror 2026-04-23 postmortem (Session 2 #7):
  // losing any of these on rebase silently re-flags a manually-verified review.
  'humanReviewedTour',
  'humanReviewScoreProvisional',
  'humanReviewScoreClearedForLlm',
  'isTourReview',
  'isLikelyTourReview',
  // Aggregator thumb signals used by P2 thumb-validated-LLM path in getBestScore.
  // Losing these drops low-conf LLM reviews that would otherwise ship.
  'dtliThumb',
  'bwwThumb',
  // SERP retry state — set by collect-review-texts.js + gather-reviews.js lifecycle guard.
  // Losing these on rebase causes the cooldown to reset, which means a single
  // rebase can re-trigger 13K stuck wrong_content files. See sprint-plan-serp-cost-reduction.md S1-T1.
  // NOTE: serpRetryCount/serpDiscoveryAbandoned are intentionally excluded — clearFailureFlags()
  // clears them on success. serpRetryAfter is still protected (controls backoff timing).
  'serpRetryAfter',
  'wrongShowRetryAt', // existing bug fix — was silently droppable on rebase
  // Bug #10: manually-set pull quotes must survive rebuilds and LLM overrides.
  'pullQuote',
  // Lock audit-trail metadata (Lost Boys 2026-04-27 Gap #6). Set by
  // /api/admin/lock-score; surfaced on /admin/locks. Without explicit
  // protection, a rebase + rebuild round-trip would silently strip the
  // rationale + actor + timestamp, making the audit trail useless.
  'lockedReason',
  'lockedAt',
  'lockedBy',
  'lockedAcrossTier',
  'priorScoreAtLock',
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
  let lockedSkipped = false;

  // Temporal byline guard — refuse to write attributions to retired/deceased
  // critics for articles dated past their last-active date.
  // (Soft warnings — like Brantley freelance pieces — pass through with a log.)
  if (newData && newData.criticName && (newData.publishDate || newData.parsedDate)) {
    const tcheck = validateTemporalAttribution(newData.criticName, newData.publishDate || newData.parsedDate);
    if (tcheck.warning) {
      console.warn(`[temporal-byline-guard] ${path.basename(filePath)}: ${tcheck.warning}`);
    }
    if (tcheck.hardBlock) {
      console.error(`[temporal-byline-guard] BLOCKED write to ${path.basename(filePath)}: ${tcheck.reason}`);
      // Downgrade attribution to Unknown so the review still lands but doesn't
      // pollute the dead/retired critic's page. Log so a human can fix later.
      newData = { ...newData, criticName: 'Unknown', _temporalGuardBlocked: tcheck.reason };
    }
  }

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
      // Joe Turner postmortem P0 #2 (2026-04-26): _locked must be honored
      // at the writer, not in each enrichment script. existing was just read
      // fresh from disk above, so a parallel writer's _locked flag is visible
      // to us. force=true still bypasses (intentional override path —
      // strip-stale-single-model-scores --force-strip-locked, etc.).
      const lockedOverride = existing._locked === true && !force;

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
        // Locked override: preserve every PROTECTED field on a locked file
        // even when incoming has a real value. The lock means the human or
        // ingest pipeline declared the file canonical; nothing downstream
        // should mutate scored/collected fields without force=true.
        if (existingIsReal && (incomingIsEmpty || lockedOverride)) {
          if (newData[field] !== existingVal) {
            newData[field] = existingVal;
            preserved.push(field);
            if (lockedOverride && !incomingIsEmpty) lockedSkipped = true;
          }
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

  // Pattern Card #8: Placeholder URL detection — flag fabricated/stub URLs that
  // contain sequential-digit placeholder patterns (e.g. Joe Turner WSJ fake ID
  // SB123944876543210987 found in 2026-04-26 catalog audit, 8 similar files).
  // FLAG-ONLY — does not block the write because the false-positive rate on real
  // URLs is not yet characterised. Downstream auditors can filter urlPlaceholderSuspect=true.
  if (newData.url && hasPlaceholderUrlPattern(newData.url)) {
    newData.urlPlaceholderSuspect = true;
    console.warn(`[review-write-guard] placeholder URL detected in ${path.basename(filePath)}: ${newData.url}`);
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
  return { wrote: true, preserved, lockedSkipped };
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

// Normalize a URL for collision comparison.
//
// Delegates to review-normalization.normalizeUrl (the project's canonical
// URL-comparison primitive), which handles protocol/www/trailing-slash
// stripping, fragment removal, AMP-suffix strip (added 2026-04-28), and
// the shared tracking-param allowlist (utm_, ref, source, fbclid, etc.).
// Inlining a second normalizer here was the design problem flagged in
// tonight's plan-review — two normalizers drift over time. Single source
// of truth: review-normalization.normalizeUrl.
function _normalizeUrlForCollision(url) {
  // Lazy require to avoid circular dep at module load.
  const { normalizeUrl } = require('./review-normalization');
  return normalizeUrl(url);
}

/**
 * Check whether a URL contains a sequential-digit placeholder pattern that
 * suggests it was fabricated rather than copied from a live page.
 *
 * Motivation: Joe Turner 2009 catalog audit (2026-04-26) found
 * https://www.wsj.com/articles/SB123944876543210987 — a WSJ legacy-ID URL
 * containing both ascending (1239…) and a long descending run (876543210).
 * Eight similar files were identified in the catalog. This function provides
 * a write-time detector so urlPlaceholderSuspect=true is set before the file
 * lands on disk, without blocking the write (false-positive rate unknown).
 *
 * Pattern coverage:
 *  1. WSJ legacy IDs where the SB-prefixed numeric portion contains a
 *     4-digit ascending sequential run (SB1234…, SB2345…, …, SB0123…) OR
 *     a 4-digit descending run (SB9876…, SB8765…, …, SB1098…).
 *     The real test URL SB123944876543210987 matches via descending 9876 run
 *     embedded in the digits (…4876…).
 *  2. Any URL path containing 7+ strictly ascending sequential digits
 *     (1234567 … 1234567890) — common stub tail pattern.
 *  3. Any URL path containing 7+ strictly descending sequential digits
 *     (9876543 … 9876543210) — the Joe Turner WSJ ID contains 876543210.
 *  4. Path that ENDS in any of the above sequences (stub tail).
 *
 * @param {string} url
 * @returns {boolean} true if the URL looks like a placeholder
 */
function hasPlaceholderUrlPattern(url) {
  if (!url || typeof url !== 'string') return false;

  // Pattern 1a: WSJ-style SB-prefixed IDs with a 4-digit ascending sequential run.
  // Matches embedded SB1234…, SB2345…, SB3456…, SB4567…, SB5678…, SB6789…, SB7890…, SB0123…
  const WSJ_ASCENDING = /wsj\.com\/articles\/SB\d{0,8}(?:1234|2345|3456|4567|5678|6789|7890|0123)/i;

  // Pattern 1b: WSJ-style SB-prefixed IDs with a 4-digit DESCENDING sequential run.
  // The Joe Turner fake ID SB123944876543210987 contains "4876" which embeds a
  // descending 4-digit sequence (4→3→2→1 is not matching, but the broader
  // string contains "9876" within "44876"). Capture it via any descending 4-run.
  // Also covers: SB9876…, SB8765…, SB7654…, SB6543…, SB5432…, SB4321…, SB3210…, SB2109…, SB1098…
  const WSJ_DESCENDING = /wsj\.com\/articles\/SB\d{0,8}(?:9876|8765|7654|6543|5432|4321|3210|2109|1098)/i;

  // Pattern 2: Any URL containing 7+ strictly ascending sequential digits.
  // Covers: 1234567, 12345678, 123456789, 1234567890 in any path position.
  const ASCENDING_LONG = /(?:SB)?\d{0,4}(?:1234567|12345678|123456789|1234567890)/i;

  // Pattern 3: Any URL containing 7+ strictly descending sequential digits.
  // The Joe Turner WSJ URL contains 876543210 (9-digit descending run).
  // Covers: 9876543, 87654321, 876543210, 9876543210.
  const DESCENDING_LONG = /(?:9876543(?:210?)?|87654321(?:0)?|76543210|65432109)/i;

  // Pattern 4: Path ending in a sequential run (stub tail pattern).
  const PATH_ASCENDING_TAIL = /\/(?:SB)?\d{0,4}(?:1234567|12345678|123456789|1234567890)\/?(?:[?#].*)?$/i;

  return (
    WSJ_ASCENDING.test(url) ||
    WSJ_DESCENDING.test(url) ||
    ASCENDING_LONG.test(url) ||
    DESCENDING_LONG.test(url) ||
    PATH_ASCENDING_TAIL.test(url)
  );
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

/**
 * Decide whether a poller text-update should be skipped to protect existing data.
 *
 * Joe Turner postmortem A #1, A #16 (2026-04-26): collect-review-texts.js was
 * writing fullText:'' on top of existing non-empty content when its scraper
 * tier returned nothing. The push-action patch (commit 6c34f1ebf7) caught it
 * at push time, but the right place is at the source. This predicate is the
 * source-side gate.
 *
 * Returns { skip, reason } so callers can log a meaningful breadcrumb.
 *
 * @param {object} existingData - Parsed JSON of the existing review file
 * @param {string|null|undefined} newText - The freshly-fetched fullText
 * @returns {{ skip: boolean, reason: string|null }}
 */
/**
 * Decide whether an enrichment script should skip a locked file entirely.
 *
 * Joe Turner postmortem P0 #2 (2026-04-26): safeWriteReview's lockedOverride
 * only protects PROTECTED_FIELDS. Enrichment scripts that mutate
 * NON-PROTECTED fields on locked files (criticName backfill, isSyndicatedDuplicate
 * detection, outletId re-aliasing) need an explicit early-return — the writer
 * guard alone does not save them.
 *
 * Returns { skip, reason } so callers can log a meaningful breadcrumb.
 *
 * @param {object|null|undefined} existingData - Parsed JSON of the existing review file
 * @returns {{ skip: boolean, reason: string|null }}
 */
function shouldSkipLockedEnrichment(existingData) {
  if (!existingData || typeof existingData !== 'object') {
    return { skip: false, reason: null };
  }
  if (existingData._locked === true) {
    return { skip: true, reason: '_locked=true' };
  }
  return { skip: false, reason: null };
}

function shouldSkipPollerUpdate(existingData, newText) {
  const existingTextLen = (existingData && typeof existingData.fullText === 'string')
    ? existingData.fullText.trim().length
    : 0;
  const newTextLen = (typeof newText === 'string') ? newText.trim().length : 0;

  if (existingData && existingData._locked === true && existingTextLen > 0) {
    return { skip: true, reason: `_locked=true with ${existingTextLen}ch existing fullText` };
  }
  if (existingData && existingData.manualContentTier === 'complete' && existingTextLen > 0) {
    return { skip: true, reason: `manualContentTier=complete with ${existingTextLen}ch existing fullText` };
  }
  if (newTextLen === 0 && existingTextLen > 0) {
    return { skip: true, reason: `new text empty; existing fullText is ${existingTextLen}ch` };
  }
  return { skip: false, reason: null };
}

/**
 * Move/rename a review-text file under the lock contract.
 *
 * Refuses to move when the SOURCE is `_locked: true` unless `force: true` is
 * passed. This is the topology-side counterpart to safeWriteReview's
 * lockedOverride: the field-level guard cannot stop a rename, an unlink, or
 * a cross-show MOVE — those operations bypass the writer entirely. This
 * helper closes the gap.
 *
 * Conflict semantics: if `dstPath` already exists, the helper returns
 * `{ skipped: 'conflict', conflictPath }` and DOES NOT touch either file.
 * The caller decides what to do (set data.duplicateOf, flag wrongProduction,
 * etc.). This explicit non-merge eliminates the PR #290 corruption surface
 * where merging into existing dest was silently undone by a downstream
 * write to the original (source) path.
 *
 * Sister-store side effects on a successful rename:
 * 1. data/llm-scores/{srcShow}/{srcFile}.json → {dstShow}/{dstFile}.json
 *    (renamed if present; conflict at sister store is logged + source unlinked).
 * 2. Same-show duplicateTextOf pointers in sibling files referencing the old
 *    basename are rewritten to the new basename. Cross-show pointers become
 *    orphaned (validate-review-texts catches them as missing-target).
 *
 * @param {string} srcPath - Absolute path to the source file
 * @param {string} dstPath - Absolute path the file should land at
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Bypass the source `_locked` check
 * @param {object|null} [options.newData=null] - Optional updated content to
 *   write at dstPath. When omitted, the helper writes the source file's
 *   content verbatim. Pass updated data when migrating cross-show MOVEs that
 *   stamp `movedFrom`/`movedReason`/`showId` fields onto the moved file.
 * @returns {{
 *   wrote: boolean,
 *   renamed?: boolean,
 *   skipped?: 'source-missing'|'source-unreadable'|'locked'|'conflict'|'noop',
 *   conflictPath?: string,
 *   lockedSkipped?: boolean,
 *   sisterStoreMoved?: boolean,
 *   siblingPointersUpdated?: number,
 *   error?: string,
 * }}
 */
function safeRenameReview(srcPath, dstPath, options = {}) {
  const { force = false, newData = null } = options;

  if (!fs.existsSync(srcPath)) {
    return { wrote: false, skipped: 'source-missing' };
  }

  let srcData;
  try {
    srcData = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
  } catch (e) {
    return { wrote: false, skipped: 'source-unreadable', error: e.message };
  }

  if (srcData && srcData._locked === true && !force) {
    console.warn(`[review-write-guard] Refusing rename of locked file ${path.basename(srcPath)} → ${path.basename(dstPath)}`);
    return { wrote: false, skipped: 'locked', lockedSkipped: true };
  }

  if (path.resolve(srcPath) === path.resolve(dstPath)) {
    return { wrote: false, skipped: 'noop' };
  }

  if (fs.existsSync(dstPath)) {
    return { wrote: false, skipped: 'conflict', conflictPath: dstPath };
  }

  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  const contentToWrite = (newData && typeof newData === 'object') ? newData : srcData;
  fs.writeFileSync(dstPath, JSON.stringify(contentToWrite, null, 2) + '\n');
  fs.unlinkSync(srcPath);

  const sister = _updateSisterStoresOnRename(srcPath, dstPath);

  return {
    wrote: true,
    renamed: true,
    sisterStoreMoved: sister.llmScoreMoved,
    siblingPointersUpdated: sister.pointersUpdated,
  };
}

/**
 * Delete a review-text file under the lock contract.
 *
 * Refuses to delete when the file is `_locked: true` unless `force: true`.
 * Mirrors safeRenameReview's source-side gate. Used by topology operations
 * that delete a redundant file (cleanup-phantom-outlets merge-then-unlink,
 * any future unlink path on review-texts).
 *
 * @param {string} filePath - Absolute path to the file to delete
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Bypass `_locked`
 * @returns {{
 *   wrote: boolean,
 *   unlinked?: boolean,
 *   skipped?: 'source-missing'|'unreadable'|'locked',
 *   lockedSkipped?: boolean,
 *   error?: string,
 * }}
 */
function safeUnlinkReview(filePath, options = {}) {
  const { force = false } = options;

  if (!fs.existsSync(filePath)) {
    return { wrote: false, skipped: 'source-missing' };
  }

  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    if (!force) {
      return { wrote: false, skipped: 'unreadable', error: e.message };
    }
    // force=true on a corrupt file: allow unlink (file is already broken).
  }

  if (data && data._locked === true && !force) {
    console.warn(`[review-write-guard] Refusing unlink of locked file ${path.basename(filePath)}`);
    return { wrote: false, skipped: 'locked', lockedSkipped: true };
  }

  fs.unlinkSync(filePath);
  return { wrote: true, unlinked: true };
}

/**
 * Internal: rename the llm-scores sidecar and rewrite same-show
 * duplicateTextOf sibling pointers. Best-effort — logs and continues on
 * partial failures. Cross-show: pointers in the source show dir become
 * orphaned (left for validate-review-texts to catch).
 */
function _updateSisterStoresOnRename(srcPath, dstPath) {
  const srcDir = path.dirname(srcPath);
  const dstDir = path.dirname(dstPath);
  const srcFile = path.basename(srcPath);
  const dstFile = path.basename(dstPath);
  const srcShowId = path.basename(srcDir);
  const dstShowId = path.basename(dstDir);
  const repoRoot = path.resolve(__dirname, '..', '..');

  let llmScoreMoved = false;
  const oldLlmPath = path.join(repoRoot, 'data', 'llm-scores', srcShowId, srcFile);
  if (fs.existsSync(oldLlmPath)) {
    const newLlmPath = path.join(repoRoot, 'data', 'llm-scores', dstShowId, dstFile);
    try {
      fs.mkdirSync(path.dirname(newLlmPath), { recursive: true });
      if (!fs.existsSync(newLlmPath)) {
        fs.renameSync(oldLlmPath, newLlmPath);
        llmScoreMoved = true;
      } else {
        console.warn(`[review-write-guard] llm-scores sidecar conflict at ${path.relative(repoRoot, newLlmPath)} — keeping existing, removing ${path.relative(repoRoot, oldLlmPath)}`);
        fs.unlinkSync(oldLlmPath);
      }
    } catch (e) {
      console.warn(`[review-write-guard] llm-scores sidecar move failed: ${e.message}`);
    }
  }

  let pointersUpdated = 0;
  const dirsToScan = srcDir === dstDir ? [srcDir] : [srcDir, dstDir];
  for (const dir of dirsToScan) {
    if (!fs.existsSync(dir)) continue;
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch { continue; }
    for (const f of files) {
      if (f === dstFile && dir === dstDir) continue;
      const sibPath = path.join(dir, f);
      let sibData;
      try {
        sibData = JSON.parse(fs.readFileSync(sibPath, 'utf-8'));
      } catch { continue; }
      if (sibData && sibData.duplicateTextOf === srcFile) {
        sibData.duplicateTextOf = dstFile;
        try {
          fs.writeFileSync(sibPath, JSON.stringify(sibData, null, 2) + '\n');
          pointersUpdated++;
        } catch (e) {
          console.warn(`[review-write-guard] failed to rewrite duplicateTextOf in ${path.relative(repoRoot, sibPath)}: ${e.message}`);
        }
      }
    }
  }

  return { llmScoreMoved, pointersUpdated };
}

module.exports = { safeWriteReview, safeRenameReview, safeUnlinkReview, checkForDataLoss, getEffectiveProtectedFields, checkUrlCollision, coerceAssignedScore, shouldSkipPollerUpdate, shouldSkipLockedEnrichment, hasPlaceholderUrlPattern, PROTECTED_FIELDS };
