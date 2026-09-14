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
// The write-time collision verdict. Required here (not just relied on inside
// safeWriteReview) because that function's collision branch only ever SETS
// duplicateOf — when it declines, it logs "keeping primary" and leaves whatever
// value the caller already put on the object, so a caller that sets the pointer
// itself bypasses the decision entirely.
const { shouldMarkUrlCollisionDuplicate } = require('./review-write-guard.js');

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
const PRIOR_REASON_OPEN = '[prior duplicateReason: ';

/**
 * The exact duplicateClearReason this heal stamps. Single source of truth so
 * parseHealClearTarget() can never drift out of sync with what fix() writes.
 *
 * @param {string} day  YYYY-MM-DD
 * @param {string} targetFile
 * @param {string} reason
 * @returns {string}
 */
function buildHealClearReason(day, targetFile, reason, priorDuplicateReason) {
  const base = `${HEAL_CLEAR_BREADCRUMB_PREFIX}${day}: target ${targetFile} was flagged invalid after this pointer was set (${reason})`;
  // The duplicateReason being nulled alongside the pointer is provenance, not
  // noise: the corpus carries families like 'byline-explosion-collapse',
  // 'criticName-override-collided-at-rename' and the task #1072 outlet-mismatch
  // reasons. Without recording it, a later --revert-unjustified could only
  // guess, and would falsify how the duplicate was found. Appended as an
  // OPTIONAL suffix so the 127 breadcrumbs already on disk still parse.
  return priorDuplicateReason
    ? `${base} ${PRIOR_REASON_OPEN}${priorDuplicateReason}]`
    : base;
}

/**
 * Recover the duplicateReason fix() nulled, or null when the breadcrumb
 * predates the suffix (those restore under the generic collision reason).
 *
 * @param {*} reason
 * @returns {string|null}
 */
function parseHealClearPriorReason(reason) {
  if (typeof reason !== 'string') return null;
  const i = reason.lastIndexOf(PRIOR_REASON_OPEN);
  if (i === -1 || !reason.endsWith(']')) return null;
  const inner = reason.slice(i + PRIOR_REASON_OPEN.length, -1);
  return inner || null;
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
 * True when pointing `loserFile` at `targetFile` would close a duplicateOf
 * cycle — i.e. the target's own chain already (transitively) leads back to the
 * loser. Restoring into a cycle would drop EVERY member of the loop from the
 * rebuild, the 242-file failure review-write-guard.wouldFormDuplicateCycle
 * exists to prevent; safeWriteReview only checks the cycle against the first
 * URL-colliding sibling it finds, which is not necessarily our target, so the
 * check has to happen here too.
 *
 * @param {string} loserFile
 * @param {string} targetFile
 * @param {Map<string, object>} byFile
 * @returns {boolean}
 */
function wouldCloseDuplicateCycle(loserFile, targetFile, byFile) {
  const seen = new Set([loserFile]);
  let cursor = targetFile;
  while (cursor) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    const node = byFile.get(cursor);
    const next = node && typeof node.duplicateOf === 'string' ? node.duplicateOf : null;
    cursor = next;
  }
  return false;
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
    if (wouldCloseDuplicateCycle(file, targetFile, byFile)) continue; // never restore into a loop
    const ownUrl = typeof data.url === 'string' ? normalizeUrl(data.url) : null;
    const targetUrl = typeof targetData.url === 'string' ? normalizeUrl(targetData.url) : null;
    if (!ownUrl || !targetUrl || ownUrl !== targetUrl) continue;
    // Defer to the write-time decision the guard would make for this exact
    // pair, rather than re-suppressing on URL identity alone. This is what
    // honors _duplicateOfCleared (the human-verified "two critics, one URL"
    // breadcrumb, 163 corpus instances 2026-07-15) and refuses to tombstone a
    // substantive body under a near-empty sibling — neither of which
    // safeWriteReview can protect on this path, because its collision branch
    // only ever SETS duplicateOf and leaves a caller-supplied value standing.
    if (!shouldMarkUrlCollisionDuplicate(data, targetData)) continue;
    out.push({
      loserFile: file,
      targetFile,
      priorDuplicateReason: parseHealClearPriorReason(data.duplicateClearReason),
      reason: `unjustified-heal-clear: ${targetFile} is not actually invalidated (flag already retracted) and still shares this URL`,
    });
  }
  return out;
}

