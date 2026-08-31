/**
 * cross-outlet-triage.js — the single exclusion predicate for
 * audit-cross-outlet-attributions.js.
 *
 * The audit runs two independent scans (the playbill-bleed scan and the
 * default-critic-of scan). Each used to inline its own list of "already
 * triaged, do not report" checks, and they DIVERGED: the bleed scan skipped
 * files flagged wrongProduction/wrongShow, the default-critic-of scan did not.
 *
 * A file flagged wrongShow is already excluded from scoring by review-guards,
 * so re-reporting it as an untriaged cross-outlet suspect is noise that no
 * amount of cross-outlet triage can clear — the file is not a cross-outlet
 * problem at all. That divergence held the CI acceptance test
 * ('no unreviewed cross-outlet attribution suspects remain') red on exactly
 * one file: the-other-place-2026/minneapolis-star-tribune--mark-kennedy.json,
 * a January 2013 review already flagged wrongShow.
 *
 * Both scans now call this. Changing an exclusion changes both by
 * construction, which is the point.
 */

/**
 * True when a review-text record has already been triaged out and must not be
 * reported as an unreviewed cross-outlet suspect.
 *
 * @param {object} d parsed review-text JSON
 * @returns {boolean}
 */
function isTriagedOut(d) {
  if (!d || typeof d !== 'object') return false;
  // A human/agent checked the page byline and confirmed the pairing is legit.
  if (d.crossOutletVerified === true) return true;
  // Already recorded as a bad attribution; reporting it again is noise.
  if (d.wrongAttribution === true) return true;
  // Already excluded from scoring for being the wrong production/show. Whatever
  // outlet it is credited to, it is not a cross-outlet attribution question.
  //
  // wrongProduction is auto-clearable (rebuild-all-reviews.js dateless-revival
  // release). That is fine: the predicate is evaluated per scan, so a cleared
  // file re-surfaces as a suspect on the next run rather than being lost.
  if (d.wrongProduction === true || d.wrongShow === true) return true;
  // Same class: scoring's isScoreable() groups duplicateOf with the wrong-show
  // flags (scripts/test-scoring-rejection-logs.js:19), and explainExclusion
  // returns 'duplicateOf' for it. A duplicate is hard-excluded from scoring and
  // no amount of cross-outlet triage can clear it, so reporting it as an
  // unreviewed suspect is the same unfixable-CI-red trap this module exists to
  // close. Today all such files clear the byline check, so this changes no
  // count -- it stops one byline-check miss from turning into a red main.
  if (d.duplicateOf) return true;
  return false;
}

module.exports = { isTriagedOut };
