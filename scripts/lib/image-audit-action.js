/**
 * image-audit-action.js
 *
 * Pure decision function for audit-images-llm.js: given a Gemini verification
 * result (and optional cross-contamination group), decide what to DO with the
 * existing thumbnail.
 *
 * Extracted from the inline ladder in audit-images-llm.js so it can be tested
 * directly (CLAUDE.md §15 — never copy logic into a test; require the real
 * function). This ladder is destructive: 'delete' removes a live thumbnail from
 * the site, so an un-tested edit here is expensive.
 *
 * WHY THE PRODUCTION-STILL CARVE-OUT EXISTS (2026-08-02):
 * This auditor adopted the shared market-aware prompt from lib/verify-image.js,
 * which rejects production photos (match:false, imageType:"production_still") so
 * that fetch-show-images-auto.js can prefer poster art. This auditor, however,
 * turns match:false + high confidence into DELETE — so adopting that rule
 * unguarded would have started auto-deleting every legitimate production-still
 * thumbnail already on the site. Art-type upgrades are the fetcher's job.
 *
 * It resolves to 'needs_review', NOT 'keep': Gemini may have stopped at "this is
 * a production still" without ever evaluating whether the still is from the
 * right production, so silently keeping it would bury a real miss.
 */

/**
 * True when the ONLY thing wrong with the image is that it is a production
 * still rather than poster art.
 *
 * @param {object} verification result from lib/verify-image.js verifyImage()
 * @returns {boolean}
 */
function isProductionStillOnly(verification) {
  if (!verification || verification.match !== false) return false;
  if (verification.imageType !== 'production_still') return false;
  const issues = verification.issues || [];
  return issues.every(i => i === 'production_photo' || i === 'production_still');
}

/**
 * Decide the audit action for one image.
 *
 * @param {object} verification result from verifyImage()
 * @param {object|null} crossContamGroup { sharedWith: string[] } when this image's
 *   hash is shared with other shows, else null/undefined
 * @returns {{action: 'keep'|'delete'|'needs_review', reason: string, verification: object}}
 *   `verification` is returned (possibly with match normalised) so the caller
 *   persists the same object it acted on.
 */
function decideImageAuditAction(verification, crossContamGroup) {
  let action = 'keep';
  let reason = '';
  let v = verification;

  const productionStillOnly = isProductionStillOnly(v);
  if (productionStillOnly) {
    action = 'needs_review';
    reason = 'production_still (art-type, not a confirmed wrong image — not auto-deleted)';
    // match:null makes it inert for every later branch, all of which key off
    // match === false or === true. That is deliberate: a production still must
    // never reach a delete branch, including the cross-contamination one.
    v = { ...v, match: null };
  }

  if (!productionStillOnly && v.match === null) {
    action = 'needs_review';
    reason = 'api_error';
  } else if (v.match === false && v.confidence === 'high') {
    action = 'delete';
    reason = (v.issues || []).join(', ') || 'wrong_image';
  } else if (v.match === false && v.confidence === 'medium') {
    action = 'needs_review';
    reason = (v.issues || []).join(', ') || 'possibly_wrong';
  } else if (v.match === false) {
    action = 'needs_review';
    reason = 'low_confidence_mismatch';
  }

  if (crossContamGroup && v.match === false) {
    action = 'delete';
    reason = `cross_contaminated: shared with ${crossContamGroup.sharedWith.join(', ')}`;
  } else if (crossContamGroup && v.match === true) {
    // Image matches THIS show — it's the owner. The other shows in the group
    // will be flagged when they're processed.
    reason = `owner (shared hash with ${crossContamGroup.sharedWith.join(', ')})`;
  }

  return { action, reason, verification: v };
}

module.exports = { decideImageAuditAction, isProductionStillOnly };