/**
 * A restored pointer turns its loser back into a NON-canonical record — and any
 * sibling that was pointing AT that loser is now one hop short of the real
 * canonical. rebuild-all-reviews.js does not follow that hop: its duplicateOf
 * block reads `refAlsoDupe = !!refData.duplicateOf` and treats a reference that
 * is itself a duplicate as a stale-flag RECOVERY signal, letting the sibling
 * straight into reviews.json (see the loves-labours-lost-globe-west-end-2026
 * comment there). On romeo-juliet-2024 that would have swapped one duplicate
 * Vulture byline for another — helen-shaw out, jackson-mchenry in — and left
 * validate-data.js just as red.
 *
 * So a restore has to flatten the one-hop chains that run through it: every
 * sibling pointing at `throughFile` is re-pointed at the terminus of
 * `throughFile`'s own chain, provided it still shares that terminus's URL and
 * the hop closes no cycle. Deliberately scoped to chains through a file this
 * pass just restored — corpus-wide chain flattening is a separate question.
 *
 * @param {Array<{file: string, data: object}>} records  all records in one show dir
 * @param {string} throughFile  the file whose pointer was just restored
 * @returns {Array<{loserFile: string, targetFile: string, reason: string}>}
 */
function findChainPointersThrough(records, throughFile) {
  const byFile = new Map((records || []).map((r) => [r.file, r.data]));
  // Walk throughFile's chain to its terminus (the record that points nowhere).
  const seen = new Set();
  let terminus = throughFile;
  while (terminus && !seen.has(terminus)) {
    seen.add(terminus);
    const node = byFile.get(terminus);
    const next = node && typeof node.duplicateOf === 'string' ? node.duplicateOf : null;
    if (!next) break;
    terminus = next;
  }
  if (!terminus || terminus === throughFile) return []; // no chain to flatten
  const terminusData = byFile.get(terminus);
  if (!terminusData) return [];
  const terminusUrl = typeof terminusData.url === 'string' ? normalizeUrl(terminusData.url) : null;
  if (!terminusUrl) return [];

  const out = [];
  for (const { file, data } of records || []) {
    if (!data || file === terminus) continue;
    if (data.duplicateOf !== throughFile) continue;
    const ownUrl = typeof data.url === 'string' ? normalizeUrl(data.url) : null;
    if (!ownUrl || ownUrl !== terminusUrl) continue;
    if (wouldCloseDuplicateCycle(file, terminus, byFile)) continue;
    out.push({
      loserFile: file,
      targetFile: terminus,
      reason: `chain-flatten: ${throughFile} is a duplicate again, so this pointer is re-aimed at the canonical ${terminus}`,
    });
  }
  return out;
}

// ── duplicateTextOf extension (BRO-3336, the duplicateOf cousin above) ─────
//
// Same failure mode as findOrphanedDuplicatePointers, for `duplicateTextOf`
// (the content-fingerprint syndicated-identical-text dedup pointer) instead
// of `duplicateOf`. classify-wrong-production.js / classify-wrong-show.js /
// classify-non-reviews.js / ensemble-scoreability-check never look for
// siblings pointing duplicateTextOf at the file they're flagging, so a real
// syndicated review can be silently orphaned behind a target that was
// invalidated after the pointer was set. Reuses isTargetInvalidated /
// hasSubstantiveUnflaggedContent / shouldClearOrphanedDuplicatePointer
// unchanged — including BRO-3092's retraction-aware isTargetInvalidated —
// the decision doesn't care which pointer field it's evaluating.

/**
 * @param {Array<{file: string, data: object}>} records
 * @returns {Array<{loserFile: string, targetFile: string, reason: string}>}
 */
