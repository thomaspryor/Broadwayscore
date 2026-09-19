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
 * Also defers to review-guards.js's isRejectedNonReview (BRO-3821): a record
 * the ensemble-scoreability-check already rejected as garbage_text/not_a_review
 * (or a high-confidence contentVerification.wrongArticle verdict) is just as
 * unpromotable as an explicit wrongProduction/wrongShow flag, even when
 * contentTier isn't 'invalid' — e.g. the-lion-king-west-end-2021
 * guardian--lyngardner.json carries contentTier:'truncated' +
 * rejectionReason:'garbage_text' (OCR-garbled text about an unrelated show)
 * and would otherwise slip past this gate. Reusing the canonical predicate
 * instead of re-deriving the rejection logic here keeps this gate and the
 * rebuild's own exclusion in lock-step (memory
 * feedback_includability_predicates_must_be_canonical.md).
 *
 * @param {{wrongProduction?: any, wrongShow?: any, isNonReview?: any, contentTier?: string, rejectionReason?: string, contentVerification?: object}} data
 * @returns {boolean}
 */
function isFlaggedRecord(data) {
  if (!data) return true;
  if (data.wrongProduction || data.wrongShow || data.isNonReview) return true;
  if (data.contentTier === 'invalid') return true;
  if (require('./review-guards').isRejectedNonReview(data)) return true;
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
 *   2. `winner`'s byline is Unknown/blank — the winner must be provably the
 *      WEAKER record on attribution, not merely different.
 *   3. `loser` is not itself flagged (wrongProduction/wrongShow/isNonReview/
 *      contentTier==='invalid'/ensemble-rejected non-review) — the
 *      clean-source gate.
 *   3b. `loser`'s fullText clears MIN_LOSER_BODY_CHARS — a loser with no real
 *      body contributes nothing but a byline, and canonicalizing it silently
 *      discards whatever content `winner` actually held. Found live while
 *      verifying BRO-3821 against the real corpus: a-little-night-music-2009
 *      (backstage--luke-crowe.json, rejectionReason 'wrong_show', 0 chars),
 *      matilda-the-musical-2013 (bloomberg--jeremy-gerard.json, 'not_a_review',
 *      0 chars), and moulin-rouge-the-musical-west-end-2021 (nytg--gillian-russo.json,
 *      0 chars, no score at all) were all about to be promoted over winners
 *      that — Unknown byline or not — held the only real text/score. None of
 *      the three touch the hasAnchoredBand(winner) branch below (their
 *      winners aren't anchored) — this gate existed as a gap independent of
 *      the anchored-band veto, just never triggered until the corpus sweep.
 *   4. If `winner` DOES carry an anchored band, the flip still proceeds when
 *      `loser` has a real byline AND `winner`'s fullText is not shorter than
 *      `loser`'s — an anchored band only vouches for the SCORE (it's pinned
 *      to an explicit star rating found in the text), not for the BODY, and
 *      an Unknown-byline scrape routinely drags in page chrome (subscription
 *      banners, related-article rails, newsletter footers) that a properly
 *      attributed sibling's scrape never picked up, inflating both length
 *      and the anchored score along with it (BRO-3821: 16 corpus pairs,
 *      winner fullText length >= loser's in every one — man-to-man-west-end-2026
 *      artsdesk--unknown.json literally opens with "Help keep arts journalism
 *      alive... SUBSCRIBE TODAY" ahead of the review text its named sibling
 *      artsdesk--aleks-sierz.json lacks). The veto still fires when `winner`'s
 *      body IS shorter than `loser`'s — that's the genuine "short anchored
 *      stub shouldn't lose to a padded/longer body" case, and it still fires
 *      when `loser` lacks a real byline (anchored-only or mutual-Unknown
 *      case — url-collision-canonical.test.mjs's
 *      "mutual anchored-but-Unknown siblings" pair keeps deferring to the
 *      collider, unchanged).
 *
 * @param {{criticName?: string, wrongProduction?: any, wrongShow?: any, isNonReview?: any, contentTier?: string, llmScore?: object, fullText?: string}} loser
 * @param {{criticName?: string, llmScore?: object, fullText?: string}} winner
 * @returns {boolean}
 */
// Same threshold review-write-guard.js's SUBSTANTIVE_BODY_CHARS uses — a body
// this short holds nothing unique, so it can never justify becoming canonical.
const MIN_LOSER_BODY_CHARS = 500;

function shouldFlipDuplicateDirection(loser, winner) {
  if (!loser || !winner) return false;
  if (isFlaggedRecord(loser)) return false;
  const loserLen = String(loser.fullText || '').trim().length;
  if (loserLen < MIN_LOSER_BODY_CHARS) return false;
  const loserName = (loser.criticName || '').trim();
  const loserNamed = isPlausiblePersonName(loserName);
  const loserAnchored = hasAnchoredBand(loser);
  if (!loserNamed && !loserAnchored) return false;
  const winnerName = (winner.criticName || '').trim().toLowerCase();
  const winnerUnknown = !winnerName || winnerName === 'unknown';
  if (!winnerUnknown) return false;
  if (hasAnchoredBand(winner)) {
    if (!loserNamed) return false;
    const winnerLen = String(winner.fullText || '').trim().length;
    if (winnerLen < loserLen) return false;
  }
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
