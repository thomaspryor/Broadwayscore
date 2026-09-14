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

const { isEffectivelyWrongProductionOrShow } = require('./content-quality.js');
// The project's canonical URL-comparison primitive — the SAME one
// review-write-guard.checkUrlCollision uses to decide that two siblings share a
// URL. Using anything narrower here (e.g. the fragment-only normalization
// validate-data.js's duplicate gate applies) would miss a collision basis that
// differs only by protocol/www/tracking params, which is exactly the
// operation-mincemeat-2025 Time Out pair.
const { normalizeUrl } = require('./review-normalization.js');

const SUBSTANTIVE_BODY_CHARS = 500;

/**
 * True when a review record was flagged invalid by one of the downstream
 * classifiers this heal exists to catch up with. A pointer aimed at a
 * record in this state has lost its collision basis just as surely as a
 * URL-mismatch or a deleted sibling — the difference is WHY the target
 * stopped being a legitimate canonical.
 *
 * `wrongProduction` / `wrongShow` are read through content-quality.js's
 * canonical isEffectivelyWrongProductionOrShow() gate, NOT as raw booleans
 * (BRO-3092). A raw `wrongProduction === true` is routinely a false positive
 * an operator or an auto-clear pass has already retracted via
 * wrongProductionManualClear / wrongProductionAutoCleared / allowEarlyDate /
 * humanReviewedWrongProduction:false — those records stay INCLUDED by
 * classifyContentTier, so treating one as "invalidated" here clears a pointer
 * whose collision basis is intact and re-admits a second copy of the same URL.
 * That is exactly what happened on 2026-09-14: 6 of 127 clears aimed at
 * manually-cleared targets, and romeo-juliet-2024 Vulture went red in
 * validate-data.js as a same-show+outlet duplicate URL.
 *
 * @param {object} target
 * @returns {boolean}
 */
function isTargetInvalidated(target) {
  if (!target) return false;
  // Strict === true first (unchanged): a non-boolean truthy flag has never
  // counted here, and this fix must only ever NARROW what gets cleared.
  const { effectivelyWrongProduction, effectivelyWrongShow } = isEffectivelyWrongProductionOrShow(target);
  return !!(
    (target.wrongShow === true && effectivelyWrongShow)
    || (target.wrongProduction === true && effectivelyWrongProduction)
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
  // Deliberately NOT softened by the retraction breadcrumbs isTargetInvalidated
  // now reads (BRO-3092): this is the conservative clean-source gate on the
  // record being re-admitted, not an inclusion verdict, and loosening it would
  // WIDEN what the heal clears — the opposite of what BRO-3092 needs.
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

// ── Retraction of this heal's OWN past clears (BRO-3092) ───────────────────
//
// The 2026-09-14 --force-bulk run wrote 127 clears under the pre-BRO-3092
// predicate, 6 of them against targets that were never actually invalid (a
// wrongProduction flag an operator had already retracted). Those 6 re-admitted
// a second copy of an already-canonical URL. A code fix alone leaves them on
// disk forever — nothing re-evaluates a duplicateClearReason — so the heal owns
// undoing the clears it is responsible for, the same way
// duplicate-of-cleared-contradiction.js retracts a _duplicateOfCleared its own
// evidence has since disproved.

const HEAL_CLEAR_BREADCRUMB_PREFIX = 'heal-orphaned-duplicate-pointers.js on ';

/**
 * The exact duplicateClearReason this heal stamps. Single source of truth so
 * parseHealClearTarget() can never drift out of sync with what fix() writes.
 *
 * @param {string} day  YYYY-MM-DD
 * @param {string} targetFile
 * @param {string} reason
 * @returns {string}
 */
function buildHealClearReason(day, targetFile, reason) {
  return `${HEAL_CLEAR_BREADCRUMB_PREFIX}${day}: target ${targetFile} was flagged invalid after this pointer was set (${reason})`;
}

/**
 * Extract the target filename out of a duplicateClearReason this heal wrote.
 * Returns null for any breadcrumb written by a different clearer — this
 * retraction must never touch someone else's intentional clear.
 *
 * @param {*} reason
 * @returns {string|null}
 */
function parseHealClearTarget(reason) {
  if (typeof reason !== 'string' || !reason.startsWith(HEAL_CLEAR_BREADCRUMB_PREFIX)) return null;
  const m = reason.match(/: target (\S+\.json) was flagged invalid after this pointer was set/);
  return m ? m[1] : null;
}

/**
 * Find clears this heal made that the corrected predicate no longer justifies:
 * the file still carries the heal's breadcrumb, has no live duplicateOf, and
 * the target it names is present, URL-identical, and NOT actually invalidated.
 * Those are the pointers that should never have been cleared.
 *
 * URL identity is required (under the canonical collision normalization) so a
 * retraction can only ever restore a pointer whose collision basis is
 * verifiably still there.
 *
 * @param {Array<{file: string, data: object}>} records  all records in one show dir
 * @returns {Array<{loserFile: string, targetFile: string, reason: string}>}
 */
function findUnjustifiedHealClears(records) {
  const byFile = new Map((records || []).map((r) => [r.file, r.data]));
  const out = [];
  for (const { file, data } of records || []) {
    if (!data) continue;
    if (data.duplicateOf) continue; // pointer already live again — nothing to restore
    const targetFile = parseHealClearTarget(data.duplicateClearReason);
    if (!targetFile || targetFile === file) continue;
    const targetData = byFile.get(targetFile);
    if (!targetData) continue; // target gone — the clear stands
    if (isTargetInvalidated(targetData)) continue; // clear was justified
    const ownUrl = typeof data.url === 'string' ? normalizeUrl(data.url) : null;
    const targetUrl = typeof targetData.url === 'string' ? normalizeUrl(targetData.url) : null;
    if (!ownUrl || !targetUrl || ownUrl !== targetUrl) continue;
    out.push({
      loserFile: file,
      targetFile,
      reason: `unjustified-heal-clear: ${targetFile} is not actually invalidated (flag already retracted) and still shares this URL`,
    });
  }
  return out;
}

module.exports = {
  SUBSTANTIVE_BODY_CHARS,
  HEAL_CLEAR_BREADCRUMB_PREFIX,
  isTargetInvalidated,
  hasSubstantiveUnflaggedContent,
  shouldClearOrphanedDuplicatePointer,
  findOrphanedDuplicatePointers,
  buildHealClearReason,
  parseHealClearTarget,
  findUnjustifiedHealClears,
};