function findOrphanedDuplicateTextPointers(records) {
  const byFile = new Map((records || []).map((r) => [r.file, r.data]));
  const out = [];
  for (const { file, data } of records || []) {
    if (!data || typeof data.duplicateTextOf !== 'string' || !data.duplicateTextOf.endsWith('.json')) continue;
    if (data.duplicateTextOf === file) continue; // self-ref — handled by review-write-guard's self-heal
    const targetFile = data.duplicateTextOf;
    const targetData = byFile.get(targetFile);
    if (!targetData) continue; // sibling missing — audit-duplicate-of-url-mismatch.js's job
    if (!shouldClearOrphanedDuplicatePointer(data, targetData)) continue;
    out.push({
      loserFile: file,
      targetFile,
      reason: `orphaned-duplicate-heal: ${targetFile} was flagged invalid after ${file} was pointed at it (duplicateTextOf)`,
    });
  }
  return out;
}

// Deliberately NOT the shared HEAL_CLEAR_BREADCRUMB_PREFIX/buildHealClearReason
// above: those are parsed by parseHealClearTarget() for --revert-unjustified,
// which assumes any breadcrumb it recognizes cleared `duplicateOf` (it
// restores by setting `data.duplicateOf = targetFile`). A file this function
// clears often has duplicateOf already null for unrelated reasons — if its
// breadcrumb matched that parser, findUnjustifiedHealClears() could
// misinterpret it as an unjustified duplicateOf clear and wrongly stamp a
// duplicateOf pointer the file never had. A distinct, non-matching prefix
// keeps the two mechanisms from cross-talking.
const DUPLICATE_TEXT_CLEAR_BREADCRUMB_PREFIX = 'heal-orphaned-duplicate-pointers.js (duplicateTextOf) on ';

/**
 * The exact duplicateClearReason fix() stamps when clearing duplicateTextOf.
 * @param {string} day  YYYY-MM-DD
 * @param {string} targetFile
 * @param {string} reason
 * @returns {string}
 */
function buildDuplicateTextClearReason(day, targetFile, reason) {
  return `${DUPLICATE_TEXT_CLEAR_BREADCRUMB_PREFIX}${day}: target ${targetFile} was flagged invalid after this pointer was set (${reason})`;
}

/**
 * Decides which orphans the driver's --fix may actually write, honoring the
 * surge guard PER FIELD rather than on the combined total (BRO-3336): a
 * combined check would make the threshold trip purely as a function of how
 * many fields --field selects, so a duplicateTextOf spike could block
 * healing an unrelated, perfectly-normal duplicateOf backlog. force=true
 * (--force-bulk) bypasses the guard entirely, same as before.
 *
 * Pure — no fs, no console — so the per-field-vs-combined decision is
 * unit-testable without a real corpus.
 *
 * @param {Array<{field: string}>} orphans
 * @param {number} threshold
 * @param {boolean} force
 * @returns {{fixable: Array, surgingFields: Array<{field: string, count: number}>}}
 */
function partitionOrphansForFix(orphans, threshold, force) {
  const list = orphans || [];
  if (force) return { fixable: list, surgingFields: [] };
  const byField = new Map();
  for (const o of list) byField.set(o.field, (byField.get(o.field) || []).concat(o));
  const surgingFields = [...byField.entries()]
    .filter(([, entries]) => entries.length > threshold)
    .map(([field, entries]) => ({ field, count: entries.length }));
  const surgingSet = new Set(surgingFields.map((s) => s.field));
  const fixable = list.filter((o) => !surgingSet.has(o.field));
  return { fixable, surgingFields };
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
  parseHealClearPriorReason,
  wouldCloseDuplicateCycle,
  findUnjustifiedHealClears,
  findChainPointersThrough,
  findOrphanedDuplicateTextPointers,
  DUPLICATE_TEXT_CLEAR_BREADCRUMB_PREFIX,
  buildDuplicateTextClearReason,
  partitionOrphansForFix,
};
