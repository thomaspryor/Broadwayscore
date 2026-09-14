/**
 * orphaned-duplicate-pointer-heal.js
 *
 * Retro-heals `duplicateOf` pointers whose TARGET was flagged invalid
 * (wrongShow/wrongProduction/nonReviewFlag/rejectedBy) by a downstream
 * classifier (classify-wrong-production.js, classify-wrong-show.js,
 * classify-non-reviews.js, ensemble-scoreability-check) AFTER the
 * duplicateOf pointer was set (BRO-3250).
 *
 * This is a DIFFERENT failure mode from the one
 * scripts/audit-duplicate-of-url-mismatch.js already heals: that audit
 * clears a pointer when the URLs no longer match (the collision basis is
 * gone) or the sibling was deleted. Here the URLs still match — the pointer
 * was CORRECT when it was set (a legitimate same-URL dedup merge) — but the
 * sibling it points at was later reclassified as invalid content, and
 * nothing ever re-evaluates the pointer. Net effect: both files silently
 * drop out of the rebuild — the target correctly, and this file for no
 * reason at all.
 *
 * Concrete case: data/review-texts/moulin-rouge-2019/wsj--terry-teachout.json
 * carries duplicateOf: "wsj--unknown.json" (set by a same-URL dedup merge,
 * _mergeReason: "same-show-url-dedup"). wsj--unknown.json was LATER flagged
 * nonReviewFlag:true / rejectedBy:"ensemble-scoreability-check" (its fullText
 * is browser-upgrade-prompt garbage). The real 754-word Terry Teachout review
 * vanished from reviews.json even though it was never itself invalid.
 *
 * Pure + data-free so it unit-tests against fixtures (CLAUDE rule 15). The
 * driver script (scripts/heal-orphaned-duplicate-pointers.js) supplies the
 * on-disk records and performs the writes.
 */

'use strict';

const SUBSTANTIVE_BODY_CHARS = 500;

/**
 * True when a review record was flagged invalid by one of the downstream
 * classifiers this heal exists to catch up with. A pointer aimed at a
 * record in this state has lost its collision basis just as surely as a
 * URL-mismatch or a deleted sibling — the difference is WHY the target
 * stopped being a legitimate canonical.
 *
 * @param {{wrongShow?: any, wrongProduction?: any, nonReviewFlag?: any, rejectedBy?: any}} target
 * @returns {boolean}
 */
function isTargetInvalidated(target) {
  if (!target) return false;
  return !!(
    target.wrongShow === true
    || target.wrongProduction === true
    || target.nonReviewFlag === true
    || target.rejectedBy
  );
}

/**
 * True when a record carries real content worth re-admitting to the rebuild
 * and is not itself flagged — mirrors the clean-source gate used elsewhere
 * (duplicate-direction-heal.js's isFlaggedRecord): promoting a flagged or
 * near-empty record back into scoring would just manufacture a fresh
 * problem instead of fixing this one.
 *
 * @param {{fullText?: string, wrongShow?: any, wrongProduction?: any, nonReviewFlag?: any, contentTier?: string}} data
 * @returns {boolean}
 */
function hasSubstantiveUnflaggedContent(data) {
  if (!data) return false;
  if (data.wrongShow === true || data.wrongProduction === true || data.nonReviewFlag === true) return false;
  if (data.contentTier === 'invalid') return false;
  const text = typeof data.fullText === 'string' ? data.fullText : '';
  return text.length > SUBSTANTIVE_BODY_CHARS;
}

/**
 * Core decision: should `loser` (the record currently holding duplicateOf,
 * pointing at `target`) have that pointer cleared, because the target has
 * since been invalidated?
 *
 * Deliberately narrow, same "err toward skipping" philosophy as
 * duplicate-direction-heal.js: a missed clear just leaves the pre-existing
 * (silently wrong) exclusion in place — the status quo — whereas a wrong
 * clear could re-admit a genuinely-suppressed low-quality review. Requires
 * ALL of:
 *   1. `target` is invalidated (isTargetInvalidated).
 *   2. `loser` itself carries substantive, unflagged content
 *      (hasSubstantiveUnflaggedContent) — a thin/flagged loser has no
 *      legitimate content to re-admit, so clearing it would accomplish
 *      nothing but noise.
 *
 * @param {object} loser
 * @param {object} target
 * @returns {boolean}
 */
function shouldClearOrphanedDuplicatePointer(loser, target) {
  if (!loser || !target) return false;
  if (!isTargetInvalidated(target)) return false;
  return hasSubstantiveUnflaggedContent(loser);
}

/**
 * Scans every record in one show directory for orphaned duplicateOf
 * pointers. Pure — `records` is the full set of `{file, data}` pairs for a
 * single show dir.
 *
 * @param {Array<{file: string, data: object}>} records
 * @returns {Array<{loserFile: string, targetFile: string, reason: string}>}
 */
function findOrphanedDuplicatePointers(records) {
  const byFile = new Map((records || []).map((r) => [r.file, r.data]));
  const out = [];
  for (const { file, data } of records || []) {
    if (!data || typeof data.duplicateOf !== 'string' || !data.duplicateOf.endsWith('.json')) continue;
    if (data.duplicateOf === file) continue; // self-ref — handled elsewhere
    const targetFile = data.duplicateOf;
    const targetData = byFile.get(targetFile);
    if (!targetData) continue; // sibling missing — audit-duplicate-of-url-mismatch.js's job
    if (!shouldClearOrphanedDuplicatePointer(data, targetData)) continue;
    out.push({
      loserFile: file,
      targetFile,
      reason: `orphaned-duplicate-heal: ${targetFile} was flagged invalid after ${file} was pointed at it`,
    });
  }
  return out;
}

module.exports = {
  SUBSTANTIVE_BODY_CHARS,
  isTargetInvalidated,
  hasSubstantiveUnflaggedContent,
  shouldClearOrphanedDuplicatePointer,
  findOrphanedDuplicatePointers,
};
