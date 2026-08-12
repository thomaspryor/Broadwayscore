/**
 * duplicate-direction-heal.js
 *
 * Retro-heals pre-existing WRONG-DIRECTION duplicateOf stamps (card #1338,
 * Death Note WhatsOnStage). The shipped dedup/byline precedence fix (#1321,
 * rebuild-all-reviews.js + byline-recovery.js) only changed how the REBUILD
 * picks a winner among same-URL siblings going forward — it does not touch
 * the on-disk duplicateOf stamps that a pre-fix write already wrote. A file
 * with a real criticName and an anchored-scorer band can be sitting with
 * duplicateOf pointing at an Unknown-byline, unanchored sibling that should
 * never have won: whatsonstage--alun-hood.json (criticName "Alun Hood",
 * llmScore.band present, score 85) was stamped duplicateOf
 * whatsonstage--unknown.json (criticName "Unknown", no band, score 91),
 * because at write time the write-guard's URL-collision detector marked
 * whichever file arrived SECOND as the duplicate, regardless of byline or
 * anchor quality. This module finds and reverses exactly that pattern.
 *
 * Pure + data-free so it unit-tests against fixtures (CLAUDE rule 15). The
 * driver script (scripts/heal-duplicate-of-direction.js) supplies the
 * on-disk records and performs the writes.
 *
 * SCOPE — this is deliberately NOT the mutual-2-cycle case
 * (fileA.duplicateOf=fileB AND fileB.duplicateOf=fileA), which
 * fix-circular-duplicate-pairs.js already repairs. It targets the
 * ONE-DIRECTIONAL case: file A points at file B via duplicateOf, but B does
 * NOT point back at A — a straightforward "which of these two same-URL
 * siblings should be canonical" mistake, not a cycle.
 */

'use strict';

const { isPlausiblePersonName } = require('./byline-recovery');

/**
 * True when llmScore.band is a real anchored-scorer stamp — the band is only
 * ever written by the anchored scorer (ANCHORED_BANDS_PILOT path), so its
 * presence proves this llmScore is a band-constrained verdict regardless of
 * scoreSource (rebuild-helpers.js uses the same marker for the same reason:
 * "llmScore.band = anchored proof", memory
 * feedback_anchored_v6_stamp_and_rescore_starvation.md).
 *
 * @param {{llmScore?: {band?: {floor?: number}}}} data
 * @returns {boolean}
 */
function hasAnchoredBand(data) {
  const band = data && data.llmScore && data.llmScore.band;
  return !!(band && typeof band.floor === 'number');
}

/**
 * True when a review record carries an exclusion flag that must never be
 * promoted to canonical — mirrors byline-recovery.js's gate 2 (clean-source):
 * canonicalizing a flagged record just manufactures a fresh problem.
 *
 * @param {{wrongProduction?: any, wrongShow?: any, isNonReview?: any, contentTier?: string}} data
 * @returns {boolean}
 */
function isFlaggedRecord(data) {
  if (!data) return true;
  if (data.wrongProduction || data.wrongShow || data.isNonReview) return true;
  if (data.contentTier === 'invalid') return true;
  return false;
}

/**
 * Core decision: should `loser` (the record currently holding duplicateOf,
 * pointing at `winner`) become canonical instead, because the direction is
 * backwards?
 *
 * Deliberately narrow — the same "err toward skipping" philosophy as
 * byline-recovery.js: a missed flip just leaves the pre-existing (possibly
 * wrong) direction in place, which is the status quo, whereas a wrong flip
 * could suppress a review that legitimately belongs where it is. Requires
 * ALL of:
 *   1. `loser` carries a real personal byline (isPlausiblePersonName) OR an
 *      anchored-scorer band (hasAnchoredBand) — a genuine quality signal the
 *      Unknown/unanchored `winner` lacks.
 *   2. `winner`'s byline is Unknown/blank AND `winner` has no anchored band —
 *      the winner must be provably the WEAKER record, not merely different.
 *   3. `loser` is not itself flagged (wrongProduction/wrongShow/isNonReview/
 *      contentTier==='invalid') — the clean-source gate.
 *
 * @param {{criticName?: string, wrongProduction?: any, wrongShow?: any, isNonReview?: any, contentTier?: string, llmScore?: object}} loser
 * @param {{criticName?: string, llmScore?: object}} winner
 * @returns {boolean}
 */
function shouldFlipDuplicateDirection(loser, winner) {
  if (!loser || !winner) return false;
  if (isFlaggedRecord(loser)) return false;
  const loserName = (loser.criticName || '').trim();
  const loserNamed = isPlausiblePersonName(loserName);
  const loserAnchored = hasAnchoredBand(loser);
  if (!loserNamed && !loserAnchored) return false;
  const winnerName = (winner.criticName || '').trim().toLowerCase();
  const winnerUnknown = !winnerName || winnerName === 'unknown';
  if (!winnerUnknown) return false;
  if (hasAnchoredBand(winner)) return false;
  return true;
}

/**
 * Scans every record in one show directory for one-directional (non-mutual)
 * duplicateOf stamps pointing the wrong way. Pure — `records` is the full set
 * of `{file, data}` pairs for a single show dir.
 *
 * @param {Array<{file: string, data: object}>} records
 * @returns {Array<{loserFile: string, winnerFile: string, reason: string}>}
 */
function findDirectionFlips(records) {
  const byFile = new Map((records || []).map((r) => [r.file, r.data]));
  const out = [];
  for (const { file, data } of records || []) {
    if (!data || typeof data.duplicateOf !== 'string' || !data.duplicateOf.endsWith('.json')) continue;
    if (data.duplicateOf === file) continue; // self-ref — handled elsewhere
    const winnerFile = data.duplicateOf;
    const winnerData = byFile.get(winnerFile);
    if (!winnerData) continue; // sibling missing — handled by other audits
    if (winnerData.duplicateOf === file) continue; // mutual pair — fix-circular-duplicate-pairs.js's job
    if (!shouldFlipDuplicateDirection(data, winnerData)) continue;
    out.push({
      loserFile: file,
      winnerFile,
      reason: `direction-heal: ${file} carries a named/anchored review while ${winnerFile} is Unknown/unanchored`,
    });
  }
  return out;
}

module.exports = {
  hasAnchoredBand,
  isFlaggedRecord,
  shouldFlipDuplicateDirection,
  findDirectionFlips,
};
